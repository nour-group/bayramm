-- ════════════════════════════════════════════════════════════════════════════
-- Миграция 1 — фундамент v0.1: схемы, роль API, перечисления, контекст актора,
-- справочники и настройки.
--
--   · две схемы: `app` — псевдонимные данные, `pii` — персональные данные;
--     ни одна не выставляется в Data API (config.toml → api.schemas);
--   · API ходит в базу ролью `bayramm_api` (NOBYPASSRLS), пароль задаётся вне
--     репозитория, отдельно в каждом окружении;
--   · статусы заявки: new → viewed → contacted → deal | declined + withdrawn,
--     expired; листинг: lead → draft → review → active ⇄ suspended, rejected;
--   · справочники по кодам, а не по индексам; SLA — 12 часов.
--
-- Откат: supabase/rollbacks/20260928120000_foundation.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── схемы ───────────────────────────────────────────────────────────────────
create schema if not exists app;
create schema if not exists pii;

comment on schema app is 'Bayramm v0.1: псевдонимные данные (без имён, телефонов, Telegram ID)';
comment on schema pii is 'Bayramm v0.1: персональные данные; доступ к телефонам — только через журналируемые функции';

-- ── роль API ────────────────────────────────────────────────────────────────
-- Создаём, только если её нет. На staging роль уже есть (с паролем и LOGIN) —
-- её атрибуты не трогаем. Пароль и LOGIN выдаются вне миграций:
--   alter role bayramm_api with login password '…';
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bayramm_api') then
    create role bayramm_api nologin noinherit nobypassrls;
  end if;
end $$;

-- Вся изоляция держится на RLS. Если роль обходит RLS — останавливаем деплой,
-- а не молча работаем без защиты.
do $$
begin
  if exists (select 1 from pg_roles
             where rolname = 'bayramm_api' and (rolsuper or rolbypassrls)) then
    raise exception 'bayramm_api не должна иметь SUPERUSER или BYPASSRLS';
  end if;
end $$;

-- Никаких прав по умолчанию: ни PUBLIC, ни ролям Data API Supabase.
revoke all on schema app, pii from public;
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema app, pii from %I', r);
    end if;
  end loop;
end $$;

-- USAGE на схемы есть только у bayramm_api. EXECUTE на функции Postgres по
-- умолчанию выдаёт PUBLIC, и отозвать это на уровне схемы нельзя (ALTER DEFAULT
-- PRIVILEGES … IN SCHEMA только добавляет права). Поэтому каждая миграция,
-- создающая функции, в конце делает `revoke execute … from public` и выдаёт
-- bayramm_api только нужное (см. конец миграции 2).
grant usage on schema app, pii to bayramm_api;

-- ── перечисления ────────────────────────────────────────────────────────────
create type app.locale as enum ('ru', 'uz');

-- Роли сотрудников
create type app.staff_role as enum ('admin', 'manager', 'moderator');

-- Организационно-правовая форма вендора
create type app.legal_form as enum ('ooo', 'yatt', 'self_employed');

-- Жизненный цикл листинга:
--   lead → draft → review → active ⇄ suspended;  lead|draft|review → rejected → draft
create type app.listing_status as enum ('lead', 'draft', 'review', 'active', 'suspended', 'rejected');

-- Единица цены: цена за гостя или за мероприятие. Суммы — целые сумы.
create type app.price_unit as enum ('per_guest', 'per_event');

-- Пакеты цен: будни, выходные, произвольный
create type app.package_kind as enum ('weekday', 'weekend', 'custom');

-- Обработка фото (R2 → Images → media)
create type app.photo_status as enum ('uploading', 'processing', 'ready', 'failed');

-- Модерация: ревизии листинга и фото
create type app.moderation_status as enum ('pending', 'approved', 'declined', 'withdrawn');

-- Статусы заявки:
--   new → viewed → contacted → deal | declined;  withdrawn — отозвал клиент;
--   expired — дата события прошла без итога
create type app.request_status as enum ('new', 'viewed', 'contacted', 'deal', 'declined', 'withdrawn', 'expired');

-- Причины отказа вендора
create type app.decline_reason as enum ('busy', 'format', 'price', 'other');

-- Кто действует. Совпадает со значениями GUC app.actor_kind
create type app.actor_kind as enum ('client', 'vendor_user', 'staff', 'system');

-- Откуда пришло действие (журнал статусов, согласия, заявки)
create type app.source as enum ('tma', 'web', 'vendor_cabinet', 'partner_bot', 'admin', 'offline', 'system');

