-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — партнёр сам настраивает витрину: вместимость, район, адрес.
--
-- Одно правило для партнёра (владельца кабинета):
--   · пока витрины нет на сайте (lead, draft, rejected) — название, описания, поля
--     витрины, ссылки на видео, вместимость, район и адрес сохраняются сразу;
--   · на проверке, в каталоге и приостановленная (review, active, suspended) — только
--     предложением (app.listing_revisions), решает команда. Клиент видит одобренное.
-- Прежде черновик тоже шёл через модерацию правки, а потом ещё раз — через проверку
-- витрины целиком.
--
--   · app.revision_payload_ok: в предложении теперь ещё cap_min, cap_max, district_code,
--     address_ru, address_uz (ограничение таблицы listing_revisions_payload_check вызывает
--     функцию по имени — таблица не меняется, открытые предложения остаются верными);
--   · app.listings_before_update: как в 20261001120100_categories_services.sql, плюс:
--       · адрес страницы (slug) партнёр не меняет совсем (BR006 immutable_column) — раньше
--         его защищало только отсутствие маршрута;
--       · вместимость, район и адрес на проверке, в каталоге и у приостановленной партнёр
--         меняет так же, как название, — предложением (BR005);
--     сотрудник по-прежнему правит эти поля сразу;
--   · app.audit_vendor_listing: правка партнёра, сохранённая сразу, — запись listing.vendor_update
--     { fields, vendor_id }: только имена полей, без значений (журнал сотрудников — audit_staff —
--     за партнёра не пишет);
--   · app.listings_rebase_revisions: открытое предложение «устарело» (панель: base_version <>
--     version), если карточку менял кто-то после подачи. Версия растёт и от того, что к
--     предложению не относится: услуга одобрена и пересчиталась цена «от», партнёр отметил
--     «заказов одновременно», менеджер поправил телефон. Такая правка версию предложения
--     подтягивает (base_version = новая версия), а если поменялось поле, которое предложение
--     тоже меняет, — нет: сравнить «сейчас» и «предлагают» должен человек. Триггер audit_staff
--     у предложений теперь только на смену решения, иначе подтягивание версии попадало бы в
--     журнал как «решение по предложению».
--
-- Новых кодов ошибок нет: адрес страницы — immutable_column (BR006), остальное после отправки
-- на проверку — moderated_field_requires_revision (BR005), как у названия.
--
-- Откат: supabase/rollbacks/20261012090000_vendor_listing_facts.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── допустимые ключи предложения ────────────────────────────────────────────
-- Как в 20261002090000_services_only_category_metrics.sql, плюс факты витрины
create or replace function app.revision_payload_ok(p_payload jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(p_payload) = 'object'
     and p_payload <> '{}'::jsonb
     and not exists (
       select 1 from jsonb_object_keys(p_payload) k
       where k not in ('name', 'description_ru', 'description_uz', 'attributes', 'video_links',
                       'cap_min', 'cap_max', 'district_code', 'address_ru', 'address_uz'))
$$;

-- ── карточка: правка ────────────────────────────────────────────────────────
-- Как в 20261001120100_categories_services.sql, плюс (см. шапку): адрес страницы партнёру
-- закрыт, вместимость / район / адрес после отправки на проверку — только предложением
create or replace function app.listings_before_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor     app.actor_kind := app.effective_actor();
  v_move      text;
  v_blockers  text[];
  v_moderated boolean;
  v_facts     boolean;
  v_category  app.categories;
  v_price     bigint;
  v_unit      app.price_unit;
begin
  if new.id <> old.id or new.vendor_id <> old.vendor_id or new.created_at <> old.created_at then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;
  if v_actor = 'vendor_user' and new.slug is distinct from old.slug then
    raise exception 'immutable_column' using errcode = 'BR006', detail = 'адрес страницы меняет сотрудник';
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
  -- Факты витрины: их видит клиент (фильтр по гостям и району, адрес на странице)
  v_facts := new.cap_min is distinct from old.cap_min
             or new.cap_max is distinct from old.cap_max
             or new.district_code is distinct from old.district_code
             or new.address_ru is distinct from old.address_ru
             or new.address_uz is distinct from old.address_uz;

  -- После отправки на проверку партнёр меняет название, описания, поля витрины, ссылки на
  -- видео, вместимость, район и адрес только через listing_revisions: клиент видит
  -- одобренную версию
  if v_actor = 'vendor_user' and old.status in ('review', 'active', 'suspended')
     and (v_moderated or v_facts or new.attributes is distinct from old.attributes
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

-- ── журнал: правка партнёра, сохранённая сразу ──────────────────────────────
-- Только имена полей: значения (название, описания, адрес) в журнал не идут. Статус и
-- прочее служебное партнёр меняет другими путями — они здесь не считаются
create function app.audit_vendor_listing() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_fields text[];
begin
  if app.actor_kind() is distinct from 'vendor_user' then
    return null;
  end if;
  select coalesce(array_agg(n.key order by n.key), '{}') into v_fields
  from jsonb_each(to_jsonb(new)) n
  where n.key in ('name', 'description_ru', 'description_uz', 'attributes', 'video_links',
                  'cap_min', 'cap_max', 'district_code', 'address_ru', 'address_uz')
    and n.value is distinct from to_jsonb(old) -> n.key;
  if cardinality(v_fields) = 0 then
    return null;
  end if;
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('listing.vendor_update', 'listing', new.id::text,
          jsonb_build_object('fields', to_jsonb(v_fields), 'vendor_id', new.vendor_id),
          coalesce(nullif(current_setting('app.source', true), '')::app.source, 'vendor_cabinet'));
  return null;
end $$;

create trigger audit_vendor after update on app.listings
  for each row execute function app.audit_vendor_listing();

-- ── открытое предложение и версия карточки ──────────────────────────────────
-- Версия карточки растёт на каждый UPDATE (оптимистичная блокировка), а «предложение
-- устарело» должно значить одно: поля, которые оно меняет, поменялись после подачи. Меняли
-- другое — подтягиваем версию основы. Только то, что было актуально до этой правки
-- (base_version = старая версия): уже устаревшее таким не «оживает»
create function app.listings_rebase_revisions() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_changed text[];
begin
  v_changed := array_remove(array[
    case when new.name is distinct from old.name then 'name' end,
    case when new.description_ru is distinct from old.description_ru then 'description_ru' end,
    case when new.description_uz is distinct from old.description_uz then 'description_uz' end,
    case when new.attributes is distinct from old.attributes then 'attributes' end,
    case when new.video_links is distinct from old.video_links then 'video_links' end,
    case when new.cap_min is distinct from old.cap_min then 'cap_min' end,
    case when new.cap_max is distinct from old.cap_max then 'cap_max' end,
    case when new.district_code is distinct from old.district_code then 'district_code' end,
    case when new.address_ru is distinct from old.address_ru then 'address_ru' end,
    case when new.address_uz is distinct from old.address_uz then 'address_uz' end
  ], null);
  update app.listing_revisions rv
  set base_version = new.version
  where rv.listing_id = new.id and rv.status = 'pending' and rv.base_version = old.version
    and not (rv.payload ?| v_changed);
  return null;
end $$;

create trigger listings_rebase_revisions after update on app.listings
  for each row when (new.version is distinct from old.version)
  execute function app.listings_rebase_revisions();

-- Журнал сотрудников по предложению — на решение (статус, причина), не на подтягивание версии
drop trigger audit_staff on app.listing_revisions;
create trigger audit_staff after update of status, decision_reason, payload on app.listing_revisions
  for each row execute function app.audit_staff_change('listing', 'listing_id', 'listing_revision', 'id');

-- ── права ───────────────────────────────────────────────────────────────────
-- Новые триггерные функции API недоступны
revoke execute on function
  app.audit_vendor_listing(),
  app.listings_rebase_revisions()
  from public;
