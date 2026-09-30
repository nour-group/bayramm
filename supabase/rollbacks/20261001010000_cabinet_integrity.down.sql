-- Откат 20261001010000_cabinet_integrity.sql: роли партнёра в политиках, оповещение
-- о фото, прошедшие дни и версия календаря, правки менеджера, чистка строк фото.
-- Функции возвращаются к прежним определениям; строки outbox и отметки занятости
-- остаются (данные, а не схема).

-- ── уборка демо-данных: как в 20260930210000_demo_purge.sql ─────────────────
create or replace function app.demo_purge() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_vendors  uuid[];
  v_listings uuid[];
  v_requests uuid[];
  v_users    uuid[];
  v_photos   int;
  v_result   jsonb;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;

  -- Демо-вендоры блокируются: параллельная правка из панели дождётся уборки
  select coalesce(array_agg(v.id), '{}') into v_vendors
  from (select v.id from app.vendor_accounts v
        where v.id::text like '00000000-0000-4000-8000-de%'
        for update) v;
  if cardinality(v_vendors) = 0 then
    return jsonb_build_object('vendors', 0, 'listings', 0, 'photos', 0, 'requests', 0, 'vendorUsers', 0);
  end if;

  select coalesce(array_agg(l.id), '{}') into v_listings
  from app.listings l where l.vendor_id = any (v_vendors);
  select coalesce(array_agg(r.id), '{}') into v_requests
  from app.requests r where r.vendor_id = any (v_vendors) or r.listing_id = any (v_listings);
  select coalesce(array_agg(u.id), '{}') into v_users
  from app.vendor_users u where u.vendor_id = any (v_vendors);
  select count(*) into v_photos from app.photos p where p.listing_id = any (v_listings);

  alter table app.request_status_log disable trigger request_status_log_append_only;
  alter table app.request_notes disable trigger request_notes_append_only;
  alter table app.consents disable trigger consents_append_only;
  alter table app.listing_status_log disable trigger listing_status_log_append_only;

  -- Уведомления: по заявкам, пользователям кабинета и правкам демо-карточек
  delete from app.outbox o
  where o.request_id = any (v_requests)
     or (o.recipient_kind = 'vendor_user' and o.recipient_id = any (v_users))
     or (o.kind = 'ops.revision_submitted' and o.payload ->> 'revision_id' in (
           select r.id::text from app.listing_revisions r where r.listing_id = any (v_listings)));
  -- Занятость ссылается на заявки (отказ «занято»)
  delete from app.availability a where a.listing_id = any (v_listings);
  delete from app.request_notes n where n.request_id = any (v_requests);
  delete from app.request_status_log s where s.request_id = any (v_requests);
  delete from app.requests r where r.id = any (v_requests);
  delete from app.consents c where c.scope_listing_id = any (v_listings);
  delete from app.listing_status_log s where s.listing_id = any (v_listings);
  delete from app.sessions s where s.vendor_user_id = any (v_users);
  delete from app.vendor_users u where u.id = any (v_users);
  delete from app.listings l where l.id = any (v_listings);
  delete from app.vendor_accounts v where v.id = any (v_vendors);

  alter table app.request_status_log enable trigger request_status_log_append_only;
  alter table app.request_notes enable trigger request_notes_append_only;
  alter table app.consents enable trigger consents_append_only;
  alter table app.listing_status_log enable trigger listing_status_log_append_only;

  v_result := jsonb_build_object(
    'vendors', cardinality(v_vendors),
    'listings', cardinality(v_listings),
    'photos', v_photos,
    'requests', cardinality(v_requests),
    'vendorUsers', cardinality(v_users));
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('demo.reset', 'demo', 'staging', v_result, 'system');
  return v_result;
end $$;

-- ── сроки хранения фото ─────────────────────────────────────────────────────
drop function if exists app.purge_deleted_photos(uuid[]);

-- ── версия календаря ────────────────────────────────────────────────────────
drop function if exists app.availability_lock(uuid, int);
drop trigger if exists availability_bump_version on app.availability;
drop function if exists app.availability_bump_version();
drop table if exists app.availability_versions;

