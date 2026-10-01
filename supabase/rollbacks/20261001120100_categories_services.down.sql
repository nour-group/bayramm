-- Откат 20261001120100_categories_services.sql: услуги, каталог услуг, части дня,
-- поля витрины, поля заявки, правило фото категории, витрины в нескольких категориях.
--
-- Только для локальной разработки и проверки в CI (up → down → up). На
-- staging/production откат — новая миграция «вперёд»: заявки без числа гостей, фото с
-- людьми и витрины без вместимости откат не переносит — ограничения v0.1 на таких
-- данных не встанут. Пакеты залов остаются, как их видел код v0.1.

-- ── функции — к прежним определениям, пока столбцы ещё есть ─────────────────

-- 20260928120100_core.sql
create or replace function app.listing_publish_blockers(p_listing app.listings, p_target app.listing_status)
returns text[]
language sql stable security definer set search_path = ''
as $$
  select array_remove(array[
    case when p_listing.price_from_uzs is null then 'price' end,
    case when p_listing.cap_max is null then 'capacity' end,
    case when p_listing.district_code is null then 'district' end,
    case when coalesce(btrim(p_listing.description_ru), '') = ''
           or coalesce(btrim(p_listing.description_uz), '') = '' then 'descriptions' end,
    -- при выносе pii в отдельную БД эта проверка переезжает в API
    case when not exists (select 1 from pii.listing_contacts c where c.listing_id = p_listing.id)
         then 'phone' end,
    case when p_listing.category_code = 'hall' and (
           select count(distinct k.kind) from app.listing_packages k
           where k.listing_id = p_listing.id and k.kind in ('weekday', 'weekend')) < 2
         then 'packages' end,
    case when (select count(*) from app.photos p
               where p.listing_id = p_listing.id and p.deleted_at is null and p.status = 'ready'
                 and (p_target = 'review' or p.moderation = 'approved'))
              < greatest(3, coalesce(app.setting_int('min_photos'), 3))
         then 'photos' end,
    case when p_target = 'active' and v.contract_signed_at is null then 'contract' end,
    case when p_target = 'active' and v.stir_verified_at is null then 'stir' end,
    case when p_target = 'active' and v.contacts_confirmed_at is null then 'contacts' end,
    case when p_target = 'active' and v.pd_consent_signed_at is null then 'pd_consent' end
  ]::text[], null)
  from app.vendor_accounts v
  where v.id = p_listing.vendor_id
$$;

-- 20260928120100_core.sql
create or replace function app.listings_before_insert() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.status not in ('lead', 'draft') then
    raise exception 'illegal_transition' using errcode = 'BR002',
      detail = format('листинг создаётся в статусе lead или draft, а не %s', new.status);
  end if;
  if app.actor_kind() in ('vendor_user', 'client') and new.status <> 'draft' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  new.version := 1;
  new.submitted_at := null;
  new.published_at := null;
  new.status_changed_at := now();
  new.status_changed_by := app.actor_id();
  new.created_at := now();
  new.updated_at := now();
  return new;
end $$;

-- 20261001010000_cabinet_integrity.sql
create or replace function app.listings_before_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor    app.actor_kind := app.effective_actor();
  v_move     text;
  v_blockers text[];
  v_moderated boolean;
begin
  if new.id <> old.id or new.vendor_id <> old.vendor_id or new.category_code <> old.category_code
     or new.created_at <> old.created_at then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;

  v_moderated := new.name is distinct from old.name
                 or new.price_from_uzs is distinct from old.price_from_uzs
                 or new.price_unit is distinct from old.price_unit
                 or new.description_ru is distinct from old.description_ru
                 or new.description_uz is distinct from old.description_uz;

  -- После отправки на проверку вендор меняет цену, название и описания только
  -- через listing_revisions: клиент видит одобренную версию
  if v_actor = 'vendor_user' and old.status in ('review', 'active', 'suspended') and v_moderated then
    raise exception 'moderated_field_requires_revision' using errcode = 'BR005';
  end if;
  -- Опубликованную карточку менеджер меняет так же — правкой, решает модератор:
  -- кто заполняет карточку, тот её не публикует
  if v_actor = 'staff' and old.status = 'active' and v_moderated and not app.staff_can_moderate() then
    raise exception 'moderated_field_requires_revision' using errcode = 'BR005',
      detail = 'правку опубликованной карточки решает модератор';
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

  -- Защита публикации: на review/active — только если нечего блокировать
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

