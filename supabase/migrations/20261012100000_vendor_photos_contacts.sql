-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — партнёр сам ведёт фото и публичные контакты витрины.
--
--   · порядок и обложка фото — решает партнёр (владелец кабинета) напрямую, у одобренных
--     фото: столбцы sort и is_cover он уже менял (core.sql, grant update), добавлена только
--     защита — обложкой не станет ждущее, отклонённое или удалённое фото (триггер
--     photos_vendor_guard, BR003). Журнал порядка и обложки пишет API (audit_log, id без ПДн);
--   · «Отозвать с проверки» (review → draft) база партнёру уже разрешала
--     (listings_before_update: draft>review, review>draft, rejected>draft) — своего кода не нужно;
--   · публичные телефон и Telegram витрины (pii.listing_contacts) партнёр меняет сам:
--       – пока витрины нет на сайте (lead, draft, rejected) — напрямую (RLS и так даёт это
--         владельцу кабинета); запись в журнал пишет триггер listing_contacts_vendor_audit
--         (только имена полей, не значения);
--       – пока она на проверке, опубликована или приостановлена (те же статусы, что у
--         moderated_field_requires_revision) — прямая запись партнёра закрыта (BR036), изменение
--         идёт запросом: pii.listing_contact_changes, одна ждущая строка на витрину, новая
--         отправка заменяет её; решает администратор или модератор (одобрить — применить к
--         pii.listing_contacts, отклонить — только с причиной);
--       – номера хранятся в запросе, пока он ждёт решения: после решения, отзыва или записи
--         партнёра напрямую (витрина вышла с сайта) значения стираются, остаются статус, причина
--         отказа и время;
--       – телефон у опубликованной витрины обязателен (listing_contacts_keep_ready), Telegram — нет;
--   · оповещение команде ops.contact_change_submitted (app.enqueue_listing_alert, в payload только
--     id витрины, текст и кнопка — при отправке), решение — владельцам кабинета
--     vendor.contact_change_decided (id витрины и решение);
--   · чтение значений запроса — pii.read_listing_contact_change: сотруднику (администратор,
--     модератор) и владельцу витрины, каждое чтение — в app.pii_access_log
--     (listing_contact, цель staff_contact_change / self_contact_change);
--   · app.contact_change_state — без значений: последний запрос, что в нём меняется (телефон,
--     Telegram), причина отказа; app.staff_contact_changes — очередь ждущих запросов.
--
-- Коды ошибок (продолжение списка из 20261011110000_vendor_user_invites.sql):
--   BR036 contacts_require_review      партнёр пишет контакты витрины, которая на проверке или на сайте
--   BR037 contact_change_not_pending   ждущего запроса на смену контактов нет (уже решён или отозван)
--   BR038 contacts_not_live            запрос на смену контактов подают только на витрине, которая на
--                                      проверке или на сайте; иначе контакты сохраняются сразу
--
-- Откат: supabase/rollbacks/20261012100000_vendor_photos_contacts.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── фото: обложка партнёра ──────────────────────────────────────────────────
-- Обложкой партнёр делает только одобренное готовое фото своей витрины: клиенты видят её
-- первой, а ждущее и отклонённое им не показываются. Порядок (sort) защиты не требует
create function app.photos_vendor_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if app.effective_actor() = 'vendor_user'
     and (new.moderation <> 'approved' or new.status <> 'ready' or new.deleted_at is not null) then
    raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'is_cover';
  end if;
  return new;
end $$;
create trigger photos_vendor_guard before update on app.photos
  for each row when (new.is_cover and not old.is_cover)
  execute function app.photos_vendor_guard();

-- ── запросы на смену публичных контактов ────────────────────────────────────
-- Значения (телефон, Telegram) — только у ждущего запроса; API таблицу не видит (RLS без
-- политик, прав нет): всё — функциями ниже
create table pii.listing_contact_changes (
  id              uuid primary key default gen_random_uuid(),
  listing_id      uuid not null references app.listings on delete cascade,
  public_phone    text check (public_phone ~ '^\+998[0-9]{9}$'),
  public_telegram text check (public_telegram ~ '^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$'),
  status          text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  reason          text check (length(btrim(reason)) between 1 and 500),
  submitted_by    uuid references app.vendor_users on delete set null,
  decided_by      uuid references app.staff on delete set null,
  created_at      timestamptz not null default clock_timestamp(),
  decided_at      timestamptz,
  -- телефон — у ждущего (он обязателен), после решения значений нет
  constraint listing_contact_changes_values check ((status = 'pending') = (public_phone is not null)),
  constraint listing_contact_changes_telegram check (status = 'pending' or public_telegram is null),
  -- причина — только у отказа, и у него она обязательна
  constraint listing_contact_changes_reason check ((status = 'declined') = (reason is not null)),
  constraint listing_contact_changes_decided check ((status = 'pending') = (decided_at is null))
);
create unique index listing_contact_changes_one_pending on pii.listing_contact_changes (listing_id)
  where status = 'pending';
