-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — то, что партнёр отправил на проверку, доходит до команды.
--
--   · новые услуги, предложения правок услуг и фото от того, кто сам не решает (партнёр,
--     менеджер), — команде у любой витрины, кроме отклонённой. Раньше оповещение ставилось
--     только у опубликованной, а до запуска почти все витрины — черновики: партнёр видел
--     «отправлено на проверку», а до команды не доходило ничего. Очереди панели
--     (staff/services.ts, staff/listings.ts) — с тем же условием;
--   · решение по услуге — владельцам кабинета: одобрение — у опубликованной витрины
--     (публикация одобряет услуги на проверке пачкой — сообщение на каждую не нужно), отказ —
--     у любой: причину партнёру надо прочесть, чтобы исправить;
--   · партнёр отправляет витрину на проверку сам (POST /vendor/listings/:id/submit:
--     draft → review, отклонённую — через черновик; переходы база уже разрешала). Переход в
--     review от того, кто сам не решает, — оповещение ops.listing_submitted тем, кто
--     публикует (администратор, модератор);
--   · оповещения о витрине (услуги, фото, отправка на проверку) — app.enqueue_listing_alert.
--     Раньше ключ был «витрина + час по Ташкенту» и уникален навсегда, а первое оповещение
--     уходило сразу (outboxKick): всё остальное за тот час молча терялось. Теперь новое не
--     ставится, только пока у получателя есть неотправленное (pending, failed) о той же
--     витрине — его текст («ждут решения: N») собирается при отправке; отправленное новому
--     не мешает;
--   · оповещение, которое некому отправить (ни у кого из решающих нет чата с ботом), —
--     строка журнала outbox.no_recipients: вид оповещения и витрина, не чаще раза в час на
--     витрину и вид. Сотруднику без чата панель показывает баннер (GET /staff/me botLinked);
--   · app.metrics_ops_now: services_pending — услуги и предложения ждут решения (как очередь
--     услуг); photos_pending — фото любой витрины, кроме отклонённой (как очередь «Новые фото»).
--
-- Откат: supabase/rollbacks/20261011090000_moderation_flow.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── оповещение некому отправить ─────────────────────────────────────────────
-- Ни у одного действующего сотрудника этих ролей нет чата с ботом: не молчать, а оставить
-- след в журнале (вид оповещения и витрина, без ПДн). Не чаще раза в час на витрину и вид
create function app.log_alert_without_recipients(p_kind text, p_roles app.staff_role[], p_listing uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from app.staff s
             join pii.staff_profiles p on p.staff_id = s.id
             where s.active and s.role = any (p_roles) and p.telegram_chat_id is not null) then
    return;
  end if;
  if exists (select 1 from app.audit_log a
             where a.object_type = 'listing' and a.object_id = p_listing::text
               and a.action = 'outbox.no_recipients' and a.detail ->> 'kind' = p_kind
               and a.at > now() - interval '1 hour') then
    return;
  end if;
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('outbox.no_recipients', 'listing', p_listing::text, jsonb_build_object('kind', p_kind), 'system');
end $$;