-- Цели согласий: раздельно по целям, каждая со своей версией текста.
-- Маркетинг в v0.1 не собираем — значение добавится через ALTER TYPE.
create type app.consent_purpose as enum (
  'client_service',       -- аккаунт клиента: Telegram ID, имя, язык, свои заявки
  'request_transfer',     -- передача контактов конкретному вендору (на заявку)
  'bot_notifications',    -- уведомления клиенту через бота
  'vendor_contact',       -- обработка данных контактного лица вендора
  'vendor_phone_public',  -- публикация телефона вендора
  'vendor_offer'          -- принятие оферты/договора (не ПДн, но версионируется так же)
);
create type app.consent_action as enum ('grant', 'withdraw');

-- Уведомления (outbox)
create type app.notify_channel as enum ('telegram', 'sms');
create type app.outbox_status as enum ('pending', 'sending', 'sent', 'failed', 'dead');

-- ── контекст актора ─────────────────────────────────────────────────────────
-- API на каждый запрос открывает транзакцию и выставляет (withActor):
--   select set_config('app.actor_kind', 'vendor_user', true),
--          set_config('app.actor_id',   '<uuid>',      true),
--          set_config('app.vendor_id',  '<uuid>',      true);
-- Нет GUC — нет актора: политики RLS видят только публичные строки.

create function app.actor_kind() returns text
language sql stable parallel safe set search_path = ''
as $$ select nullif(current_setting('app.actor_kind', true), '') $$;

create function app.actor_id() returns uuid
language sql stable parallel safe set search_path = ''
as $$ select nullif(current_setting('app.actor_id', true), '')::uuid $$;

create function app.actor_vendor_id() returns uuid
language sql stable parallel safe set search_path = ''
as $$ select nullif(current_setting('app.vendor_id', true), '')::uuid $$;

-- staff и system видят всё; права сотрудников по действиям проверяет API
create function app.is_privileged() returns boolean
language sql stable parallel safe set search_path = ''
as $$ select coalesce(app.actor_kind() in ('staff', 'system'), false) $$;

-- Для триггеров: кто действует, если GUC не задан (миграции, ручной SQL) — system
create function app.effective_actor() returns app.actor_kind
language sql stable set search_path = ''
as $$ select coalesce(app.actor_kind(), 'system')::app.actor_kind $$;

-- Журналы только на добавление: любое UPDATE/DELETE/TRUNCATE — ошибка
create function app.forbid_mutation() returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception 'append_only'
    using errcode = 'BR001', detail = format('%I.%I допускает только INSERT', tg_table_schema, tg_table_name);
end $$;

-- ── справочники ─────────────────────────────────────────────────────────────
create table app.categories (
  code    text primary key check (code ~ '^[a-z_]{2,20}$'),
  name_ru text not null,
  name_uz text not null,
  enabled boolean not null default false,          -- в v0.1 включены только залы
  sort    smallint not null default 0
);
comment on table app.categories is 'Категории услуг; в v0.1 включены только залы';

create table app.occasions (
  code    text primary key check (code ~ '^[a-z_]{2,20}$'),
  name_ru text not null,
  name_uz text not null,
  sort    smallint not null default 0
);
comment on table app.occasions is 'Поводы (типы праздников)';

create table app.districts (
  code    text primary key check (code ~ '^[a-z_]{2,30}$'),
  name_ru text not null,
  name_uz text not null,
  sort    smallint not null default 0
);
comment on table app.districts is 'Районы Ташкента: 12 штук, ключ — код, не индекс';

-- Границы числовых настроек проверяет база, а не UI:
-- min_photos не ниже 3 — это правило продукта, а не настройка
create function app.setting_value_ok(p_key text, p_value jsonb) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  v_min int;
  v_max int;