create index listing_contact_changes_listing on pii.listing_contact_changes (listing_id, created_at desc);

comment on table pii.listing_contact_changes is
  'Запрос партнёра на смену публичных контактов витрины, которая на проверке или на сайте: ждёт решения команды; значения — только пока ждёт';
comment on column pii.listing_contact_changes.public_phone is
  'Новый телефон витрины (только у ждущего запроса); читать — pii.read_listing_contact_change';
comment on column pii.listing_contact_changes.public_telegram is
  'Новый Telegram витрины, имя без @ (только у ждущего запроса); null — убрать; читать — pii.read_listing_contact_change';

alter table pii.listing_contact_changes enable row level security;
revoke all on pii.listing_contact_changes from public;

-- ── прямая запись партнёра: закрыта на витрине, которая на проверке или на сайте ─
-- Сотрудник и система пишут как раньше (одобрение запроса — от сотрудника)
create function app.listing_contacts_vendor_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing uuid := case when tg_op = 'DELETE' then old.listing_id else new.listing_id end;
begin
  if app.effective_actor() = 'vendor_user'
     and exists (select 1 from app.listings l
                 where l.id = v_listing and l.status in ('review', 'active', 'suspended')) then
    raise exception 'contacts_require_review' using errcode = 'BR036';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger listing_contacts_vendor_guard before insert or update or delete on pii.listing_contacts
  for each row execute function app.listing_contacts_vendor_guard();

-- Запись партнёра на витрине вне сайта: в журнал — какие поля (без значений); ждущий запрос
-- на смену контактов становится ненужным — витрина вышла с сайта, партнёр правит сам
create function app.listing_contacts_vendor_audit() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_fields text[] := '{}';
begin
  if app.effective_actor() is distinct from 'vendor_user' then
    return null;
  end if;
  if tg_op = 'INSERT' then
    v_fields := array_remove(array['phone', case when new.public_telegram is not null then 'telegram' end], null);
  else
    v_fields := array_remove(array[
      case when new.public_phone is distinct from old.public_phone then 'phone' end,
      case when new.public_telegram is distinct from old.public_telegram then 'telegram' end], null);
  end if;
  if cardinality(v_fields) = 0 then
    return null;
  end if;
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values (case tg_op when 'INSERT' then 'listing_contact.create' else 'listing_contact.update' end,
          'listing', new.listing_id::text, jsonb_build_object('fields', to_jsonb(v_fields)), 'vendor_cabinet');
  update pii.listing_contact_changes c
     set status = 'withdrawn', public_phone = null, public_telegram = null, decided_at = clock_timestamp()
   where c.listing_id = new.listing_id and c.status = 'pending';
  return null;
end $$;
create trigger listing_contacts_vendor_audit after insert or update on pii.listing_contacts
  for each row execute function app.listing_contacts_vendor_audit();

