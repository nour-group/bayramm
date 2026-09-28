-- ════════════════════════════════════════════════════════════════════════════
-- Миграция 2 — ядро v0.1: люди, каталог, заявки, согласия, сессии, журналы,
-- outbox; инварианты в триггерах; RLS (fail-closed) и права bayramm_api.
--
-- Принципы:
--   · персональные данные (имена, телефоны, Telegram ID, СТИР, адреса физлиц)
--     лежат только в схеме `pii`; в `app` — псевдонимы (HMAC-хэши) и ссылки;
--   · телефоны не читаются через SELECT: у bayramm_api нет прав на эти столбцы,
--     только SECURITY DEFINER-функции pii.read_*, которые пишут pii_access_log;
--   · RLS по GUC app.actor_kind / app.actor_id / app.vendor_id:
--     нет актора — только публичные строки (активные листинги) и ноль заявок;
--   · журналы только на добавление: триггер + отсутствие прав UPDATE/DELETE;
--   · в v0.1 нет премиума, рекламы, подписок, отзывов и рейтингов.
--
-- Коды ошибок (SQLSTATE класса BR; API переводит их в HTTP):
--   BR001 append_only                        BR008 client_blocked
--   BR002 illegal_transition                 BR009 consent_required
--   BR003 forbidden_for_actor                BR010 reason_required
--   BR004 publish_blocked (detail — список)  BR011 too_many_photos
--   BR005 moderated_field_requires_revision  BR012 checklist_locked
--   BR006 immutable_column                   BR013 consent_text_not_current
--   BR007 listing_not_active
--   Дубликат заявки — 23505 (requests_client_listing_date_uq).
--
-- Время: все моменты — timestamptz (UTC); дата события и занятые дни — date,
-- «сегодня» по Asia/Tashkent считает приложение.
--
-- Откат: supabase/rollbacks/20260928120100_core.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── общие триггерные функции ────────────────────────────────────────────────
create function app.touch_updated_at() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Оператор и тексты согласий
-- ════════════════════════════════════════════════════════════════════════════

-- Юрлицо-оператор ПДн, от имени которого даётся согласие. Смена оператора —
-- новая версия текстов и повторное согласие
create table app.legal_entities (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) between 2 and 200),
  stir          char(9) unique check (stir ~ '^[0-9]{9}$'),
  registered_on date,
  created_at    timestamptz not null default now()
);

-- Версионированные тексты согласий: опубликованный текст не редактируется,
-- новая редакция — новая версия
create table app.consent_texts (
  id              uuid primary key default gen_random_uuid(),
  purpose         app.consent_purpose not null,
  version         int not null check (version > 0),
  locale          app.locale not null,
  legal_entity_id uuid references app.legal_entities,
  body            text not null check (length(btrim(body)) > 0),
  body_sha256     bytea not null,
  recipients      text[] not null default '{}',     -- названные получатели: хостинг, Telegram, SMS
  published_at    timestamptz not null default now(),
  retired_at      timestamptz,
  unique (purpose, version, locale),
  unique (id, purpose),                              -- цель для составного FK из consents
  check (retired_at is null or retired_at >= published_at)
);

create function app.consent_texts_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.body_sha256 := sha256(convert_to(new.body, 'UTF8'));
    return new;
  end if;
  -- у опубликованного текста можно менять только дату вывода из оборота
  if (new.id, new.purpose, new.version, new.locale, new.legal_entity_id, new.body,
      new.body_sha256, new.recipients, new.published_at)
     is distinct from
     (old.id, old.purpose, old.version, old.locale, old.legal_entity_id, old.body,
      old.body_sha256, old.recipients, old.published_at) then
    raise exception 'immutable_column' using errcode = 'BR006',
      detail = 'опубликованный текст согласия не меняется — выпустите новую версию';
  end if;
  return new;
end $$;

create trigger consent_texts_guard before insert or update on app.consent_texts
  for each row execute function app.consent_texts_guard();

-- ════════════════════════════════════════════════════════════════════════════
-- Люди
-- ════════════════════════════════════════════════════════════════════════════

