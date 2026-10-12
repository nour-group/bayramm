-- Откат 20261012090000_vendor_listing_facts.sql: ключи вместимости, района и адреса снова
-- не принимаются в предложении, партнёр снова может менять эти поля сразу (и адрес страницы
-- закрывает только отсутствие маршрута), записи listing.vendor_update перестают писаться,
-- «устаревшее» предложение — снова по любой смене версии.
--
-- Только для локальной разработки и проверки в CI (up → down → up). Открытые предложения с
-- новыми ключами прежний код не разберёт — они отклоняются с причиной; прежние записи
-- журнала остаются.

-- ── предложения с новыми ключами ────────────────────────────────────────────
update app.listing_revisions
set status = 'declined', decision_reason = 'Откат миграции: вместимость, район и адрес правкой не предлагаются'
where status = 'pending'
  and payload ?| array['cap_min', 'cap_max', 'district_code', 'address_ru', 'address_uz'];

-- ── журнал и версия предложения ─────────────────────────────────────────────
drop trigger audit_vendor on app.listings;
drop function app.audit_vendor_listing();
drop trigger listings_rebase_revisions on app.listings;
drop function app.listings_rebase_revisions();

-- 20260930180000_admin_v02.sql
drop trigger audit_staff on app.listing_revisions;
create trigger audit_staff after update on app.listing_revisions
  for each row execute function app.audit_staff_change('listing', 'listing_id', 'listing_revision', 'id');

-- ── допустимые ключи предложения: 20261002090000_services_only_category_metrics.sql ──
create or replace function app.revision_payload_ok(p_payload jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(p_payload) = 'object'
     and p_payload <> '{}'::jsonb
     and not exists (
       select 1 from jsonb_object_keys(p_payload) k
       where k not in ('name', 'description_ru', 'description_uz', 'attributes', 'video_links'))
$$;

-- ── карточка: правка — 20261001120100_categories_services.sql ───────────────
create or replace function app.listings_before_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor     app.actor_kind := app.effective_actor();
  v_move      text;
  v_blockers  text[];
  v_moderated boolean;
  v_category  app.categories;
  v_price     bigint;
  v_unit      app.price_unit;
begin
  if new.id <> old.id or new.vendor_id <> old.vendor_id or new.created_at <> old.created_at then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;

  select c.* into v_category from app.categories c where c.code = new.category_code;
  if new.category_code <> old.category_code then
    if not app.is_privileged() then
      raise exception 'immutable_column' using errcode = 'BR006', detail = 'категорию меняет сотрудник';
    end if;
    if exists (select 1 from app.requests r where r.listing_id = new.id) then
      raise exception 'category_locked' using errcode = 'BR026', detail = 'requests';
    end if;
    if exists (select 1 from app.listing_services s where s.listing_id = new.id) then
      raise exception 'category_locked' using errcode = 'BR026', detail = 'services';
    end if;
    if v_category.photo_policy = 'no_people' and exists (
         select 1 from app.photos p where p.listing_id = new.id and p.deleted_at is null and not p.no_faces_ack) then
      raise exception 'photo_ack_required' using errcode = 'BR028', detail = 'photos';
    end if;
  end if;
  if cardinality(new.video_links) > coalesce(v_category.max_video_links, 0)
     and new.video_links is distinct from old.video_links then
    raise exception 'invalid_input' using errcode = '23514', detail = 'video_links';
  end if;

  -- Цена «от» — из услуг
  select f.price, f.unit into v_price, v_unit from app.listing_price_from(new.id, new.status) f;
  new.price_from_uzs := v_price;
  new.price_unit := coalesce(v_unit, old.price_unit);

  v_moderated := new.name is distinct from old.name
                 or new.description_ru is distinct from old.description_ru
                 or new.description_uz is distinct from old.description_uz;

  -- После отправки на проверку партнёр меняет название, описания, поля витрины и ссылки
  -- на видео только через listing_revisions: клиент видит одобренную версию
  if v_actor = 'vendor_user' and old.status in ('review', 'active', 'suspended')
     and (v_moderated or new.attributes is distinct from old.attributes
          or new.video_links is distinct from old.video_links) then
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
       or (new.price_from_uzs, new.cap_max, new.district_code, new.description_ru, new.description_uz, new.attributes)
          is distinct from
          (old.price_from_uzs, old.cap_max, old.district_code, old.description_ru, old.description_uz, old.attributes)) then
    v_blockers := app.listing_publish_blockers(new, new.status);
    if cardinality(v_blockers) > 0 then
      raise exception 'publish_blocked' using errcode = 'BR004', detail = array_to_string(v_blockers, ',');
    end if;
  end if;

  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;