-- 20260928120100_core.sql
create or replace function app.requests_before_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor app.actor_kind := app.effective_actor();
begin
  if (new.id, new.public_no, new.client_id, new.listing_id, new.vendor_id, new.consent_id, new.occasion_code,
      new.event_date, new.guests, new.budget_min_uzs, new.budget_max_uzs, new.source, new.sla_due_at, new.created_at)
     is distinct from
     (old.id, old.public_no, old.client_id, old.listing_id, old.vendor_id, old.consent_id, old.occasion_code,
      old.event_date, old.guests, old.budget_min_uzs, old.budget_max_uzs, old.source, old.sla_due_at, old.created_at) then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;

  -- этапы SLA двигает только система и только вперёд
  if (new.sla_stage, new.sla_breached_at) is distinct from (old.sla_stage, old.sla_breached_at) then
    if v_actor <> 'system' then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'sla';
    end if;
    if new.sla_stage < old.sla_stage then
      raise exception 'illegal_transition' using errcode = 'BR002', detail = 'sla_stage';
    end if;
  end if;

  if new.status is distinct from old.status then
    if not exists (select 1 from app.request_transitions t
                   where t.from_status = old.status and t.to_status = new.status and t.actor = v_actor) then
      raise exception 'illegal_transition' using errcode = 'BR002',
        detail = format('%s -> %s (%s)', old.status, new.status, v_actor);
    end if;
    if new.status = 'viewed' and old.first_viewed_at is null then
      new.first_viewed_at := now();
    end if;
    if new.status in ('contacted', 'declined', 'deal') and old.first_response_at is null then
      new.first_response_at := now();
      new.first_response_by := v_actor;
    end if;
    if new.status <> 'declined' then
      new.decline_reason := null;
      new.decline_note := null;
    end if;
  elsif (new.decline_reason, new.decline_note) is distinct from (old.decline_reason, old.decline_note) then
    raise exception 'immutable_column' using errcode = 'BR006', detail = 'причина меняется только вместе со статусом';
  end if;

  if (new.first_viewed_at, new.first_response_at, new.first_response_by)
     is distinct from (old.first_viewed_at, old.first_response_at, old.first_response_by)
     and new.status is not distinct from old.status then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;

  new.updated_at := now();
  return new;
end $$;

-- 20261001010000_cabinet_integrity.sql
create or replace function app.requests_decline_busy_day() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.status = 'declined' and new.status <> 'declined' then
    delete from app.availability a
    where a.request_id = new.id and a.source = 'request_decline' and a.day >= app.tashkent_today();
  end if;
  if new.status = 'declined' and new.decline_reason = 'busy'
     and old.status is distinct from 'declined' and new.event_date >= app.tashkent_today() then
    insert into app.availability (listing_id, day, source, request_id)
    values (new.listing_id, new.event_date, 'request_decline', new.id)
    on conflict (listing_id, day) do nothing;
  end if;
  return null;
end $$;