-- Сотрудники. Вход — Cloudflare Access; API сопоставляет e-mail из JWT
-- с pii.staff_profiles под актором system. В v0.1 заводятся SQL-ом, UI команды нет
create table app.staff (
  id         uuid primary key default gen_random_uuid(),
  role       app.staff_role not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table pii.staff_profiles (
  staff_id         uuid primary key references app.staff on delete cascade,
  email            text not null check (email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  display_name     text not null check (length(btrim(display_name)) between 1 and 80),
  telegram_chat_id bigint,                       -- для оповещений ops
  updated_at       timestamptz not null default now()
);
create unique index staff_profiles_email_uq on pii.staff_profiles (lower(email));

-- Клиенты — псевдонимно: ключ — HMAC(ID_HASH_KEY, Telegram user id)
create table app.clients (
  id             uuid primary key default gen_random_uuid(),
  tg_id_hash     bytea not null unique check (octet_length(tg_id_hash) = 32),
  locale         app.locale not null default 'uz',
  can_message    boolean not null default false,  -- бот может писать (allows_write_to_pm / /start)
  blocked_at     timestamptz,
  blocked_reason text check (length(btrim(blocked_reason)) between 1 and 500),
  blocked_by     uuid references app.staff,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_seen_at   timestamptz,
  check ((blocked_at is null) = (blocked_reason is null))
);

create table pii.client_profiles (
  client_id         uuid primary key references app.clients on delete cascade,
  telegram_id       bigint not null unique,
  first_name        text check (length(first_name) <= 128),
  last_name         text check (length(last_name) <= 128),
  username          text check (username ~ '^[A-Za-z0-9_]{4,32}$'),
  phone             text check (phone ~ '^\+998[0-9]{9}$'),
  phone_verified_at timestamptz,
  updated_at        timestamptz not null default now()
);

-- Аккаунт вендора (компания): 1 — N листингов
create sequence app.vendor_code_seq start 101;

create table app.vendor_accounts (
  id                    uuid primary key default gen_random_uuid(),
  public_code           text not null unique default ('V' || nextval('app.vendor_code_seq')),
  legal_form            app.legal_form,
  manager_id            uuid references app.staff,
  -- ручной чек-лист проверки перед публикацией; каждое изменение API пишет в audit_log
  contract_no           text check (length(btrim(contract_no)) between 1 and 64),
  contract_signed_at    timestamptz,
  contract_checked_by   uuid references app.staff,
  stir_verified_at      timestamptz,             -- сверка с реестром; скан не храним
  stir_verified_by      uuid references app.staff,
  contacts_confirmed_at timestamptz,             -- подтверждено звонком
  contacts_confirmed_by uuid references app.staff,
  pd_consent_signed_at  timestamptz,
  pd_consent_checked_by uuid references app.staff,
  pd_consent_text_id    uuid references app.consent_texts,  -- версия текста и юрлицо оператора
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check ((pd_consent_signed_at is null) = (pd_consent_text_id is null))
);

-- Реквизиты и контакты вендора. У ЯТТ юрназвание и СТИР — данные физлица
create table pii.vendor_contacts (
  vendor_id         uuid primary key references app.vendor_accounts on delete cascade,
  legal_name        text check (length(btrim(legal_name)) between 1 and 200),
  stir              char(9) unique check (stir ~ '^[0-9]{9}$'),
  legal_address     text check (length(legal_address) <= 300),
  contact_person    text check (length(btrim(contact_person)) between 1 and 120),
  contact_role      text check (length(contact_role) <= 80),
  phone             text check (phone ~ '^\+998[0-9]{9}$'),
  phone_alt         text check (phone_alt ~ '^\+998[0-9]{9}$'),
  telegram_username text check (telegram_username ~ '^@?[A-Za-z0-9_]{5,32}$'),
  updated_at        timestamptz not null default now()
);

-- Пользователи кабинета вендора (вход по телефону/Telegram). Ключи — HMAC
create table app.vendor_users (
  id            uuid primary key default gen_random_uuid(),
  vendor_id     uuid not null references app.vendor_accounts,
  phone_hash    bytea not null unique check (octet_length(phone_hash) = 32),
  tg_user_hash  bytea unique check (octet_length(tg_user_hash) = 32),
  role          text not null default 'owner' check (role in ('owner', 'member')),
  locale        app.locale not null default 'uz',
  tg_linked_at  timestamptz,
  last_login_at timestamptz,
  disabled_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index vendor_users_vendor on app.vendor_users (vendor_id);

create table pii.vendor_user_profiles (
  vendor_user_id   uuid primary key references app.vendor_users on delete cascade,
  phone            text not null check (phone ~ '^\+998[0-9]{9}$'),
  full_name        text check (length(btrim(full_name)) between 1 and 120),
  telegram_user_id bigint unique,
  telegram_chat_id bigint,
  updated_at       timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════════════════
-- Каталог
-- ════════════════════════════════════════════════════════════════════════════

-- Листинг = одна площадка/зал. Цены — целые сумы, единица — price_unit
create table app.listings (
  id                uuid primary key default gen_random_uuid(),
  vendor_id         uuid not null references app.vendor_accounts,
  slug              text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  category_code     text not null references app.categories,
  status            app.listing_status not null default 'draft',
  status_reason     text check (length(btrim(status_reason)) between 1 and 1000),
  status_changed_at timestamptz,
  status_changed_by uuid,
  name              text not null check (length(btrim(name)) between 2 and 80),
  district_code     text references app.districts,
  address_ru        text check (length(address_ru) <= 300),
  address_uz        text check (length(address_uz) <= 300),
  description_ru    text check (length(description_ru) <= 4000),
  description_uz    text check (length(description_uz) <= 4000),
  price_from_uzs    bigint check (price_from_uzs between 1 and 99999999999),
  price_unit        app.price_unit not null default 'per_guest',
  cap_min           int check (cap_min between 1 and 5000),
  cap_max           int check (cap_max between 1 and 5000),
  submitted_at      timestamptz,
  published_at      timestamptz,
  version           int not null default 1,          -- оптимистичная блокировка (ETag / If-Match)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint listings_capacity_range check (cap_min is null or cap_max is null or cap_max >= cap_min),
  -- приостановка и отклонение — только с причиной
  constraint listings_reason_required check ((status in ('suspended', 'rejected')) = (status_reason is not null)),
  -- без цены и вместимости листинг не бывает на проверке или опубликованным
  constraint listings_price_required check (status not in ('review', 'active', 'suspended') or price_from_uzs is not null),
  constraint listings_capacity_required check (status not in ('review', 'active', 'suspended') or cap_max is not null)
);
-- Индексы каталога: только активные листинги
create index listings_vendor on app.listings (vendor_id);
create index listings_catalog_district on app.listings (category_code, district_code) where status = 'active';
create index listings_catalog_capacity on app.listings (category_code, cap_max) where status = 'active';
create index listings_catalog_price on app.listings (category_code, price_from_uzs, id) where status = 'active';

-- Телефон «для заявок», который клиент видит сразу (правило продукта).
-- Часто это личный номер администратора — поэтому в pii
create table pii.listing_contacts (
  listing_id   uuid primary key references app.listings on delete cascade,
  public_phone text not null check (public_phone ~ '^\+998[0-9]{9}$'),
  updated_at   timestamptz not null default now()
);

-- Пакеты цен. Для залов обязательны «будни» и «выходные»
create table app.listing_packages (
  id         uuid primary key default gen_random_uuid(),
  listing_id uuid not null references app.listings on delete cascade,
  kind       app.package_kind not null,
  name_ru    text not null check (length(btrim(name_ru)) between 1 and 80),
  name_uz    text not null check (length(btrim(name_uz)) between 1 and 80),
  price_uzs  bigint not null check (price_uzs between 1 and 99999999999),
  price_unit app.price_unit not null default 'per_guest',
  sort       smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index listing_packages_listing on app.listing_packages (listing_id, sort);
create unique index listing_packages_day_kind on app.listing_packages (listing_id, kind)
  where kind in ('weekday', 'weekend');

-- Фото: приватный оригинал в R2, публичные варианты WebP без EXIF
create table app.photos (
  id             uuid primary key default gen_random_uuid(),
  listing_id     uuid not null references app.listings on delete cascade,
  status         app.photo_status not null default 'uploading',
  moderation     app.moderation_status not null default 'pending' check (moderation <> 'withdrawn'),
  storage_key    text not null check (length(storage_key) between 1 and 300),
  public_prefix  text check (length(public_prefix) between 1 and 300),
  mime           text check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  bytes          int check (bytes between 1 and 20971520),
  width          int check (width > 0),
  height         int check (height > 0),
  sha256         bytea check (octet_length(sha256) = 32),
  sort           smallint not null default 0,
  is_cover       boolean not null default false,
  no_faces_ack   boolean not null check (no_faces_ack),   -- вендор подтверждает: на фото нет лиц
  failure_reason text check (length(failure_reason) <= 500),
  uploaded_by    uuid,
  moderated_by   uuid references app.staff,
  moderated_at   timestamptz,
  processed_at   timestamptz,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  check (status <> 'ready' or public_prefix is not null)
);
create index photos_listing on app.photos (listing_id, sort) where deleted_at is null;
create unique index photos_one_cover on app.photos (listing_id) where is_cover and deleted_at is null;
create unique index photos_dedupe on app.photos (listing_id, sha256) where deleted_at is null;

-- Правки модерируемых полей опубликованного листинга:
-- клиент видит одобренную версию, пока ревизия на модерации
create function app.revision_payload_ok(p_payload jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(p_payload) = 'object'
     and p_payload <> '{}'::jsonb
     and not exists (
       select 1 from jsonb_object_keys(p_payload) k
       where k not in ('name', 'price_from_uzs', 'price_unit', 'description_ru', 'description_uz', 'packages'))
$$;

create table app.listing_revisions (
  id              uuid primary key default gen_random_uuid(),
  listing_id      uuid not null references app.listings on delete cascade,
  payload         jsonb not null check (app.revision_payload_ok(payload)),
  base_version    int not null,                  -- версия листинга, от которой считалась правка
  status          app.moderation_status not null default 'pending',
  submitted_by    uuid,
  submitted_at    timestamptz not null default now(),
  decided_by      uuid references app.staff,
  decided_at      timestamptz,
  decision_reason text check (length(btrim(decision_reason)) between 1 and 1000),
  check (status <> 'declined' or decision_reason is not null),
  check ((status in ('approved', 'declined')) = (decided_at is not null))
);
-- одна открытая ревизия на листинг: новые правки сливаются в неё
create unique index listing_revisions_one_pending on app.listing_revisions (listing_id) where status = 'pending';
create index listing_revisions_queue on app.listing_revisions (submitted_at) where status = 'pending';

-- ════════════════════════════════════════════════════════════════════════════
-- Согласия (журнал только на добавление)
-- ════════════════════════════════════════════════════════════════════════════
create table app.consents (
  id               uuid primary key default gen_random_uuid(),
  subject_kind     app.actor_kind not null check (subject_kind in ('client', 'vendor_user')),
  subject_id       uuid not null,                  -- псевдонимный id, переживает удаление аккаунта
  purpose          app.consent_purpose not null,
  action           app.consent_action not null,
  text_id          uuid not null,
  scope_listing_id uuid references app.listings,   -- request_transfer — всегда на конкретный листинг
  source           app.source not null,
  recorded_by      uuid references app.staff,      -- офлайн-согласие, внесённое сотрудником
  ip_hash          bytea check (octet_length(ip_hash) = 32),
  created_at       timestamptz not null default clock_timestamp(),
  foreign key (text_id, purpose) references app.consent_texts (id, purpose),
  check ((purpose = 'request_transfer') = (scope_listing_id is not null))
);
create index consents_subject on app.consents (subject_kind, subject_id, purpose, scope_listing_id, created_at desc);

-- Текущее состояние: последнее событие по (субъект, цель, листинг)
create view app.consents_current with (security_invoker = true) as
  select distinct on (subject_kind, subject_id, purpose, scope_listing_id) *
  from app.consents
  order by subject_kind, subject_id, purpose, scope_listing_id, created_at desc;

-- ════════════════════════════════════════════════════════════════════════════
-- Заявки
-- ════════════════════════════════════════════════════════════════════════════
create table app.requests (
  id                uuid primary key default gen_random_uuid(),
  public_no         bigint generated always as identity (start with 1001) unique,
  client_id         uuid not null references app.clients,
  listing_id        uuid not null references app.listings,
  vendor_id         uuid not null references app.vendor_accounts,  -- из листинга, триггером (для RLS и входящих)
  consent_id        uuid not null references app.consents,         -- согласие на передачу контактов этому листингу
  occasion_code     text not null references app.occasions,
  event_date        date not null,
  guests            int not null check (guests between 1 and 5000),
  budget_min_uzs    bigint check (budget_min_uzs >= 0),
  budget_max_uzs    bigint check (budget_max_uzs > 0),
  status            app.request_status not null default 'new',
  decline_reason    app.decline_reason,
  decline_note      text check (length(decline_note) <= 500),
  source            app.source not null check (source in ('tma', 'web', 'admin')),
  sla_due_at        timestamptz not null,          -- created_at + sla_hours, фиксируется при создании
  sla_stage         smallint not null default 0 check (sla_stage between 0 and 3),
  sla_breached_at   timestamptz,
  first_viewed_at   timestamptz,
  first_response_at timestamptz,                   -- ставится один раз, «вернуть в активные» не сбрасывает
  first_response_by app.actor_kind,                -- staff — отметка оператора, не в метрике вендора
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (budget_max_uzs is null or budget_min_uzs is null or budget_max_uzs >= budget_min_uzs),
  check ((status = 'declined') = (decline_reason is not null)),
  check ((first_response_at is null) = (first_response_by is null))
);
-- Одна заявка клиента на листинг и дату. Отозванная не мешает подать заново
create unique index requests_client_listing_date_uq on app.requests (client_id, listing_id, event_date)
  where status <> 'withdrawn';
create index requests_vendor_inbox on app.requests (vendor_id, status, created_at desc);
create index requests_client_list on app.requests (client_id, created_at desc);
create index requests_listing_date on app.requests (listing_id, event_date);
create index requests_sla_open on app.requests (sla_due_at)
  where first_response_at is null and status in ('new', 'viewed');
create index requests_open_by_date on app.requests (event_date) where status in ('new', 'viewed', 'contacted');

-- Ровно то, что клиент согласился передать вендору
create table pii.request_contacts (
  request_id    uuid primary key references app.requests on delete cascade,
  contact_name  text check (length(btrim(contact_name)) between 1 and 80),
  contact_phone text check (contact_phone ~ '^\+998[0-9]{9}$'),
  comment       text check (length(comment) <= 1000),
  created_at    timestamptz not null default now(),
  purged_at     timestamptz,                       -- ретенция: через N дней после события
  check (purged_at is not null or (contact_name is not null and contact_phone is not null))
);

-- Разрешённые переходы статусов заявки и кто их делает.
-- Нажатие на телефон — событие call_attempt в audit_log, статус не меняет
create table app.request_transitions (
  from_status app.request_status not null,
  to_status   app.request_status not null,
  actor       app.actor_kind not null,
  primary key (from_status, to_status, actor),
  check (from_status <> to_status)
);
insert into app.request_transitions (from_status, to_status, actor) values
  ('new',       'viewed',    'vendor_user'),
  ('new',       'viewed',    'system'),
  ('new',       'contacted', 'vendor_user'),
  ('viewed',    'contacted', 'vendor_user'),
  ('new',       'contacted', 'staff'),         -- отметка оператора (source = admin)
  ('viewed',    'contacted', 'staff'),
  ('new',       'declined',  'vendor_user'),
  ('viewed',    'declined',  'vendor_user'),
  ('contacted', 'declined',  'vendor_user'),
  ('contacted', 'deal',      'vendor_user'),
  ('deal',      'contacted', 'vendor_user'),     -- «Вернуть в активные»
  ('declined',  'contacted', 'vendor_user'),
  ('new',       'withdrawn', 'client'),
  ('viewed',    'withdrawn', 'client'),
  ('contacted', 'withdrawn', 'client'),
  ('new',       'expired',   'system'),          -- дата события прошла без итога
  ('viewed',    'expired',   'system'),
  ('contacted', 'expired',   'system');

-- История статусов: пишется только триггером, изменить нельзя
create table app.request_status_log (
  id          bigint generated always as identity primary key,
  request_id  uuid not null references app.requests,   -- без каскада: журнал не удаляется с заявкой
  from_status app.request_status,
  to_status   app.request_status not null,
  actor_kind  app.actor_kind not null,
  actor_id    uuid,
  source      app.source not null,
  reason      text check (length(reason) <= 1000),
  at          timestamptz not null default clock_timestamp()
);
create index request_status_log_request on app.request_status_log (request_id, at);

-- Занятые дни. Строка = день занят; нет строки — свободен по базовой цене.
-- Цены по дням в v0.1 нет: цена меняется только через модерацию
create table app.availability (
  listing_id uuid not null references app.listings on delete cascade,
  day        date not null,
  source     text not null default 'vendor' check (source in ('vendor', 'request_decline', 'staff')),
  request_id uuid references app.requests,
  created_by uuid default app.actor_id(),
  created_at timestamptz not null default now(),
  primary key (listing_id, day)
);
create index availability_day on app.availability (day, listing_id);

-- ════════════════════════════════════════════════════════════════════════════
-- Аутентификация
-- ════════════════════════════════════════════════════════════════════════════

-- Непрозрачные токены: храним только sha256(токена)
create table app.sessions (
  id             uuid primary key default gen_random_uuid(),
  token_hash     bytea not null unique check (octet_length(token_hash) = 32),
  client_id      uuid references app.clients,
  vendor_user_id uuid references app.vendor_users,
  via            text not null check (via in ('tg_client', 'tg_partner', 'sms_otp')),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  last_seen_at   timestamptz,
  revoked_at     timestamptz,
  ip_hash        bytea check (octet_length(ip_hash) = 32),
  check (num_nonnulls(client_id, vendor_user_id) = 1),
  check ((via = 'tg_client') = (client_id is not null)),
  check (expires_at > created_at)
);
create index sessions_expires on app.sessions (expires_at);
create index sessions_client on app.sessions (client_id) where client_id is not null;
create index sessions_vendor_user on app.sessions (vendor_user_id) where vendor_user_id is not null;

-- Одноразовые коды входа вендора. Код — HMAC(OTP_HASH_KEY, код), телефон — HMAC
create table app.otp_codes (
  id              uuid primary key default gen_random_uuid(),
  phone_hash      bytea not null check (octet_length(phone_hash) = 32),
  code_hash       bytea not null check (octet_length(code_hash) = 32),
  provider        text not null check (provider in ('eskiz', 'playmobile', 'tg_gateway', 'console')),
  provider_msg_id text check (length(provider_msg_id) <= 200),
  attempts        smallint not null default 0 check (attempts between 0 and 5),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  ip_hash         bytea check (octet_length(ip_hash) = 32),
  check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')
);
create index otp_codes_phone on app.otp_codes (phone_hash, created_at desc);
create index otp_codes_created on app.otp_codes (created_at);

-- ════════════════════════════════════════════════════════════════════════════
-- Журналы и уведомления
-- ════════════════════════════════════════════════════════════════════════════

-- Журнал действий: только INSERT; актор берётся из GUC и подделан быть не может
create table app.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default clock_timestamp(),
  actor_kind  app.actor_kind not null default app.effective_actor(),
  actor_id    uuid default app.actor_id(),
  action      text not null check (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),  -- listing.suspend, request.call_attempt
  object_type text not null check (object_type ~ '^[a-z][a-z_]{1,39}$'),
  object_id   text not null check (length(object_id) between 1 and 100),
  detail      jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),  -- без ПДн: только id и коды
  source      app.source,
  ip_hash     bytea check (octet_length(ip_hash) = 32),
  trace_id    text check (length(trace_id) <= 100)
);
create index audit_log_object on app.audit_log (object_type, object_id, at desc);
create index audit_log_actor on app.audit_log (actor_kind, actor_id, at desc);

-- Кто и зачем читал телефоны. Пишут только функции pii.read_*
create table app.pii_access_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default clock_timestamp(),
  actor_kind   app.actor_kind not null,
  actor_id     uuid,
  subject_kind text not null check (subject_kind in
                 ('client', 'request_contact', 'vendor_contact', 'vendor_user', 'listing_contact')),
  subject_id   uuid not null,
  field        text not null check (field in ('phone')),
  purpose      text not null check (length(purpose) between 1 and 60),
  reason       text check (length(reason) <= 500)
);
create index pii_access_log_subject on app.pii_access_log (subject_kind, subject_id, at desc);
create index pii_access_log_actor on app.pii_access_log (actor_kind, actor_id, at desc);

-- Транзакционный outbox → Queue. В payload только идентификаторы, без ПДн
create table app.outbox (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),  -- vendor.request_new …
  channel         app.notify_channel not null default 'telegram',
  recipient_kind  app.actor_kind not null,
  recipient_id    uuid,
  request_id      uuid references app.requests,
  payload         jsonb not null default '{}' check (jsonb_typeof(payload) = 'object'),
  dedupe_key      text unique check (length(dedupe_key) between 1 and 200),
  status          app.outbox_status not null default 'pending',
  attempts        smallint not null default 0 check (attempts between 0 and 50),
  next_attempt_at timestamptz not null default now(),
  enqueued_at     timestamptz,
  sent_at         timestamptz,
  last_error      text check (length(last_error) <= 2000),
  provider_msg_id text check (length(provider_msg_id) <= 200),
  created_at      timestamptz not null default now()
);
create index outbox_due on app.outbox (next_attempt_at) where status in ('pending', 'failed');
create index outbox_request on app.outbox (request_id) where request_id is not null;

-- ════════════════════════════════════════════════════════════════════════════
-- Функции видимости (для политик RLS; SECURITY DEFINER, чтобы не вкладывать RLS в RLS)
-- ════════════════════════════════════════════════════════════════════════════

-- Листинг принадлежит вендору текущего актора
create function app.owns_listing(p_listing uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(app.actor_kind() = 'vendor_user' and exists (
    select 1 from app.listings l where l.id = p_listing and l.vendor_id = app.actor_vendor_id()), false)
$$;

-- Листинг опубликован (виден гостям)
create function app.listing_is_public(p_listing uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from app.listings l where l.id = p_listing and l.status = 'active') $$;

-- Роль текущего сотрудника (null — не сотрудник или отключён)
create function app.current_staff_role() returns app.staff_role
language sql stable security definer set search_path = ''
as $$
  select s.role from app.staff s
  where app.actor_kind() = 'staff' and s.id = app.actor_id() and s.active
$$;

-- Уточнение функции из миграции 1: актор staff привилегирован, только если
-- app.actor_id — действующий сотрудник. Одного GUC «staff» недостаточно
create or replace function app.is_privileged() returns boolean
language sql stable security definer set search_path = ''
as $$
  select case app.actor_kind()
    when 'system' then true
    when 'staff' then app.current_staff_role() is not null
    else false
  end
$$;

-- Согласие клиента на передачу контактов по заявке действует (не отозвано)
create function app.request_consent_active(p_request uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select cur.action = 'grant'
    from app.requests r
    join app.consents g on g.id = r.consent_id
    cross join lateral (
      select c.action from app.consents c
      where c.subject_kind = g.subject_kind and c.subject_id = g.subject_id
        and c.purpose = g.purpose and c.scope_listing_id = g.scope_listing_id
      order by c.created_at desc
      limit 1) cur
    where r.id = p_request), false)
$$;

-- Заявка видна актору: вендору-адресату, клиенту-автору, staff/system
create function app.can_see_request(p_request uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case app.actor_kind()
    when 'staff' then true
    when 'system' then true
    when 'client' then exists (
      select 1 from app.requests r where r.id = p_request and r.client_id = app.actor_id())
    when 'vendor_user' then exists (
      select 1 from app.requests r where r.id = p_request and r.vendor_id = app.actor_vendor_id())
    else false
  end
$$;

-- Контакты из заявки: вендор видит их, только пока согласие действует
-- и заявка не отозвана: вендор видит ровно то, на что дано согласие
create function app.can_see_request_contact(p_request uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case app.actor_kind()
    when 'staff' then true
    when 'system' then true
    when 'client' then exists (
      select 1 from app.requests r where r.id = p_request and r.client_id = app.actor_id())
    when 'vendor_user' then exists (
      select 1 from app.requests r
      where r.id = p_request and r.vendor_id = app.actor_vendor_id() and r.status <> 'withdrawn')
      and app.request_consent_active(p_request)
    else false
  end
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Публикация листинга
-- ════════════════════════════════════════════════════════════════════════════

-- Чего не хватает для перехода в review/active. Объединение правил продукта
-- (цена, ≥ 3 фото, телефон, описания) и ручной проверки вендора: непроверенный
-- вендор не публикуется.
-- Для review фото достаточно обработанных, для active — одобренных модератором.
-- Принимает строку целиком, чтобы триггер проверял новые значения.
create function app.listing_publish_blockers(p_listing app.listings, p_target app.listing_status)
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

-- То же по id — для экрана готовности («чего не хватает»). Чужой листинг — null
create function app.listing_publish_blockers(p_listing_id uuid, p_target app.listing_status default 'active')
returns text[]
language sql stable security definer set search_path = ''
as $$
  select app.listing_publish_blockers(l, p_target)
  from app.listings l
  where l.id = p_listing_id and (app.is_privileged() or app.owns_listing(l.id))
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Триггеры: люди
-- ════════════════════════════════════════════════════════════════════════════

-- Клиент меняет у себя только язык, разрешение писать и удаление аккаунта
create function app.clients_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.id <> old.id or new.tg_id_hash <> old.tg_id_hash or new.created_at <> old.created_at then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;
  if app.actor_kind() = 'client'
     and (new.blocked_at, new.blocked_reason, new.blocked_by)
         is distinct from (old.blocked_at, old.blocked_reason, old.blocked_by) then
    raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'блокировку снимает только сотрудник';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger clients_guard before update on app.clients
  for each row execute function app.clients_guard();

-- Вендор меняет в своей учётке только язык; остальное — вход, привязка, сотрудники
create function app.vendor_users_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.id <> old.id or new.vendor_id <> old.vendor_id or new.created_at <> old.created_at then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;
  if app.actor_kind() = 'vendor_user'
     and (new.phone_hash, new.tg_user_hash, new.role, new.tg_linked_at, new.last_login_at, new.disabled_at)
         is distinct from
         (old.phone_hash, old.tg_user_hash, old.role, old.tg_linked_at, old.last_login_at, old.disabled_at) then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger vendor_users_guard before update on app.vendor_users
  for each row execute function app.vendor_users_guard();

-- Чек-лист активации: согласие ПДн — текст цели vendor_contact; снять отметку
-- нельзя, пока у вендора есть опубликованные листинги, — сначала приостановить
create function app.vendor_accounts_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.pd_consent_text_id is not null and not exists (
       select 1 from app.consent_texts t where t.id = new.pd_consent_text_id and t.purpose = 'vendor_contact') then
    raise exception 'consent_required' using errcode = 'BR009',
      detail = 'pd_consent_text_id должен ссылаться на текст цели vendor_contact';
  end if;
  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.public_code <> old.public_code or new.created_at <> old.created_at then
      raise exception 'immutable_column' using errcode = 'BR006';
    end if;
    if ((old.contract_signed_at is not null and new.contract_signed_at is null)
        or (old.stir_verified_at is not null and new.stir_verified_at is null)
        or (old.contacts_confirmed_at is not null and new.contacts_confirmed_at is null)
        or (old.pd_consent_signed_at is not null and new.pd_consent_signed_at is null))
       and exists (select 1 from app.listings l where l.vendor_id = new.id and l.status = 'active') then
      raise exception 'checklist_locked' using errcode = 'BR012',
        detail = 'сначала приостановите опубликованные листинги';
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger vendor_accounts_guard before insert or update on app.vendor_accounts
  for each row execute function app.vendor_accounts_guard();

create trigger staff_touch before update on app.staff
  for each row execute function app.touch_updated_at();
create trigger staff_profiles_touch before update on pii.staff_profiles
  for each row execute function app.touch_updated_at();
create trigger client_profiles_touch before update on pii.client_profiles
  for each row execute function app.touch_updated_at();
create trigger vendor_contacts_touch before update on pii.vendor_contacts
  for each row execute function app.touch_updated_at();
create trigger vendor_user_profiles_touch before update on pii.vendor_user_profiles
  for each row execute function app.touch_updated_at();

-- ════════════════════════════════════════════════════════════════════════════
-- Триггеры: каталог
-- ════════════════════════════════════════════════════════════════════════════

-- Листинг рождается в lead (staff) или draft; сразу на проверку или в каталог — нельзя
create function app.listings_before_insert() returns trigger
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
create trigger listings_before_insert before insert on app.listings
  for each row execute function app.listings_before_insert();

-- Переходы статусов, защита публикации, модерируемые поля
create function app.listings_before_update() returns trigger
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

  -- После отправки на проверку вендор меняет цену, название и описания только
  -- через listing_revisions: клиент видит одобренную версию
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
create trigger listings_before_update before update on app.listings
  for each row execute function app.listings_before_update();

-- Пакеты цен опубликованного листинга — модерируемые данные
create function app.listing_packages_guard() returns trigger
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
create trigger listing_packages_guard before insert or update or delete on app.listing_packages
  for each row execute function app.listing_packages_guard();

-- После удаления/смены вида пакета опубликованный зал не должен остаться без
-- цен будней и выходных
create function app.listing_packages_keep_ready() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing app.listings;
begin
  select l.* into v_listing from app.listings l where l.id = old.listing_id;
  if found and v_listing.status in ('review', 'active')
     and 'packages' = any (app.listing_publish_blockers(v_listing, v_listing.status)) then
    raise exception 'publish_blocked' using errcode = 'BR004', detail = 'packages';
  end if;
  return null;
end $$;
create trigger listing_packages_keep_ready after update of kind, listing_id or delete on app.listing_packages
  for each row execute function app.listing_packages_keep_ready();

-- Телефон опубликованного листинга удалить нельзя (правило «телефон виден сразу»)
create function app.listing_contacts_keep_ready() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from app.listings l where l.id = old.listing_id and l.status in ('review', 'active')) then
    raise exception 'publish_blocked' using errcode = 'BR004', detail = 'phone';
  end if;
  return null;
end $$;
create trigger listing_contacts_keep_ready after delete on pii.listing_contacts
  for each row execute function app.listing_contacts_keep_ready();
create trigger listing_contacts_touch before update on pii.listing_contacts
  for each row execute function app.touch_updated_at();

-- Фото: лимит на листинг; вендор не одобряет свои фото и не меняет результат обработки
create function app.photos_guard() returns trigger
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
     and (new.status, new.moderation, new.public_prefix, new.mime, new.bytes, new.width, new.height,
          new.sha256, new.failure_reason, new.processed_at, new.moderated_by, new.moderated_at)
         is distinct from
         (old.status, old.moderation, old.public_prefix, old.mime, old.bytes, old.width, old.height,
          old.sha256, old.failure_reason, old.processed_at, old.moderated_by, old.moderated_at) then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if new.moderation is distinct from old.moderation then
    new.moderated_at := now();
    new.moderated_by := case when v_actor = 'staff' then app.actor_id() end;
  end if;
  return new;
end $$;
create trigger photos_guard before insert or update on app.photos
  for each row execute function app.photos_guard();

-- Опубликованный листинг не может остаться меньше чем с min_photos фото.
-- Проверяем только когда изменение убрало фото из зачёта — повышение
-- min_photos не ломает правки у уже опубликованных листингов
create function app.photos_keep_ready() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing  app.listings;
  v_old_ok   boolean;
  v_new_ok   boolean;
begin
  select l.* into v_listing from app.listings l where l.id = old.listing_id;
  if not found or v_listing.status not in ('review', 'active') then
    return null;
  end if;
  v_old_ok := old.deleted_at is null and old.status = 'ready'
              and (v_listing.status = 'review' or old.moderation = 'approved');
  v_new_ok := tg_op = 'UPDATE' and new.deleted_at is null and new.status = 'ready'
              and (v_listing.status = 'review' or new.moderation = 'approved');
  if v_old_ok and not v_new_ok
     and 'photos' = any (app.listing_publish_blockers(v_listing, v_listing.status)) then
    raise exception 'publish_blocked' using errcode = 'BR004', detail = 'photos';
  end if;
  return null;
end $$;
create trigger photos_keep_ready after update or delete on app.photos
  for each row execute function app.photos_keep_ready();

-- Ревизии: вендор подаёт и отзывает, решение — только сотрудник
create function app.listing_revisions_guard() returns trigger
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
create trigger listing_revisions_guard before insert or update on app.listing_revisions
  for each row execute function app.listing_revisions_guard();

-- ════════════════════════════════════════════════════════════════════════════
-- Триггеры: согласия и заявки
-- ════════════════════════════════════════════════════════════════════════════

-- Время согласия — серверное; давать согласие можно только по действующему тексту
create function app.consents_before_insert() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.created_at := clock_timestamp();
  new.recorded_by := case when app.actor_kind() = 'staff' then app.actor_id() end;
  if new.action = 'grant' and not exists (
       select 1 from app.consent_texts t
       where t.id = new.text_id and t.published_at <= now()
         and (t.retired_at is null or t.retired_at > now())) then
    raise exception 'consent_text_not_current' using errcode = 'BR013';
  end if;
  return new;
end $$;
create trigger consents_before_insert before insert on app.consents
  for each row execute function app.consents_before_insert();

-- Создание заявки: только на активный листинг, от незаблокированного клиента,
-- с действующим согласием на передачу контактов именно этому листингу.
-- SLA фиксируется в момент создания
create function app.requests_before_insert() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_consent app.consents;
begin
  if new.status <> 'new' then
    raise exception 'illegal_transition' using errcode = 'BR002', detail = 'заявка создаётся в статусе new';
  end if;

  select l.vendor_id into new.vendor_id from app.listings l where l.id = new.listing_id and l.status = 'active';
  if not found then
    raise exception 'listing_not_active' using errcode = 'BR007';
  end if;

  if not exists (select 1 from app.clients c
                 where c.id = new.client_id and c.blocked_at is null and c.deleted_at is null) then
    raise exception 'client_blocked' using errcode = 'BR008';
  end if;

  select c.* into v_consent from app.consents c where c.id = new.consent_id;
  if not found
     or v_consent.subject_kind <> 'client' or v_consent.subject_id <> new.client_id
     or v_consent.purpose <> 'request_transfer' or v_consent.action <> 'grant'
     or v_consent.scope_listing_id <> new.listing_id
     or exists (select 1 from app.consents w       -- после этого согласия был отзыв
                where w.subject_kind = 'client' and w.subject_id = new.client_id
                  and w.purpose = 'request_transfer' and w.scope_listing_id = new.listing_id
                  and w.action = 'withdraw' and w.created_at > v_consent.created_at) then
    raise exception 'consent_required' using errcode = 'BR009';
  end if;

  new.created_at := now();
  new.updated_at := now();
  new.sla_due_at := now() + make_interval(hours => coalesce(app.setting_int('sla_hours'), 12));
  new.sla_stage := 0;
  new.sla_breached_at := null;
  new.first_viewed_at := null;
  new.first_response_at := null;
  new.first_response_by := null;
  new.decline_reason := null;
  new.decline_note := null;
  return new;
end $$;
create trigger requests_before_insert before insert on app.requests
  for each row execute function app.requests_before_insert();

-- Переходы статусов по таблице request_transitions с учётом актора
create function app.requests_before_update() returns trigger
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
create trigger requests_before_update before update on app.requests
  for each row execute function app.requests_before_update();

-- История статусов пишется здесь и только здесь — пропустить её нельзя.
-- Источник и причину API может уточнить GUC-ами app.source и app.reason
create function app.requests_log_status() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor  app.actor_kind := app.effective_actor();
  v_source app.source;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return null;
  end if;
  v_source := case
    when tg_op = 'INSERT' then new.source
    else coalesce(nullif(current_setting('app.source', true), '')::app.source,
                  case v_actor
                    when 'client' then 'tma'
                    when 'vendor_user' then 'vendor_cabinet'
                    when 'staff' then 'admin'
                    else 'system'
                  end::app.source)
  end;
  insert into app.request_status_log (request_id, from_status, to_status, actor_kind, actor_id, source, reason)
  values (new.id,
          case when tg_op = 'UPDATE' then old.status end,
          new.status,
          v_actor,
          app.actor_id(),
          v_source,
          coalesce(new.decline_note, nullif(current_setting('app.reason', true), '')));
  return null;
end $$;
create trigger requests_log_status after insert or update of status on app.requests
  for each row execute function app.requests_log_status();

-- ════════════════════════════════════════════════════════════════════════════
-- Журналы только на добавление
-- ════════════════════════════════════════════════════════════════════════════
create trigger request_status_log_append_only before update or delete on app.request_status_log
  for each row execute function app.forbid_mutation();
create trigger request_status_log_no_truncate before truncate on app.request_status_log
  for each statement execute function app.forbid_mutation();
create trigger audit_log_append_only before update or delete on app.audit_log
  for each row execute function app.forbid_mutation();
create trigger audit_log_no_truncate before truncate on app.audit_log
  for each statement execute function app.forbid_mutation();
create trigger pii_access_log_append_only before update or delete on app.pii_access_log
  for each row execute function app.forbid_mutation();
create trigger pii_access_log_no_truncate before truncate on app.pii_access_log
  for each statement execute function app.forbid_mutation();
create trigger consents_append_only before update or delete on app.consents
  for each row execute function app.forbid_mutation();
create trigger consents_no_truncate before truncate on app.consents
  for each statement execute function app.forbid_mutation();

-- ════════════════════════════════════════════════════════════════════════════
-- Чтение телефонов — только через эти функции, каждое чтение в pii_access_log
-- ════════════════════════════════════════════════════════════════════════════

create function app.log_pii_access(p_subject_kind text, p_subject_id uuid, p_purpose text, p_reason text)
returns void
language sql security definer set search_path = ''
as $$
  insert into app.pii_access_log (actor_kind, actor_id, subject_kind, subject_id, field, purpose, reason)
  values (app.effective_actor(), app.actor_id(), p_subject_kind, p_subject_id, 'phone', p_purpose,
          nullif(btrim(p_reason), ''))
$$;

-- Телефон клиента из заявки. Вендор — пока действует согласие; сотрудник —
-- только admin и с причиной; клиент — свой. Чужое — null
create function pii.read_request_phone(p_request uuid, p_reason text default null)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_kind    text := app.actor_kind();
  v_purpose text;
  v_phone   text;
begin
  if v_kind = 'staff' then
    if app.current_staff_role() is distinct from 'admin' then
      raise exception 'forbidden_for_actor' using errcode = '42501';
    end if;
    if coalesce(btrim(p_reason), '') = '' then
      raise exception 'reason_required' using errcode = 'BR010';
    end if;
    v_purpose := 'staff_reveal';
  elsif v_kind in ('vendor_user', 'client') then
    if not app.can_see_request_contact(p_request) then
      return null;
    end if;
    v_purpose := case v_kind when 'vendor_user' then 'request_inbox' else 'self' end;
  else
    return null;
  end if;

  select rc.contact_phone into v_phone
  from pii.request_contacts rc
  where rc.request_id = p_request and rc.purged_at is null;
  if v_phone is not null then
    perform app.log_pii_access('request_contact', p_request, v_purpose, p_reason);
  end if;
  return v_phone;
end $$;

-- Телефон из профиля клиента: сотрудник-admin с причиной или сам клиент
create function pii.read_client_phone(p_client uuid, p_reason text default null)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_kind    text := app.actor_kind();
  v_purpose text;
  v_phone   text;
begin
  if v_kind = 'staff' then
    if app.current_staff_role() is distinct from 'admin' then
      raise exception 'forbidden_for_actor' using errcode = '42501';
    end if;
    if coalesce(btrim(p_reason), '') = '' then
      raise exception 'reason_required' using errcode = 'BR010';
    end if;
    v_purpose := 'staff_reveal';
  elsif v_kind = 'client' and p_client = app.actor_id() then
    v_purpose := 'self';
  else
    return null;
  end if;

  select p.phone into v_phone from pii.client_profiles p where p.client_id = p_client;
  if v_phone is not null then
    perform app.log_pii_access('client', p_client, v_purpose, p_reason);
  end if;
  return v_phone;
end $$;

-- Телефоны контактного лица вендора: любой активный сотрудник (звонки по SLA)
-- или сам вендор
create function pii.read_vendor_contact_phones(p_vendor uuid, p_reason text default null)
returns table (phone text, phone_alt text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_kind    text := app.actor_kind();
  v_purpose text;
begin
  if v_kind = 'staff' and app.current_staff_role() is not null then
    v_purpose := 'staff_vendor_contact';
  elsif v_kind = 'vendor_user' and p_vendor = app.actor_vendor_id() then
    v_purpose := 'self';
  else
    return;
  end if;

  return query
    select c.phone, c.phone_alt from pii.vendor_contacts c
    where c.vendor_id = p_vendor and (c.phone is not null or c.phone_alt is not null);
  if found then
    perform app.log_pii_access('vendor_contact', p_vendor, v_purpose, p_reason);
  end if;
end $$;

-- Телефон входа пользователя вендора: сотрудник, сам пользователь, система
-- (резервное SMS-уведомление без ПДн клиента)
create function pii.read_vendor_user_phone(p_vendor_user uuid, p_reason text default null)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_kind    text := app.actor_kind();
  v_purpose text;
  v_phone   text;
begin
  if v_kind = 'staff' and app.current_staff_role() is not null then
    v_purpose := 'staff_vendor_user';
  elsif v_kind = 'vendor_user' and p_vendor_user = app.actor_id() then
    v_purpose := 'self';
  elsif v_kind = 'system' then
    v_purpose := 'system_notification';
  else
    return null;
  end if;

  select p.phone into v_phone from pii.vendor_user_profiles p where p.vendor_user_id = p_vendor_user;
  if v_phone is not null then
    perform app.log_pii_access('vendor_user', p_vendor_user, v_purpose, p_reason);
  end if;
  return v_phone;
end $$;

-- Публичный телефон листинга. У опубликованного листинга он виден всем до заявки
-- (правило продукта, согласие vendor_phone_public) и в журнал не пишется — иначе
-- журнал превратится в счётчик просмотров каталога. Неопубликованный — только
-- вендору-владельцу и сотрудникам, с записью в журнал
create function pii.read_listing_phone(p_listing uuid, p_reason text default null)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_status  app.listing_status;
  v_purpose text;
  v_phone   text;
begin
  select l.status into v_status from app.listings l where l.id = p_listing;
  if not found then
    return null;
  end if;
  select c.public_phone into v_phone from pii.listing_contacts c where c.listing_id = p_listing;
  if v_status = 'active' or v_phone is null then
    return v_phone;
  end if;

  if app.actor_kind() = 'staff' and app.current_staff_role() is not null then
    v_purpose := 'staff_listing';
  elsif app.owns_listing(p_listing) then
    v_purpose := 'self';
  else
    return null;
  end if;
  perform app.log_pii_access('listing_contact', p_listing, v_purpose, p_reason);
  return v_phone;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- RLS: включён везде; политики только для bayramm_api; без актора — только
-- публичное. Права сотрудников по действиям (manager/moderator/admin) — в API
-- ════════════════════════════════════════════════════════════════════════════

alter table app.legal_entities       enable row level security;
alter table app.consent_texts        enable row level security;
alter table app.staff                enable row level security;
alter table pii.staff_profiles       enable row level security;
alter table app.clients              enable row level security;
alter table pii.client_profiles      enable row level security;
alter table app.vendor_accounts      enable row level security;
alter table pii.vendor_contacts      enable row level security;
alter table app.vendor_users         enable row level security;
alter table pii.vendor_user_profiles enable row level security;
alter table app.listings             enable row level security;
alter table pii.listing_contacts     enable row level security;
alter table app.listing_packages     enable row level security;
alter table app.photos               enable row level security;
alter table app.listing_revisions    enable row level security;
alter table app.consents             enable row level security;
alter table app.requests             enable row level security;
alter table pii.request_contacts     enable row level security;
alter table app.request_transitions  enable row level security;
alter table app.request_status_log   enable row level security;
alter table app.availability         enable row level security;
alter table app.sessions             enable row level security;
alter table app.otp_codes            enable row level security;
alter table app.audit_log            enable row level security;
alter table app.pii_access_log       enable row level security;
alter table app.outbox               enable row level security;

-- справочные данные — публичны
create policy legal_entities_read on app.legal_entities for select to bayramm_api using (true);
create policy consent_texts_read on app.consent_texts for select to bayramm_api using (true);
create policy request_transitions_read on app.request_transitions for select to bayramm_api using (true);

-- сотрудники: только staff/system
create policy staff_read on app.staff for select to bayramm_api
  using ((select app.is_privileged()));
create policy staff_profiles_read on pii.staff_profiles for select to bayramm_api
  using ((select app.is_privileged()));

-- клиенты: сам клиент и staff/system; вендоры клиентов не видят
create policy clients_read on app.clients for select to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'client' and id = (select app.actor_id())));
create policy clients_insert on app.clients for insert to bayramm_api
  with check ((select app.is_privileged()));
create policy clients_update on app.clients for update to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'client' and id = (select app.actor_id())))
  with check ((select app.is_privileged())
              or ((select app.actor_kind()) = 'client' and id = (select app.actor_id())));

