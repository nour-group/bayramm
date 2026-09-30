-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — кабинет партнёра и честность модерации.
--
--   · роли партнёра (app.vendor_users.role): owner — владелец кабинета, member —
--     сотрудник площадки. Карточку — поля, пакеты, телефон, фото и предложения
--     правок — меняет только действующий владелец (политики RLS через
--     app.edits_listing); заявки и календарь ведёт любой действующий пользователь
--     вендора. Так же решает API (vendor/access.ts);
--   · фото из кабинета: владелец загружает фото своей площадки тем же путём, что
--     сотрудник (apps/api/src/photos/service.ts). Фото ждёт решения модератора
--     (pending) и клиентам до одобрения не показывается. Новое фото опубликованной
--     карточки от того, кто сам фото не одобряет (партнёр, менеджер), — оповещение
--     команде ops.photos_submitted: тем, кто решает по фото (администратор,
--     модератор), не чаще раза в час на площадку; в payload — только id площадки;
--   · календарь: прошедший день по Ташкенту не меняется никем — ни отметить, ни
--     снять, ни поправить (availability_guard). Отказ «занято» по прошедшей дате
--     день не занимает, «вернуть в активные» прошедший день не освобождает.
--     Удаление вместе с листингом (каскад) — не правка календаря;
--   · версия календаря (app.availability_versions): растёт на каждой правке
--     занятости листинга, кто бы её ни сделал — вендор, сотрудник или отказ
--     «занято». Кабинет и панель правят календарь только от версии, которую видел
--     человек: app.availability_lock сверяет её и держит строку версии до конца
--     транзакции; устарела — calendar_conflict;
--   · правки опубликованной карточки: сотрудник без права модерации (менеджер)
--     меняет её название, цену, описания и пакеты только предложением правки
--     (app.listing_revisions), как партнёр; решает модератор или администратор.
--     Такое предложение оповещает команду так же, как предложение партнёра.
--     Правку, предложенную командой, партнёр не отзывает;
--   · сроки хранения: строки фото, удалённые больше 30 дней назад, удаляет
--     app.purge_deleted_photos (актор system) — после того как API удалил их
--     объекты из хранилища (ежедневное обслуживание, apps/api/src/photos/sweep.ts).
--
-- Роли сотрудников, которые решают по модерации (публикация, фото, правки), —
-- администратор и модератор, как в apps/api/src/staff/access.ts.
--
-- Коды ошибок (продолжение списка из 20260930180000_admin_v02.sql):
--   BR024 date_out_of_range                  BR025 calendar_conflict
--
-- Откат: supabase/rollbacks/20260930210000_cabinet_integrity.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- Кто решает и кто меняет
-- ════════════════════════════════════════════════════════════════════════════

-- Актор — действующий владелец кабинета своего вендора
create function app.actor_is_vendor_owner() returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(app.actor_kind() = 'vendor_user' and exists (
    select 1 from app.vendor_users u
    where u.id = app.actor_id() and u.vendor_id = app.actor_vendor_id()
      and u.role = 'owner' and u.disabled_at is null), false)
$$;

-- Карточку листинга меняет сотрудник (система) или владелец кабинета её вендора.
-- Сотрудник площадки (member) видит карточку, но не меняет её
create function app.edits_listing(p_listing uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select app.is_privileged() or (app.owns_listing(p_listing) and app.actor_is_vendor_owner()) $$;

-- Сотрудник решает по модерации: публикация, фото, правки карточек
create function app.staff_can_moderate() returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(app.current_staff_role() in ('admin', 'moderator'), false) $$;

-- Актор предлагает, а не решает: партнёр или сотрудник без права модерации
create function app.actor_proposes() returns boolean
language sql stable security definer set search_path = ''
as $$
  select case app.actor_kind()
    when 'vendor_user' then true
    when 'staff' then not app.staff_can_moderate()
    else false
  end
$$;

-- ── политики: карточку меняет владелец кабинета ─────────────────────────────
alter policy listings_update on app.listings
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'vendor_user' and vendor_id = (select app.actor_vendor_id())
             and (select app.actor_is_vendor_owner())))
  with check ((select app.is_privileged())
              or ((select app.actor_kind()) = 'vendor_user' and vendor_id = (select app.actor_vendor_id())
                  and (select app.actor_is_vendor_owner())));

alter policy listing_contacts_insert on pii.listing_contacts
  with check ((select app.is_privileged()) or app.edits_listing(listing_id));