-- ── календарь: как в 20260930151000_vendor_cabinet.sql ──────────────────────
create or replace function app.availability_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor app.actor_kind := app.effective_actor();
begin
  if tg_op = 'DELETE' then
    if v_actor = 'vendor_user' and old.source = 'staff' then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'день закрыт сотрудником';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if v_actor = 'vendor_user' then
      raise exception 'forbidden_for_actor' using errcode = 'BR003',
        detail = 'отметку снимают и ставят заново, а не правят';
    end if;
    if (new.listing_id, new.day, new.created_by, new.created_at)
       is distinct from (old.listing_id, old.day, old.created_by, old.created_at) then
      raise exception 'immutable_column' using errcode = 'BR006';
    end if;
  else
    new.created_by := app.actor_id();
    new.created_at := now();
    if v_actor = 'vendor_user' and new.source = 'staff' then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'source staff ставит только сотрудник';
    end if;
  end if;

  if new.source = 'request_decline' and not exists (
       select 1 from app.requests r
       where r.id = new.request_id and r.listing_id = new.listing_id and r.event_date = new.day
         and r.status = 'declined' and r.decline_reason = 'busy') then
    raise exception 'invalid_input' using errcode = '23514',
      detail = 'request_decline — только дата заявки этого листинга с отказом «занято»';
  end if;
  return new;
end $$;

create or replace function app.requests_decline_busy_day() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.status = 'declined' and new.status <> 'declined' then
    delete from app.availability a
    where a.request_id = new.id and a.source = 'request_decline';
  end if;
  if new.status = 'declined' and new.decline_reason = 'busy'
     and old.status is distinct from 'declined' then
    insert into app.availability (listing_id, day, source, request_id)
    values (new.listing_id, new.event_date, 'request_decline', new.id)
    on conflict (listing_id, day) do nothing;
  end if;
  return null;
end $$;

-- ── фото из кабинета ────────────────────────────────────────────────────────
drop trigger if exists photos_notify on app.photos;
drop function if exists app.photos_notify();

-- ── правки: как в 20260928120100_core.sql и 20260930200000_revisions_phone_invites.sql
create or replace function app.listing_revisions_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'pending' and app.effective_actor() = 'vendor_user' then
    perform app.enqueue_staff_alert('ops.revision_submitted', array['admin', 'moderator']::app.staff_role[],
                                    jsonb_build_object('revision_id', new.id), new.id::text);
  end if;
  return null;
end $$;

create or replace function app.listing_revisions_guard() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_actor app.actor_kind := app.effective_actor();
begin
  if v_actor = 'client' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'illegal_transition' using errcode = 'BR002';
    end if;
    new.submitted_by := app.actor_id();
    new.submitted_at := now();
    new.decided_by := null;
    new.decided_at := null;
    return new;
  end if;

  if new.id <> old.id or new.listing_id <> old.listing_id or new.submitted_at <> old.submitted_at
     or new.submitted_by is distinct from old.submitted_by then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;
  if old.status <> 'pending' then
    raise exception 'immutable_column' using errcode = 'BR006', detail = 'решение по ревизии окончательное';
  end if;
  if new.status is distinct from old.status then
    if v_actor = 'vendor_user' and new.status <> 'withdrawn' then
      raise exception 'forbidden_for_actor' using errcode = 'BR003';
    end if;
    if v_actor in ('staff', 'system') and new.status not in ('approved', 'declined') then
      raise exception 'illegal_transition' using errcode = 'BR002';
    end if;
    if new.status in ('approved', 'declined') then
      new.decided_at := now();
      new.decided_by := case when v_actor = 'staff' then app.actor_id() end;
    end if;
  elsif v_actor = 'vendor_user' and (new.decided_by, new.decided_at, new.decision_reason)
        is distinct from (old.decided_by, old.decided_at, old.decision_reason) then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  return new;
end $$;