create policy client_profiles_read on pii.client_profiles for select to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id())));
create policy client_profiles_insert on pii.client_profiles for insert to bayramm_api
  with check ((select app.is_privileged()));
create policy client_profiles_update on pii.client_profiles for update to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id())))
  with check ((select app.is_privileged())
              or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id())));
-- «Удалить аккаунт»: профиль с ПДн удаляется, псевдонимные заявки остаются
create policy client_profiles_delete on pii.client_profiles for delete to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id())));

-- аккаунты вендоров: свой аккаунт; заводит и меняет — сотрудник
create policy vendor_accounts_read on app.vendor_accounts for select to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'vendor_user' and id = (select app.actor_vendor_id())));
create policy vendor_accounts_insert on app.vendor_accounts for insert to bayramm_api
  with check ((select app.is_privileged()));
create policy vendor_accounts_update on app.vendor_accounts for update to bayramm_api
  using ((select app.is_privileged())) with check ((select app.is_privileged()));

create policy vendor_contacts_read on pii.vendor_contacts for select to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'vendor_user' and vendor_id = (select app.actor_vendor_id())));
create policy vendor_contacts_insert on pii.vendor_contacts for insert to bayramm_api
  with check ((select app.is_privileged()));
create policy vendor_contacts_update on pii.vendor_contacts for update to bayramm_api
  using ((select app.is_privileged())) with check ((select app.is_privileged()));

