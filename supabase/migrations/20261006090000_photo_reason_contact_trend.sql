-- Причина отказа по фото и динамика «Связаться».
--
--   · app.photos.moderation_reason — модератор пишет причину, когда отклоняет фото; партнёр
--     видит её в кабинете рядом с фото. Есть только у отклонённого (photos_guard стирает её при
--     другом решении), вендор её не меняет;
--   · app.metrics_contacts — ещё и открытия за предыдущий такой же период (opens_prev): растёт
--     интерес к витрине или падает.

-- ════════════════════════════════════════════════════════════════════════════
-- Причина отказа по фото
-- ════════════════════════════════════════════════════════════════════════════

alter table app.photos
  add column moderation_reason text
    check (moderation_reason is null or length(btrim(moderation_reason)) between 1 and 500);

comment on column app.photos.moderation_reason is
  'Причина отказа модератора — только у отклонённого фото; партнёр видит её в кабинете';

-- API пишет её вместе с решением (столбцы фото API обновляет поимённо — core.sql)
grant update (moderation_reason) on app.photos to bayramm_api;

-- photos_guard из 20260929140000_listing_photos_storage.sql: вендор не меняет и причину;
-- причина живёт только у отклонённого
create or replace function app.photos_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor app.actor_kind := app.effective_actor();
  v_count int;
begin
  if tg_op = 'INSERT' then
    -- блокируем листинг, чтобы параллельные загрузки не превысили лимит
    perform 1 from app.listings l where l.id = new.listing_id for update;
    select count(*) into v_count from app.photos p where p.listing_id = new.listing_id and p.deleted_at is null;
    if v_count >= coalesce(app.setting_int('max_photos'), 10) then
      raise exception 'too_many_photos' using errcode = 'BR011';
    end if;
    if v_actor = 'vendor_user' and (new.status <> 'uploading' or new.moderation <> 'pending') then
      raise exception 'forbidden_for_actor' using errcode = 'BR003';
    end if;
    new.uploaded_by := app.actor_id();
    new.moderated_by := null;
    new.moderated_at := null;
    new.moderation_reason := null;
    new.deleted_at := null;
    new.created_at := now();
    return new;
  end if;

  if new.id <> old.id or new.listing_id <> old.listing_id or new.storage_key <> old.storage_key
     or new.created_at <> old.created_at or new.uploaded_by is distinct from old.uploaded_by
     or (old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at) then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;
  if v_actor = 'vendor_user'
     and (new.status, new.moderation, new.mime, new.bytes, new.width, new.height,
          new.sha256, new.failure_reason, new.processed_at, new.moderated_by, new.moderated_at,
          new.moderation_reason)
         is distinct from
         (old.status, old.moderation, old.mime, old.bytes, old.width, old.height,
          old.sha256, old.failure_reason, old.processed_at, old.moderated_by, old.moderated_at,
          old.moderation_reason) then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if new.moderation is distinct from old.moderation then
    new.moderated_at := now();
    new.moderated_by := case when v_actor = 'staff' then app.actor_id() end;
  end if;
  -- Причина — только у отклонённого: одобрили или вернули на проверку — её нет
  if new.moderation <> 'declined' then
    new.moderation_reason := null;
  end if;
  return new;
end $$;
revoke execute on function app.photos_guard() from public;

-- ════════════════════════════════════════════════════════════════════════════
-- «Связаться»: открытия и за предыдущий период
-- ════════════════════════════════════════════════════════════════════════════

-- Набор столбцов меняется — функцию заново (как в 20261005090000_listing_contacts_events.sql,
-- плюс opens_prev: открытия за p_days дней до начала периода)
drop function app.metrics_contacts(int, text);

create function app.metrics_contacts(p_days int default 30, p_category text default null)
returns table (listing_id uuid, listing_name text, listing_status app.listing_status, category_code text,
               vendor_id uuid, vendor_name text, opens int, phone int, telegram int, opens_prev int)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_from timestamptz;
begin
  perform app.assert_metrics_reader();
  if p_days is null or p_days not between 1 and 366 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  v_from := now() - make_interval(days => p_days);
  return query
  select l.id, l.name, l.status, l.category_code, v.id, v.name,
         e.opens, e.phone, e.telegram, e.opens_prev
  from (
    select ce.listing_id,
           (count(*) filter (where ce.action = 'open' and ce.created_at >= v_from))::int as opens,
           (count(*) filter (where ce.action = 'phone' and ce.created_at >= v_from))::int as phone,
           (count(*) filter (where ce.action = 'telegram' and ce.created_at >= v_from))::int as telegram,
           (count(*) filter (where ce.action = 'open' and ce.created_at < v_from))::int as opens_prev
    from app.contact_events ce
    where ce.created_at >= v_from - make_interval(days => p_days)
    group by ce.listing_id
  ) e
  join app.listings l on l.id = e.listing_id
  join app.vendor_accounts v on v.id = l.vendor_id
  -- В списке — витрины с событиями в этом периоде; прошлый — только для сравнения
  where (e.opens + e.phone + e.telegram) > 0
    and (p_category is null or l.category_code = p_category)
  order by e.opens desc, e.phone + e.telegram desc, l.name, l.id
  limit 50;
end $$;

comment on function app.metrics_contacts(int, text) is
  'У каких витрин чаще открывают контакты: открытия, звонки, Telegram за период и открытия за предыдущий (без клиентов)';

revoke execute on function app.metrics_contacts(int, text) from public;
grant execute on function app.metrics_contacts(int, text) to bayramm_api;