-- ── подать запрос (владелец кабинета) ───────────────────────────────────────
-- Новый запрос заменяет ждущий. Возвращает id запроса, а если новые значения не отличаются от
-- нынешних контактов — null (API: 422 no_changes). Телефон обязателен, Telegram — нет
create function app.vendor_submit_contact_change(p_listing uuid, p_phone text, p_telegram text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_status   app.listing_status;
  v_cur      pii.listing_contacts;
  v_fields   text[];
  v_id       uuid;
begin
  if app.actor_kind() is distinct from 'vendor_user' or not app.edits_listing(p_listing) then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if p_phone is null then
    raise exception 'invalid_argument' using errcode = '22023', detail = 'phone';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bayramm.listing_contacts:' || p_listing::text, 0));
  select l.status into v_status from app.listings l where l.id = p_listing;
  if not found then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  if v_status not in ('review', 'active', 'suspended') then
    raise exception 'contacts_not_live' using errcode = 'BR038';
  end if;

  select c.* into v_cur from pii.listing_contacts c where c.listing_id = p_listing;
  v_fields := array_remove(array[
    case when v_cur.listing_id is null or p_phone is distinct from v_cur.public_phone then 'phone' end,
    case when p_telegram is distinct from v_cur.public_telegram then 'telegram' end], null);
  if cardinality(v_fields) = 0 then
    return null;
  end if;

  -- Значения проверяют CHECK таблицы: 23514 → 422 invalid_input
  update pii.listing_contact_changes c
     set public_phone = p_phone, public_telegram = p_telegram, submitted_by = app.actor_id(), created_at = clock_timestamp()
   where c.listing_id = p_listing and c.status = 'pending'
  returning c.id into v_id;
  if v_id is null then
    insert into pii.listing_contact_changes (listing_id, public_phone, public_telegram, submitted_by)
    values (p_listing, p_phone, p_telegram, app.actor_id())
    returning id into v_id;
  end if;

  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('listing_contact_change.submit', 'listing', p_listing::text,
          jsonb_build_object('change_id', v_id, 'fields', to_jsonb(v_fields)), 'vendor_cabinet');
  perform app.enqueue_listing_alert('ops.contact_change_submitted', array['admin', 'moderator']::app.staff_role[],
                                    p_listing);
  return v_id;
end $$;

-- ── отозвать ждущий запрос (владелец кабинета) ──────────────────────────────
create function app.vendor_withdraw_contact_change(p_listing uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if app.actor_kind() is distinct from 'vendor_user' or not app.edits_listing(p_listing) then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bayramm.listing_contacts:' || p_listing::text, 0));
  update pii.listing_contact_changes c
     set status = 'withdrawn', public_phone = null, public_telegram = null, decided_at = clock_timestamp()
   where c.listing_id = p_listing and c.status = 'pending'
  returning c.id into v_id;
  if v_id is null then
    raise exception 'contact_change_not_pending' using errcode = 'BR037';
  end if;
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('listing_contact_change.withdraw', 'listing', p_listing::text,
          jsonb_build_object('change_id', v_id), 'vendor_cabinet');
end $$;

-- ── решение команды: администратор и модератор ──────────────────────────────
-- Одобрить: значения запроса — в pii.listing_contacts (телефон и Telegram целиком: Telegram
-- без значения убирает Telegram витрины), запрос — approved, значения стираются. Владельцам
-- кабинета — vendor.contact_change_decided
create function app.staff_approve_contact_change(p_listing uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_change pii.listing_contact_changes;
  v_cur    pii.listing_contacts;
  v_fields text[];
  v_vendor uuid;
begin
  perform app.assert_staff_role(array['admin', 'moderator']::app.staff_role[]);
  perform pg_advisory_xact_lock(hashtextextended('bayramm.listing_contacts:' || p_listing::text, 0));
  select c.* into v_change from pii.listing_contact_changes c
   where c.listing_id = p_listing and c.status = 'pending' for update;
  if not found then
    raise exception 'contact_change_not_pending' using errcode = 'BR037';
  end if;
  select c.* into v_cur from pii.listing_contacts c where c.listing_id = p_listing;
  v_fields := array_remove(array[
    case when v_cur.listing_id is null or v_change.public_phone is distinct from v_cur.public_phone then 'phone' end,
    case when v_change.public_telegram is distinct from v_cur.public_telegram then 'telegram' end], null);

  update pii.listing_contacts c
     set public_phone = v_change.public_phone, public_telegram = v_change.public_telegram
   where c.listing_id = p_listing;
  if not found then
    insert into pii.listing_contacts (listing_id, public_phone, public_telegram)
    values (p_listing, v_change.public_phone, v_change.public_telegram);
  end if;

  update pii.listing_contact_changes c
     set status = 'approved', public_phone = null, public_telegram = null,
         decided_by = app.actor_id(), decided_at = clock_timestamp()
   where c.id = v_change.id;
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('listing_contact_change.approve', 'listing', p_listing::text,
          jsonb_build_object('change_id', v_change.id, 'fields', to_jsonb(v_fields)), 'admin');
  select l.vendor_id into v_vendor from app.listings l where l.id = p_listing;
  perform app.enqueue_vendor_owner_notice(v_vendor, 'vendor.contact_change_decided',
    jsonb_build_object('listing_id', p_listing, 'decision', 'approved'), v_change.id::text);
end $$;

-- Отклонить — только с причиной (её видит партнёр): витрина остаётся с прежними контактами
create function app.staff_decline_contact_change(p_listing uuid, p_reason text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_id     uuid;
  v_vendor uuid;
begin
  perform app.assert_staff_role(array['admin', 'moderator']::app.staff_role[]);
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = 'BR010';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bayramm.listing_contacts:' || p_listing::text, 0));
  update pii.listing_contact_changes c
     set status = 'declined', reason = btrim(p_reason), public_phone = null, public_telegram = null,
         decided_by = app.actor_id(), decided_at = clock_timestamp()
   where c.listing_id = p_listing and c.status = 'pending'
  returning c.id into v_id;
  if v_id is null then
    raise exception 'contact_change_not_pending' using errcode = 'BR037';
  end if;
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('listing_contact_change.decline', 'listing', p_listing::text,
          jsonb_build_object('change_id', v_id), 'admin');
  select l.vendor_id into v_vendor from app.listings l where l.id = p_listing;
  perform app.enqueue_vendor_owner_notice(v_vendor, 'vendor.contact_change_decided',
    jsonb_build_object('listing_id', p_listing, 'decision', 'declined'), v_id::text);
end $$;

-- ── чтение ──────────────────────────────────────────────────────────────────
-- Значения ждущего запроса: администратор и модератор — и владелец этой витрины (свой запрос).
-- Каждое чтение — в журнал доступа к ПДн. Нет ждущего запроса — пусто
create function pii.read_listing_contact_change(p_listing uuid, p_reason text default null)
returns table (change_id uuid, phone text, telegram text, submitted_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  v_purpose text;
  v_row     pii.listing_contact_changes;
begin
  if app.actor_kind() = 'staff' then
    perform app.assert_staff_role(array['admin', 'moderator']::app.staff_role[]);
    v_purpose := 'staff_contact_change';
  elsif app.owns_listing(p_listing) then
    v_purpose := 'self_contact_change';
  else
    return;
  end if;
  select c.* into v_row from pii.listing_contact_changes c
   where c.listing_id = p_listing and c.status = 'pending';
  if not found then
    return;
  end if;
  perform app.log_pii_access('listing_contact', p_listing, v_purpose, p_reason);
  return query select v_row.id, v_row.public_phone, v_row.public_telegram, v_row.created_at;
end $$;

-- Последний запрос на смену контактов — без значений: статус, что в нём меняется (относительно
-- нынешних контактов, у ждущего), причина отказа, время. Сотруднику, системе и владельцу
-- (member тоже) витрины; не ПДн, в журнал не пишется
create function app.contact_change_state(p_listing uuid)
returns table (change_id uuid, status text, reason text, submitted_at timestamptz, decided_at timestamptz,
               phone_changed boolean, telegram_changed boolean)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (app.is_privileged() or app.owns_listing(p_listing)) then
    return;
  end if;
  return query
  select c.id, c.status, c.reason, c.created_at, c.decided_at,
         c.status = 'pending' and (k.listing_id is null or c.public_phone is distinct from k.public_phone),
         c.status = 'pending' and c.public_telegram is distinct from k.public_telegram
  from pii.listing_contact_changes c
  left join pii.listing_contacts k on k.listing_id = c.listing_id
  where c.listing_id = p_listing
  order by (c.status = 'pending') desc, coalesce(c.decided_at, c.created_at) desc, c.id
  limit 1;
end $$;

-- Очередь: ждущие запросы по времени подачи — без значений. Администратор и модератор
create function app.staff_contact_changes(p_limit int default 50, p_offset int default 0)
returns table (change_id uuid, listing_id uuid, listing_name text, listing_status app.listing_status,
               category_code text, vendor_id uuid, vendor_code text, submitted_at timestamptz,
               phone_changed boolean, telegram_changed boolean, total bigint)
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform app.assert_staff_role(array['admin', 'moderator']::app.staff_role[]);
  return query
  select c.id, l.id, l.name, l.status, l.category_code, v.id, v.public_code, c.created_at,
         k.listing_id is null or c.public_phone is distinct from k.public_phone,
         c.public_telegram is distinct from k.public_telegram,
         count(*) over ()
  from pii.listing_contact_changes c
  join app.listings l on l.id = c.listing_id
  join app.vendor_accounts v on v.id = l.vendor_id
  left join pii.listing_contacts k on k.listing_id = c.listing_id
  where c.status = 'pending'
  order by c.created_at, c.id
  limit greatest(1, least(coalesce(p_limit, 50), 200)) offset greatest(0, coalesce(p_offset, 0));
end $$;

comment on function app.vendor_submit_contact_change(uuid, text, text) is
  'Владелец кабинета просит сменить публичные контакты витрины, которая на проверке или на сайте; новый запрос заменяет ждущий; null — ничего не меняется';
comment on function app.staff_approve_contact_change(uuid) is
  'Одобрить ждущий запрос на смену контактов витрины: значения — в pii.listing_contacts (администратор, модератор)';
comment on function app.staff_decline_contact_change(uuid, text) is
  'Отклонить ждущий запрос на смену контактов витрины — только с причиной (администратор, модератор)';
comment on function pii.read_listing_contact_change(uuid, text) is
  'Значения ждущего запроса на смену контактов (администратор, модератор, владелец витрины); каждое чтение — в pii_access_log';

-- ── права ───────────────────────────────────────────────────────────────────
-- Триггерные функции API не вызывает; запросы к таблице — только этими функциями
revoke execute on all functions in schema app, pii from public;
grant execute on function
  app.vendor_submit_contact_change(uuid, text, text),
  app.vendor_withdraw_contact_change(uuid),
  app.staff_approve_contact_change(uuid),
  app.staff_decline_contact_change(uuid, text),
  pii.read_listing_contact_change(uuid, text),
  app.contact_change_state(uuid),
  app.staff_contact_changes(int, int)
  to bayramm_api;