create policy vendor_users_read on app.vendor_users for select to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'vendor_user' and vendor_id = (select app.actor_vendor_id())));
create policy vendor_users_insert on app.vendor_users for insert to bayramm_api
  with check ((select app.is_privileged()));
create policy vendor_users_update on app.vendor_users for update to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'vendor_user' and id = (select app.actor_id())))
  with check ((select app.is_privileged())
              or ((select app.actor_kind()) = 'vendor_user' and id = (select app.actor_id())));

create policy vendor_user_profiles_read on pii.vendor_user_profiles for select to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'vendor_user' and vendor_user_id = (select app.actor_id())));
create policy vendor_user_profiles_insert on pii.vendor_user_profiles for insert to bayramm_api
  with check ((select app.is_privileged()));
create policy vendor_user_profiles_update on pii.vendor_user_profiles for update to bayramm_api
  using ((select app.is_privileged())) with check ((select app.is_privileged()));

-- листинги: активные видят все (каталог); свои — вендор; клиент — ещё и те,
-- на которые у него есть заявка (чтобы «Мои заявки» не теряли название)
create policy listings_read on app.listings for select to bayramm_api
  using (status = 'active'
         or (select app.is_privileged())
         or ((select app.actor_kind()) = 'vendor_user' and vendor_id = (select app.actor_vendor_id()))
         or ((select app.actor_kind()) = 'client' and exists (
               select 1 from app.requests r where r.listing_id = listings.id and r.client_id = (select app.actor_id()))));