-- 20260928120100_core.sql
create or replace function app.revision_payload_ok(p_payload jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(p_payload) = 'object'
     and p_payload <> '{}'::jsonb
     and not exists (
       select 1 from jsonb_object_keys(p_payload) k
       where k not in ('name', 'price_from_uzs', 'price_unit', 'description_ru', 'description_uz', 'packages'))
$$;

-- 20261001010000_cabinet_integrity.sql
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
  alter table app.availability disable trigger availability_guard;

  -- Уведомления: по заявкам, пользователям кабинета и правкам демо-карточек
  delete from app.outbox o
  where o.request_id = any (v_requests)
     or (o.recipient_kind = 'vendor_user' and o.recipient_id = any (v_users))
     or (o.kind = 'ops.revision_submitted' and o.payload ->> 'revision_id' in (
           select r.id::text from app.listing_revisions r where r.listing_id = any (v_listings)))
     or (o.kind = 'ops.photos_submitted' and o.payload ->> 'listing_id' = any (v_listings::text[]));
  -- Занятость ссылается на заявки (отказ «занято»); прошедшие дни уходят тоже — это
  -- уборка демо-карточки целиком, а не правка календаря
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
  alter table app.availability enable trigger availability_guard;

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

-- ── триггеры и функции миграции ─────────────────────────────────────────────
drop trigger if exists listing_packages_sync on app.listing_packages;
drop trigger if exists photos_policy_guard on app.photos;
drop trigger if exists requests_category_rules on app.requests;
drop trigger if exists listings_capacity_bump on app.listings;

drop table if exists app.availability_parts;
drop table if exists app.listing_services;
drop table if exists app.service_types;

drop function if exists app.listing_packages_sync();
drop function if exists app.photos_policy_guard();
drop function if exists app.requests_category_rules();
drop function if exists app.listings_capacity_bump();
drop function if exists app.listing_day_load(uuid, date);
drop function if exists app.listing_busy(uuid, date, date);
drop function if exists app.listing_set_parallel_capacity(uuid, int, int);
drop function if exists app.availability_parts_guard();
drop function if exists app.staff_set_listing_category(uuid, text);
drop function if exists app.staff_add_listing(uuid, text, text, text);
drop function if exists app.listing_services_notify();
drop function if exists app.enqueue_vendor_owner_notice(uuid, text, jsonb, text);
drop function if exists app.listing_services_keep_ready();
drop function if exists app.listing_services_guard();
drop function if exists app.listing_refresh_price(uuid);
drop function if exists app.listing_price_from(uuid, app.listing_status);
drop function if exists app.service_allowed(uuid, text, text);
drop function if exists app.service_proposal_ok(jsonb);
drop function if exists app.service_options_ok(jsonb);

-- ── заявки ──────────────────────────────────────────────────────────────────
drop index if exists app.requests_listing_deals;
alter table app.requests
  drop constraint if exists requests_details_object,
  drop column if exists details,
  drop column if exists day_part;
alter table app.requests alter column guests set not null;

-- ── фото ────────────────────────────────────────────────────────────────────
alter table app.photos
  drop constraint if exists photos_ack,
  drop column if exists people_consent_ack,
  alter column no_faces_ack drop default,
  drop constraint if exists photos_no_faces_ack_check,
  add constraint photos_no_faces_ack_check check (no_faces_ack);

-- ── карточка ────────────────────────────────────────────────────────────────
drop index if exists app.listings_attributes;
alter table app.listings
  drop constraint if exists listings_attributes_object,
  drop constraint if exists listings_video_links,
  drop constraint if exists listings_parallel_capacity,
  drop column if exists attributes,
  drop column if exists video_links,
  drop column if exists parallel_capacity,
  drop constraint if exists listings_price_required,
  drop constraint if exists listings_capacity_required,
  add constraint listings_price_required
    check (status not in ('review', 'active', 'suspended') or price_from_uzs is not null),
  add constraint listings_capacity_required
    check (status not in ('review', 'active', 'suspended') or cap_max is not null);
comment on column app.listings.price_from_uzs is null;

drop function if exists app.attribute_present(jsonb);
drop function if exists app.video_links_ok(text[]);
drop function if exists app.video_link_ok(text);

-- ── категории ───────────────────────────────────────────────────────────────
-- Коды v0.2 без карточек убираются; названия и включение — как в 20260928120000_foundation.sql
delete from app.categories c
where c.code in ('studio', 'flowers', 'gifts', 'restaurant', 'attire', 'zags')
  and not exists (select 1 from app.listings l where l.category_code = c.code);
update app.categories c
set name_ru = v.name_ru, name_uz = v.name_uz, enabled = v.enabled, sort = v.sort
from (values
  ('hall',  'Площадка / Тойхона', 'Maydon / Toʻyxona',    true,  1),
  ('food',  'Стол / Кейтеринг',   'Dasturxon / Ketering', false, 2),
  ('photo', 'Фото и видео',       'Foto va video',        false, 3),
  ('decor', 'Декор / Оформление', 'Bezak / Bezash',       false, 4),
  ('cake',  'Торт',               'Tort',                 false, 5),
  ('music', 'Музыка / Ведущий',   'Musiqa / Boshlovchi',  false, 6),
  ('kids',  'Аниматоры',          'Animatorlar',          false, 7),
  ('car',   'Транспорт / Кортеж', 'Transport / Kortej',   false, 8)
) as v(code, name_ru, name_uz, enabled, sort)
where c.code = v.code;
alter table app.categories
  drop constraint if exists categories_min_photos,
  drop constraint if exists categories_max_video_links,
  drop constraint if exists categories_required_fields,
  drop column if exists availability_mode,
  drop column if exists photo_policy,
  drop column if exists min_photos,
  drop column if exists max_video_links,
  drop column if exists required_fields,
  drop column if exists required_attributes,
  drop column if exists required_services;
comment on table app.categories is 'Категории услуг; в v0.1 включены только залы';

drop type if exists app.day_part;
drop type if exists app.service_status;
drop type if exists app.service_tier;
drop type if exists app.photo_policy;
drop type if exists app.availability_mode;

revoke execute on all functions in schema app, pii from public;
