-- Откат 20261006090000_photo_reason_contact_trend.sql: метрики «Связаться» без прошлого
-- периода, photos_guard без причины, столбец причины. Только для локальной разработки и
-- проверки в CI (up → down → up)

drop function if exists app.metrics_contacts(int, text);
create function app.metrics_contacts(p_days int default 30, p_category text default null)
returns table (listing_id uuid, listing_name text, listing_status app.listing_status, category_code text,
               vendor_id uuid, vendor_name text, opens int, phone int, telegram int)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_metrics_reader();
  if p_days is null or p_days not between 1 and 366 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  return query
  select l.id, l.name, l.status, l.category_code, v.id, v.name,
         e.opens, e.phone, e.telegram
  from (
    select ce.listing_id,
           (count(*) filter (where ce.action = 'open'))::int as opens,
           (count(*) filter (where ce.action = 'phone'))::int as phone,
           (count(*) filter (where ce.action = 'telegram'))::int as telegram
    from app.contact_events ce
    where ce.created_at >= now() - make_interval(days => p_days)
    group by ce.listing_id
  ) e
  join app.listings l on l.id = e.listing_id
  join app.vendor_accounts v on v.id = l.vendor_id
  where p_category is null or l.category_code = p_category
  order by e.opens desc, e.phone + e.telegram desc, l.name, l.id
  limit 50;
end $$;
revoke execute on function app.metrics_contacts(int, text) from public;
grant execute on function app.metrics_contacts(int, text) to bayramm_api;

-- 20260929140000_listing_photos_storage.sql
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
          new.sha256, new.failure_reason, new.processed_at, new.moderated_by, new.moderated_at)
         is distinct from
         (old.status, old.moderation, old.mime, old.bytes, old.width, old.height,
          old.sha256, old.failure_reason, old.processed_at, old.moderated_by, old.moderated_at) then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if new.moderation is distinct from old.moderation then
    new.moderated_at := now();
    new.moderated_by := case when v_actor = 'staff' then app.actor_id() end;
  end if;
  return new;
end $$;
revoke execute on function app.photos_guard() from public;

revoke update (moderation_reason) on app.photos from bayramm_api;
alter table app.photos drop column if exists moderation_reason;