create policy listings_insert on app.listings for insert to bayramm_api
  with check ((select app.is_privileged())
              or ((select app.actor_kind()) = 'vendor_user' and vendor_id = (select app.actor_vendor_id())));
create policy listings_update on app.listings for update to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'vendor_user' and vendor_id = (select app.actor_vendor_id())))
  with check ((select app.is_privileged())
              or ((select app.actor_kind()) = 'vendor_user' and vendor_id = (select app.actor_vendor_id())));

-- телефон листинга: SELECT столбца phone не выдаётся, чтение — pii.read_listing_phone
create policy listing_contacts_read on pii.listing_contacts for select to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id));
create policy listing_contacts_insert on pii.listing_contacts for insert to bayramm_api
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));
create policy listing_contacts_update on pii.listing_contacts for update to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id))
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));
create policy listing_contacts_delete on pii.listing_contacts for delete to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id));

-- пакеты, занятость: публичны у активных листингов, правит владелец/сотрудник
create policy listing_packages_read on app.listing_packages for select to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id) or app.listing_is_public(listing_id));
create policy listing_packages_write on app.listing_packages for all to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id))
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));

create policy availability_read on app.availability for select to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id) or app.listing_is_public(listing_id));
create policy availability_write on app.availability for all to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id))
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));

-- фото: публичны только готовые, одобренные, неудалённые фото активного листинга
create policy photos_read on app.photos for select to bayramm_api
  using ((select app.is_privileged())
         or app.owns_listing(listing_id)
         or (deleted_at is null and status = 'ready' and moderation = 'approved'
             and app.listing_is_public(listing_id)));