alter policy listing_contacts_update on pii.listing_contacts
  using ((select app.is_privileged()) or app.edits_listing(listing_id))
  with check ((select app.is_privileged()) or app.edits_listing(listing_id));
alter policy listing_contacts_delete on pii.listing_contacts
  using ((select app.is_privileged()) or app.edits_listing(listing_id));

alter policy listing_packages_write on app.listing_packages
  using ((select app.is_privileged()) or app.edits_listing(listing_id))
  with check ((select app.is_privileged()) or app.edits_listing(listing_id));

alter policy photos_insert on app.photos
  with check ((select app.is_privileged()) or app.edits_listing(listing_id));
alter policy photos_update on app.photos
  using ((select app.is_privileged()) or app.edits_listing(listing_id))
  with check ((select app.is_privileged()) or app.edits_listing(listing_id));

alter policy listing_revisions_insert on app.listing_revisions
  with check ((select app.is_privileged()) or app.edits_listing(listing_id));
alter policy listing_revisions_update on app.listing_revisions
  using ((select app.is_privileged()) or app.edits_listing(listing_id))
  with check ((select app.is_privileged()) or app.edits_listing(listing_id));

-- ════════════════════════════════════════════════════════════════════════════
-- Правки опубликованной карточки: менеджер — предложением, как партнёр
-- ════════════════════════════════════════════════════════════════════════════
-- Та же функция, что в 20260928120100_core.sql, плюс правило для сотрудника без
-- права модерации: модерируемые поля опубликованной карточки — только правкой
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

-- Пакеты цен опубликованного листинга — модерируемые данные: партнёр (с проверки
-- и дальше) и менеджер (у опубликованного) меняют их только правкой
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
  if app.actor_kind() = 'staff' and v_listing.status = 'active' and not app.staff_can_moderate() then
    raise exception 'moderated_field_requires_revision' using errcode = 'BR005',
      detail = 'правку опубликованной карточки решает модератор';
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
    return new;
  elsif tg_op = 'INSERT' then
    return new;
  end if;
  return old;
end $$;

-- Ревизии: подаёт партнёр или команда, решение — только сотрудник. Партнёр отзывает
-- только правку партнёра: предложение команды решает модератор
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
    if v_actor = 'vendor_user' and not exists (
         select 1 from app.vendor_users u where u.id = old.submitted_by) then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'правку предложила команда';
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

-- Правка от того, кто сам не решает (партнёр, менеджер), — команде. Правки
-- модератора, администратора и ручного SQL не оповещают
create or replace function app.listing_revisions_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'pending' and app.actor_proposes() then
    perform app.enqueue_staff_alert('ops.revision_submitted', array['admin', 'moderator']::app.staff_role[],
                                    jsonb_build_object('revision_id', new.id), new.id::text);
  end if;
  return null;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Фото из кабинета — команде
-- ════════════════════════════════════════════════════════════════════════════
-- Только фото опубликованной карточки: у черновика и карточки на проверке фото
-- одобряет публикация. Один раз в час на площадку — остальные фото того же часа
-- войдут в то же сообщение (сколько ждёт решения, считается при отправке)
create function app.photos_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if app.actor_proposes()
     and exists (select 1 from app.listings l where l.id = new.listing_id and l.status = 'active') then
    perform app.enqueue_staff_alert('ops.photos_submitted', array['admin', 'moderator']::app.staff_role[],
      jsonb_build_object('listing_id', new.listing_id),
      new.listing_id::text || ':' || to_char(now() at time zone 'Asia/Tashkent', 'YYYY-MM-DD"T"HH24'));
  end if;
  return null;
end $$;
create trigger photos_notify after insert on app.photos
  for each row execute function app.photos_notify();

-- ════════════════════════════════════════════════════════════════════════════
-- Календарь: прошлое неизменно, правка — от своей версии
-- ════════════════════════════════════════════════════════════════════════════

-- Та же проверка, что в 20260930151000_vendor_cabinet.sql, плюс прошедшие дни
create or replace function app.availability_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor app.actor_kind := app.effective_actor();
  v_today date := app.tashkent_today();