-- ── оповещение о витрине ────────────────────────────────────────────────────
-- Сотрудникам ролей с чатом бота; payload — только id витрины. Получателю, у которого такое
-- же оповещение о витрине ещё ждёт отправки (pending, failed), второе не ставится: текст
-- собирается при отправке и скажет обо всём сразу. Отправленное (и взятое на отправку —
-- sending: его текст, может быть, уже собран) новому не мешает: ключ — момент постановки.
-- Ждущие строки — под блокировку: отправитель (FOR UPDATE SKIP LOCKED) возьмёт их после
-- этой транзакции и увидит новое; уже взял — ждём его, и строка для нас уже не ждущая
create function app.enqueue_listing_alert(p_kind text, p_roles app.staff_role[], p_listing uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform 1 from app.outbox o
  where o.kind = p_kind and o.recipient_kind = 'staff' and o.status in ('pending', 'failed')
    and o.payload ->> 'listing_id' = p_listing::text
  for update;

  insert into app.outbox (kind, recipient_kind, recipient_id, payload, dedupe_key)
  select p_kind, 'staff', s.id, jsonb_build_object('listing_id', p_listing),
         p_kind || ':' || p_listing::text || ':' || s.id::text || ':'
           || (extract(epoch from clock_timestamp()) * 1000000)::bigint::text
  from app.staff s
  join pii.staff_profiles p on p.staff_id = s.id
  where s.active and s.role = any (p_roles) and p.telegram_chat_id is not null
    and not exists (select 1 from app.outbox o
                    where o.kind = p_kind and o.recipient_kind = 'staff' and o.recipient_id = s.id
                      and o.status in ('pending', 'failed')
                      and o.payload ->> 'listing_id' = p_listing::text)
  on conflict (dedupe_key) do nothing;
  get diagnostics v_count = row_count;
  perform app.log_alert_without_recipients(p_kind, p_roles, p_listing);
  return v_count;
end $$;

-- ── услуги ──────────────────────────────────────────────────────────────────
-- Как в 20261001120100_categories_services.sql, но команде — у любой витрины, кроме
-- отклонённой, и без потерь (app.enqueue_listing_alert). Решение — владельцам кабинета:
-- одобрение — у опубликованной витрины (одобрение при публикации карточки идёт, пока она
-- ещё на проверке, — сообщения на каждую услугу не будет), отказ — у любой
create or replace function app.listing_services_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing app.listings;
begin
  select l.* into v_listing from app.listings l where l.id = new.listing_id;
  if not found or v_listing.status = 'rejected' then
    return null;
  end if;
  if app.actor_proposes()
     and ((new.status = 'review' and (tg_op = 'INSERT' or old.status is distinct from 'review'))
          or (new.proposal is not null and (tg_op = 'INSERT' or new.proposal_at is distinct from old.proposal_at))) then
    perform app.enqueue_listing_alert('ops.service_submitted', array['admin', 'moderator']::app.staff_role[],
                                      new.listing_id);
  end if;
  if tg_op = 'UPDATE' and new.decided_at is not null and new.decided_at is distinct from old.decided_at
     and app.effective_actor() in ('staff', 'system')
     and (v_listing.status = 'active' or new.decision = 'declined') then
    perform app.enqueue_vendor_owner_notice(v_listing.vendor_id, 'vendor.service_decided',
      jsonb_build_object('service_id', new.id, 'decision', new.decision),
      new.id::text || ':' || extract(epoch from new.decided_at)::bigint::text);
  end if;
  return null;
end $$;

-- ── фото ────────────────────────────────────────────────────────────────────
-- Как в 20261001010000_cabinet_integrity.sql, но у любой витрины, кроме отклонённой:
-- одобрить фото черновика можно и до публикации (очередь «Новые фото»)
create or replace function app.photos_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if app.actor_proposes()
     and exists (select 1 from app.listings l where l.id = new.listing_id and l.status <> 'rejected') then
    perform app.enqueue_listing_alert('ops.photos_submitted', array['admin', 'moderator']::app.staff_role[],
                                      new.listing_id);
  end if;
  return null;
end $$;

-- ── правка карточки ─────────────────────────────────────────────────────────
-- Как в 20261001010000_cabinet_integrity.sql (у каждой правки свой id — ключ не теряет
-- ничего), плюс след в журнале, если оповещение некому отправить
create or replace function app.listing_revisions_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'pending' and app.actor_proposes() then
    perform app.enqueue_staff_alert('ops.revision_submitted', array['admin', 'moderator']::app.staff_role[],
                                    jsonb_build_object('revision_id', new.id), new.id::text);
    perform app.log_alert_without_recipients('ops.revision_submitted', array['admin', 'moderator']::app.staff_role[],
                                             new.listing_id);
  end if;
  return null;
end $$;

-- ── витрина отправлена на проверку ──────────────────────────────────────────
-- От того, кто сам не решает (партнёр из кабинета, менеджер из панели), — тем, кто
-- публикует. Отправки модератора и администратора (и ручного SQL) не оповещают
create function app.listings_submitted_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if app.actor_proposes() then
    perform app.enqueue_listing_alert('ops.listing_submitted', array['admin', 'moderator']::app.staff_role[], new.id);
  end if;
  return null;
end $$;
create trigger listings_submitted_notify after update of status on app.listings
  for each row when (new.status = 'review' and old.status is distinct from 'review')
  execute function app.listings_submitted_notify();

-- ── что ждёт команду ────────────────────────────────────────────────────────
-- Как в 20260930220000_launch_metrics.sql, плюс:
--   photos_pending   — готовые фото любой витрины, кроме отклонённой (очередь «Новые фото»);
--   services_pending — новые услуги и предложения правок ждут решения, у любой витрины,
--                      кроме отклонённой (очередь услуг, GET /staff/services)
drop function app.metrics_ops_now();
create function app.metrics_ops_now()
returns table (awaiting int, overdue int, dead_total int, listings_review int, revisions_pending int,
               photos_pending int, services_pending int)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_metrics_reader();
  return query
  select (select count(*) from app.requests r
          where r.status in ('new', 'viewed') and r.first_response_at is null)::int,
         (select count(*) from app.requests r
          where r.status in ('new', 'viewed') and r.first_response_at is null and r.sla_due_at <= now())::int,
         (select count(*) from app.outbox o where o.status = 'dead')::int,
         (select count(*) from app.listings l where l.status = 'review')::int,
         (select count(*) from app.listing_revisions rv where rv.status = 'pending')::int,
         (select count(*) from app.photos p
          join app.listings l on l.id = p.listing_id
          where p.status = 'ready' and p.moderation = 'pending' and p.deleted_at is null
            and l.status <> 'rejected')::int,
         (select count(*) from app.listing_services s
          join app.listings l on l.id = s.listing_id
          where (s.status = 'review' or s.proposal is not null) and l.status <> 'rejected')::int;
end $$;

comment on function app.metrics_ops_now() is
  'Очереди команды сейчас: заявки без ответа, просрочки, недоставленное, модерация (витрины, правки, фото, услуги). Сотрудник или система';

-- ── права ───────────────────────────────────────────────────────────────────
-- Новые служебные и триггерные функции API недоступны
revoke execute on function
  app.log_alert_without_recipients(text, app.staff_role[], uuid),
  app.enqueue_listing_alert(text, app.staff_role[], uuid),
  app.listings_submitted_notify(),
  app.metrics_ops_now()
  from public;
grant execute on function app.metrics_ops_now() to bayramm_api;