create policy photos_insert on app.photos for insert to bayramm_api
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));
create policy photos_update on app.photos for update to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id))
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));

create policy listing_revisions_read on app.listing_revisions for select to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id));
create policy listing_revisions_insert on app.listing_revisions for insert to bayramm_api
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));
create policy listing_revisions_update on app.listing_revisions for update to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id))
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));

-- согласия: субъект видит и добавляет свои; staff/system — все
create policy consents_read on app.consents for select to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) in ('client', 'vendor_user')
             and subject_kind::text = (select app.actor_kind()) and subject_id = (select app.actor_id())));
create policy consents_insert on app.consents for insert to bayramm_api
  with check ((select app.is_privileged())
              or ((select app.actor_kind()) in ('client', 'vendor_user')
                  and subject_kind::text = (select app.actor_kind()) and subject_id = (select app.actor_id())));

-- заявки: вендор-адресат, клиент-автор, staff/system. Без актора — ноль строк
create policy requests_read on app.requests for select to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'vendor_user' and vendor_id = (select app.actor_vendor_id()))
         or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id())));
create policy requests_insert on app.requests for insert to bayramm_api
  with check ((select app.is_privileged())
              or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id())));
-- что и кому можно менять, проверяет триггер по request_transitions
create policy requests_update on app.requests for update to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'vendor_user' and vendor_id = (select app.actor_vendor_id()))
         or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id())))
  with check ((select app.is_privileged())
              or ((select app.actor_kind()) = 'vendor_user' and vendor_id = (select app.actor_vendor_id()))
              or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id())));