begin
  case p_key
    when 'sla_hours'  then v_min := 1; v_max := 72;
    when 'min_photos' then v_min := 3; v_max := 10;
    when 'max_photos' then v_min := 3; v_max := 30;
    when 'client_requests_per_day' then v_min := 1; v_max := 100;
    when 'request_contact_retention_days' then v_min := 1; v_max := 3650;
    when 'otp_retention_hours' then v_min := 1; v_max := 720;
    else return true;
  end case;
  if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}') !~ '^[0-9]+$' then
    return false;
  end if;
  return (p_value #>> '{}')::int between v_min and v_max;
end $$;

create table app.settings (
  key        text primary key check (key ~ '^[a-z_]{2,40}$'),
  value      jsonb not null check (app.setting_value_ok(key, value)),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
comment on table app.settings is 'Настройки платформы; SLA фиксируется в заявке при её создании';

create function app.setting_int(p_key text) returns int
language sql stable set search_path = ''
as $$ select (s.value #>> '{}')::int from app.settings s where s.key = p_key $$;

-- ── данные справочников ─────────────────────────────────────────────────────
-- Узбекский: латиница, oʻ/gʻ через U+02BB.
-- Идемпотентно: повторный прогон обновляет названия, коды не меняются.

insert into app.categories (code, name_ru, name_uz, enabled, sort) values
  ('hall',  'Площадка / Тойхона', 'Maydon / Toʻyxona',    true,  1),
  ('food',  'Стол / Кейтеринг',   'Dasturxon / Ketering', false, 2),
  ('photo', 'Фото и видео',       'Foto va video',        false, 3),
  ('decor', 'Декор / Оформление', 'Bezak / Bezash',       false, 4),
  ('cake',  'Торт',               'Tort',                 false, 5),
  ('music', 'Музыка / Ведущий',   'Musiqa / Boshlovchi',  false, 6),
  ('kids',  'Аниматоры',          'Animatorlar',          false, 7),
  ('car',   'Транспорт / Кортеж', 'Transport / Kortej',   false, 8)
on conflict (code) do update
  set name_ru = excluded.name_ru, name_uz = excluded.name_uz, sort = excluded.sort;

insert into app.occasions (code, name_ru, name_uz, sort) values
  ('toy',    'Свадьба',       'Toʻy',          1),
  ('beshik', 'Бешик-той',     'Beshik toʻyi',  2),
  ('bd',     'День рождения', 'Tugʻilgan kun', 3),
  ('corp',   'Корпоратив',    'Korporativ',    4),
  ('small',  'Частное',       'Yopiq davra',   5)
on conflict (code) do update
  set name_ru = excluded.name_ru, name_uz = excluded.name_uz, sort = excluded.sort;

-- sort — только порядок показа; ключ — код
insert into app.districts (code, name_ru, name_uz, sort) values
  ('yunusobod',     'Юнусабад',      'Yunusobod',      1),
  ('mirzo_ulugbek', 'Мирзо-Улугбек', 'Mirzo Ulugʻbek', 2),
  ('chilonzor',     'Чиланзар',      'Chilonzor',      3),
  ('yakkasaroy',    'Яккасарай',     'Yakkasaroy',     4),
  ('shayxontohur',  'Шайхантахур',   'Shayxontohur',   5),
  ('mirobod',       'Мирабад',       'Mirobod',        6),
  ('sergeli',       'Сергели',       'Sergeli',        7),
  ('uchtepa',       'Учтепа',        'Uchtepa',        8),
  ('olmazor',       'Алмазар',       'Olmazor',        9),
  ('yashnobod',     'Яшнабад',       'Yashnobod',      10),
  ('bektemir',      'Бектемир',      'Bektemir',       11),
  ('yangihayot',    'Янгихаят',      'Yangihayot',     12)
on conflict (code) do update
  set name_ru = excluded.name_ru, name_uz = excluded.name_uz, sort = excluded.sort;

-- Настройки: при повторном прогоне не перетираем то, что поменяли руками
insert into app.settings (key, value) values
  ('sla_hours',                      '12'),                               -- часов на ответ вендора
  ('sla_reminder_hours',             '[4, 8]'),                           -- напоминания вендору
  ('quiet_hours',                    '{"from": "22:00", "to": "08:00"}'), -- только для напоминаний
  ('min_photos',                     '3'),                                -- правило продукта: минимум 3
  ('max_photos',                     '10'),
  ('client_requests_per_day',        '10'),
  ('request_contact_retention_days', '90'),                               -- после даты события
  ('otp_retention_hours',            '24')                                -- срок хранения кодов входа
on conflict (key) do nothing;

-- ── RLS и права на справочники ──────────────────────────────────────────────
-- RLS включён на каждой таблице; справочники публичны (их видят и гости).
alter table app.categories enable row level security;
alter table app.occasions enable row level security;
alter table app.districts enable row level security;
alter table app.settings enable row level security;

create policy categories_read on app.categories for select to bayramm_api using (true);
create policy occasions_read on app.occasions for select to bayramm_api using (true);
create policy districts_read on app.districts for select to bayramm_api using (true);
create policy settings_read on app.settings for select to bayramm_api using (true);

-- Справочники и настройки меняются миграциями, а не API
grant select on app.categories, app.occasions, app.districts, app.settings to bayramm_api;

revoke execute on all functions in schema app, pii from public;
grant execute on function
  app.actor_kind(), app.actor_id(), app.actor_vendor_id(), app.is_privileged(),
  app.effective_actor(), app.setting_int(text)
  to bayramm_api;