begin
  if tg_op = 'DELETE' then
    if old.day < v_today then
      -- удаление вместе с листингом (каскад) — не правка календаря
      if not exists (select 1 from app.listings l where l.id = old.listing_id) then
        return old;
      end if;
      raise exception 'date_out_of_range' using errcode = 'BR024', detail = 'прошедший день не меняется';
    end if;
    if v_actor = 'vendor_user' and old.source = 'staff' then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'день закрыт сотрудником';
    end if;
    return old;
  end if;

  -- Прошедший день по Ташкенту никто не отмечает и не правит: календарь — обещание
  -- клиентам на будущее, прошлое в нём — история
  if new.day < v_today or (tg_op = 'UPDATE' and old.day < v_today) then
    raise exception 'date_out_of_range' using errcode = 'BR024', detail = 'прошедший день не меняется';
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

  -- «Отказной» день — ровно дата события заявки этого листинга с отказом «занято»
  if new.source = 'request_decline' and not exists (
       select 1 from app.requests r
       where r.id = new.request_id and r.listing_id = new.listing_id and r.event_date = new.day
         and r.status = 'declined' and r.decline_reason = 'busy') then
    raise exception 'invalid_input' using errcode = '23514',
      detail = 'request_decline — только дата заявки этого листинга с отказом «занято»';
  end if;
  return new;
end $$;

-- Отказ «занято» занимает дату события, «вернуть в активные» снимает только ту
-- отметку, которую поставил этот отказ. Прошедшие дни не трогаются: заявку с
-- прошедшей датой ещё можно закрыть до ночного истечения
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

-- ── версия календаря ────────────────────────────────────────────────────────
-- Строки нет — версия 0 (календарь ещё не меняли)
create table app.availability_versions (
  listing_id uuid primary key references app.listings on delete cascade,
  version    int not null default 0 check (version >= 0),
  updated_at timestamptz not null default now()
);
comment on table app.availability_versions is
  'Версия календаря занятости листинга: растёт на каждой правке app.availability (оптимистичная блокировка)';

alter table app.availability_versions enable row level security;
create policy availability_versions_read on app.availability_versions for select to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id));
grant select on app.availability_versions to bayramm_api;

create function app.availability_bump_version() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing uuid := case when tg_op = 'DELETE' then old.listing_id else new.listing_id end;
begin
  -- удаление вместе с листингом: считать больше нечего
  if exists (select 1 from app.listings l where l.id = v_listing) then
    insert into app.availability_versions as v (listing_id, version)
    values (v_listing, 1)
    on conflict (listing_id) do update set version = v.version + 1, updated_at = now();
  end if;
  return null;
end $$;
create trigger availability_bump_version after insert or update or delete on app.availability
  for each row execute function app.availability_bump_version();

-- Правка календаря — только от версии, которую видел человек. Строка версии
-- заблокирована до конца транзакции: параллельная правка того же календаря ждёт
-- и затем видит новую версию. Чужой листинг — как несуществующий (42501 → 404)
create function app.availability_lock(p_listing uuid, p_version int) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_version int;
begin
  if p_listing is null or p_version is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  if not (app.is_privileged() or app.owns_listing(p_listing)) then
    raise exception 'not_found' using errcode = '42501';
  end if;
  insert into app.availability_versions (listing_id) values (p_listing)
  on conflict (listing_id) do nothing;
  select v.version into v_version from app.availability_versions v
  where v.listing_id = p_listing for update;
  if v_version <> p_version then
    raise exception 'calendar_conflict' using errcode = 'BR025',
      detail = format('версия календаря — %s', v_version);
  end if;
  return v_version;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Сроки хранения фото
-- ════════════════════════════════════════════════════════════════════════════
-- Строки фото, удалённые больше 30 дней назад, — из переданных. Объекты к этому
-- времени уже удалил API: строка — последнее, что знает об объекте. Только system
create function app.purge_deleted_photos(p_ids uuid[]) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  delete from app.photos p
  where p.id = any (p_ids) and p.deleted_at < now() - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

comment on function app.purge_deleted_photos(uuid[]) is
  'Удаляет строки фото, удалённых больше 30 дней назад (объекты уже удалены API). Только актор system';

-- ── права ───────────────────────────────────────────────────────────────────
-- Триггерные и служебные функции API не вызывает. Политикам RLS нужны
-- app.actor_is_vendor_owner и app.edits_listing
revoke execute on all functions in schema app, pii from public;
grant execute on function
  app.actor_is_vendor_owner(),
  app.edits_listing(uuid),
  app.availability_lock(uuid, int),
  app.purge_deleted_photos(uuid[])
  to bayramm_api;