create policy request_contacts_read on pii.request_contacts for select to bayramm_api
  using (app.can_see_request_contact(request_id));
create policy request_contacts_insert on pii.request_contacts for insert to bayramm_api
  with check ((select app.is_privileged())
              or ((select app.actor_kind()) = 'client' and app.can_see_request(request_id)));
create policy request_contacts_update on pii.request_contacts for update to bayramm_api
  using ((select app.is_privileged())) with check ((select app.is_privileged()));

create policy request_status_log_read on app.request_status_log for select to bayramm_api
  using (app.can_see_request(request_id));

-- сессии: свои; поиск по токену при входе — под актором system
create policy sessions_read on app.sessions for select to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id()))
         or ((select app.actor_kind()) = 'vendor_user' and vendor_user_id = (select app.actor_id())));
create policy sessions_insert on app.sessions for insert to bayramm_api
  with check ((select app.is_privileged()));
create policy sessions_update on app.sessions for update to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id()))
         or ((select app.actor_kind()) = 'vendor_user' and vendor_user_id = (select app.actor_id())))
  with check ((select app.is_privileged())
              or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id()))
              or ((select app.actor_kind()) = 'vendor_user' and vendor_user_id = (select app.actor_id())));

-- OTP: только система
create policy otp_codes_system on app.otp_codes for all to bayramm_api
  using ((select app.actor_kind()) = 'system') with check ((select app.actor_kind()) = 'system');