create or replace function app.listing_packages_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing app.listings;
begin
  select l.* into v_listing from app.listings l where l.id = coalesce(new.listing_id, old.listing_id);
  if tg_op = 'UPDATE' and new.listing_id <> old.listing_id then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;
  if app.actor_kind() = 'vendor_user' and v_listing.status in ('review', 'active', 'suspended') then
    raise exception 'moderated_field_requires_revision' using errcode = 'BR005';
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
    return new;
  elsif tg_op = 'INSERT' then
    return new;
  end if;
  return old;
end $$;

create or replace function app.listings_before_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor    app.actor_kind := app.effective_actor();
  v_move     text;
  v_blockers text[];
begin
  if new.id <> old.id or new.vendor_id <> old.vendor_id or new.category_code <> old.category_code
     or new.created_at <> old.created_at then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;

  if v_actor = 'vendor_user' and old.status in ('review', 'active', 'suspended') and (
       new.name is distinct from old.name
       or new.price_from_uzs is distinct from old.price_from_uzs
       or new.price_unit is distinct from old.price_unit
       or new.description_ru is distinct from old.description_ru
       or new.description_uz is distinct from old.description_uz) then
    raise exception 'moderated_field_requires_revision' using errcode = 'BR005';
  end if;

  if new.status is distinct from old.status then
    v_move := old.status::text || '>' || new.status::text;
    if v_move <> all (array[
         'lead>draft', 'draft>review', 'review>draft', 'review>active',
         'active>suspended', 'suspended>active',
         'lead>rejected', 'draft>rejected', 'review>rejected', 'rejected>draft']) then
      raise exception 'illegal_transition' using errcode = 'BR002', detail = v_move;
    end if;
    if v_actor = 'client'
       or (v_actor = 'vendor_user' and v_move <> all (array['draft>review', 'review>draft', 'rejected>draft'])) then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = v_move;
    end if;
    if new.status not in ('suspended', 'rejected') then
      new.status_reason := null;
    end if;
    new.status_changed_at := now();
    new.status_changed_by := app.actor_id();
    if new.status = 'review' then
      new.submitted_at := now();
    elsif new.status = 'active' then
      new.published_at := coalesce(old.published_at, now());
    end if;
  end if;

  if new.status in ('review', 'active') and (
       new.status is distinct from old.status
       or (new.price_from_uzs, new.cap_max, new.district_code, new.description_ru, new.description_uz)
          is distinct from (old.price_from_uzs, old.cap_max, old.district_code, old.description_ru, old.description_uz)) then
    v_blockers := app.listing_publish_blockers(new, new.status);
    if cardinality(v_blockers) > 0 then
      raise exception 'publish_blocked' using errcode = 'BR004', detail = array_to_string(v_blockers, ',');
    end if;
  end if;

  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;

-- ── политики: как в 20260928120100_core.sql ─────────────────────────────────
alter policy listing_revisions_update on app.listing_revisions
  using ((select app.is_privileged()) or app.owns_listing(listing_id))
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));
alter policy listing_revisions_insert on app.listing_revisions
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));

alter policy photos_update on app.photos
  using ((select app.is_privileged()) or app.owns_listing(listing_id))
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));
alter policy photos_insert on app.photos
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));

alter policy listing_packages_write on app.listing_packages
  using ((select app.is_privileged()) or app.owns_listing(listing_id))
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));

alter policy listing_contacts_delete on pii.listing_contacts
  using ((select app.is_privileged()) or app.owns_listing(listing_id));
alter policy listing_contacts_update on pii.listing_contacts
  using ((select app.is_privileged()) or app.owns_listing(listing_id))
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));
alter policy listing_contacts_insert on pii.listing_contacts
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));

alter policy listings_update on app.listings
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'vendor_user' and vendor_id = (select app.actor_vendor_id())))
  with check ((select app.is_privileged())
              or ((select app.actor_kind()) = 'vendor_user' and vendor_id = (select app.actor_vendor_id())));

drop function if exists app.actor_proposes();
drop function if exists app.staff_can_moderate();
drop function if exists app.edits_listing(uuid);
drop function if exists app.actor_is_vendor_owner();
