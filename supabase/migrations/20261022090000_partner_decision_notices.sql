-- Решения команды по витрине — партнёру в Telegram, а не только когда он сам откроет кабинет.
--
-- Владельцам кабинета с чатом бота (app.enqueue_vendor_owner_notice, язык — их профиль), в payload
-- только id; текст собирает API при отправке (apps/api/src/notify/render.ts):
--
--   · vendor.listing_decided — витрину опубликовали (с проверки или после паузы), отклонили,
--     вернули с проверки на доработку или приостановили. Ставит история статусов
--     (app.listing_status_log), только за сотрудника: шаги партнёра (отправить, отозвать) и
--     менеджера «на проверку» — не решения. Причина и статус — из строки истории (log_id).
--   · vendor.revision_decided — решение по предложению изменений, которое прислал партнёр:
--     одобрено или отклонено с причиной. Предложение сотрудника — не партнёра, о нём не пишем.
--   · vendor.photos_decided — решения по фото, загруженным партнёром, одним сообщением: пока у
--     владельца есть неотправленное о той же витрине, второе не ставится; первое уходит не раньше
--     чем через 2 минуты, и текст («одобрено N, отклонено M») считает решения с since — момента
--     первого. Одобрение — только у витрины на сайте (публикацию одобряет её же решение — о нём
--     vendor.listing_decided), отказ — у любой, кроме отклонённой.
--
-- Новых таблиц и столбцов нет: виды уведомлений — текст (app.outbox.kind), список — в render.ts.

-- ════════════════════════════════════════════════════════════════════════════
-- Витрина: решение по статусу
-- ════════════════════════════════════════════════════════════════════════════

create function app.listing_status_log_partner_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  if new.actor_kind is distinct from 'staff' or new.from_status is null then
    return null;
  end if;
  if not (new.to_status in ('active', 'rejected', 'suspended')
          or (new.to_status = 'draft' and new.from_status = 'review')) then
    return null;
  end if;
  select l.vendor_id into v_vendor from app.listings l where l.id = new.listing_id;
  if v_vendor is null then
    return null;
  end if;
  perform app.enqueue_vendor_owner_notice(v_vendor, 'vendor.listing_decided',
    jsonb_build_object('listing_id', new.listing_id, 'log_id', new.id::text), new.id::text);
  return null;
end $$;
create trigger listing_status_log_partner_notify after insert on app.listing_status_log
  for each row execute function app.listing_status_log_partner_notify();
revoke execute on function app.listing_status_log_partner_notify() from public;

-- ════════════════════════════════════════════════════════════════════════════
-- Предложение изменений партнёра: решение
-- ════════════════════════════════════════════════════════════════════════════

create function app.listing_revisions_partner_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  if old.status is distinct from 'pending' or new.status not in ('approved', 'declined')
     or app.effective_actor() is distinct from 'staff' then
    return null;
  end if;
  -- прислал партнёр (пользователь кабинета), а не сотрудник
  if new.submitted_by is null
     or not exists (select 1 from app.vendor_users u where u.id = new.submitted_by) then
    return null;
  end if;
  select l.vendor_id into v_vendor from app.listings l where l.id = new.listing_id;
  if v_vendor is null then
    return null;
  end if;
  perform app.enqueue_vendor_owner_notice(v_vendor, 'vendor.revision_decided',
    jsonb_build_object('revision_id', new.id, 'decision', new.status), new.id::text);
  return null;
end $$;
create trigger listing_revisions_partner_notify after update of status on app.listing_revisions
  for each row execute function app.listing_revisions_partner_notify();
revoke execute on function app.listing_revisions_partner_notify() from public;

-- ════════════════════════════════════════════════════════════════════════════
-- Фото партнёра: решения пачкой
-- ════════════════════════════════════════════════════════════════════════════

-- Одно неотправленное сообщение о фото витрины на владельца: пока оно ждёт (pending, failed),
-- новые решения войдут в него при отправке. Блокировка по витрине — два решения одновременно
-- не поставят два сообщения
create function app.enqueue_vendor_photos_notice(p_listing uuid, p_vendor uuid, p_since timestamptz)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform pg_advisory_xact_lock(hashtextextended('vendor.photos_decided:' || p_listing::text, 0));
  insert into app.outbox (kind, recipient_kind, recipient_id, payload, dedupe_key, next_attempt_at)
  select 'vendor.photos_decided', 'vendor_user', u.id,
         jsonb_build_object('listing_id', p_listing, 'since', p_since),
         'vendor.photos_decided:' || p_listing::text || ':' || u.id::text || ':'
           || (extract(epoch from clock_timestamp()) * 1000000)::bigint::text,
         now() + interval '2 minutes'
  from app.vendor_users u
  join pii.vendor_user_profiles p on p.vendor_user_id = u.id
  where u.vendor_id = p_vendor and u.role = 'owner' and u.disabled_at is null and u.tg_linked_at is not null
    and p.telegram_chat_id is not null
    and not exists (select 1 from app.outbox o
                    where o.kind = 'vendor.photos_decided' and o.recipient_kind = 'vendor_user'
                      and o.recipient_id = u.id and o.status in ('pending', 'failed')
                      and o.payload ->> 'listing_id' = p_listing::text)
  on conflict (dedupe_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function app.enqueue_vendor_photos_notice(uuid, uuid, timestamptz) from public;

create function app.photos_partner_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing app.listings;
begin
  if old.moderation is distinct from 'pending' or new.moderation not in ('approved', 'declined')
     or app.effective_actor() is distinct from 'staff'
     or new.deleted_at is not null or new.status is distinct from 'ready' then
    return null;
  end if;
  -- загрузил партнёр: о фото, которые добавил сотрудник, партнёру сообщать не о чем
  if new.uploaded_by is null
     or not exists (select 1 from app.vendor_users u where u.id = new.uploaded_by) then
    return null;
  end if;
  select l.* into v_listing from app.listings l where l.id = new.listing_id;
  if not found or v_listing.status = 'rejected'
     or (new.moderation = 'approved' and v_listing.status <> 'active') then
    return null;
  end if;
  perform app.enqueue_vendor_photos_notice(new.listing_id, v_listing.vendor_id,
                                           coalesce(new.moderated_at, now()));
  return null;
end $$;
create trigger photos_partner_notify after update of moderation on app.photos
  for each row execute function app.photos_partner_notify();
revoke execute on function app.photos_partner_notify() from public;