-- журнал действий: пишет любой актор, но только от своего имени
create policy audit_log_read on app.audit_log for select to bayramm_api
  using ((select app.is_privileged()));
create policy audit_log_insert on app.audit_log for insert to bayramm_api
  with check (actor_kind::text = (select app.actor_kind())
              and actor_id is not distinct from (select app.actor_id()));

create policy pii_access_log_read on app.pii_access_log for select to bayramm_api
  using ((select app.is_privileged()));

-- outbox: ставит в очередь любой актор (в транзакции с действием), читает и
-- обрабатывает система; сотрудник видит недоставленные
create policy outbox_read on app.outbox for select to bayramm_api
  using ((select app.is_privileged()));
create policy outbox_insert on app.outbox for insert to bayramm_api
  with check ((select app.actor_kind()) is not null);
create policy outbox_update on app.outbox for update to bayramm_api
  using ((select app.is_privileged())) with check ((select app.is_privileged()));

-- ════════════════════════════════════════════════════════════════════════════
-- Права bayramm_api — только то, что нужно API. DELETE — только там, где он
-- означает «снять отметку» (занятость, пакеты, телефон листинга)
-- ════════════════════════════════════════════════════════════════════════════

grant select on app.legal_entities, app.consent_texts, app.request_transitions to bayramm_api;
grant select on app.staff, pii.staff_profiles to bayramm_api;

grant select, insert, update on app.clients, app.vendor_accounts, app.vendor_users, app.sessions, app.otp_codes,
  app.outbox, app.listing_revisions to bayramm_api;
grant usage on sequence app.vendor_code_seq to bayramm_api;

grant select, insert on app.listings to bayramm_api;
grant update (slug, status, status_reason, name, district_code, address_ru, address_uz, description_ru,
  description_uz, price_from_uzs, price_unit, cap_min, cap_max) on app.listings to bayramm_api;

grant select, insert, update, delete on app.listing_packages, app.availability to bayramm_api;

grant select, insert on app.photos to bayramm_api;
grant update (status, moderation, public_prefix, mime, bytes, width, height, sha256, sort, is_cover,
  failure_reason, processed_at, deleted_at) on app.photos to bayramm_api;

grant select, insert on app.consents, app.audit_log to bayramm_api;
grant select on app.consents_current to bayramm_api;

grant select, insert on app.requests to bayramm_api;
grant update (status, decline_reason, decline_note, sla_stage, sla_breached_at) on app.requests to bayramm_api;

-- журналы: только чтение (пишут триггеры и функции)
grant select on app.request_status_log, app.pii_access_log to bayramm_api;

-- pii: телефоны не входят в SELECT — только через pii.read_*
grant insert, update on pii.client_profiles, pii.vendor_contacts, pii.vendor_user_profiles,
  pii.request_contacts, pii.listing_contacts to bayramm_api;
grant delete on pii.listing_contacts, pii.client_profiles to bayramm_api;
grant select (client_id, telegram_id, first_name, last_name, username, phone_verified_at, updated_at)
  on pii.client_profiles to bayramm_api;
grant select (vendor_id, legal_name, stir, legal_address, contact_person, contact_role, telegram_username, updated_at)
  on pii.vendor_contacts to bayramm_api;
grant select (vendor_user_id, full_name, telegram_user_id, telegram_chat_id, updated_at)
  on pii.vendor_user_profiles to bayramm_api;
grant select (request_id, contact_name, comment, created_at, purged_at) on pii.request_contacts to bayramm_api;
grant select (listing_id, updated_at) on pii.listing_contacts to bayramm_api;

-- функции: PUBLIC — ничего; API — только нужное
revoke execute on all functions in schema app, pii from public;
grant execute on function
  app.owns_listing(uuid), app.listing_is_public(uuid), app.current_staff_role(),
  app.request_consent_active(uuid), app.can_see_request(uuid), app.can_see_request_contact(uuid),
  app.listing_publish_blockers(uuid, app.listing_status), app.revision_payload_ok(jsonb),
  pii.read_request_phone(uuid, text), pii.read_client_phone(uuid, text),
  pii.read_vendor_contact_phones(uuid, text), pii.read_vendor_user_phone(uuid, text),
  pii.read_listing_phone(uuid, text)
  to bayramm_api;
