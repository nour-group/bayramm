-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — один аккаунт на человека: вход откуда угодно, роли — членства.
--
--   · app.accounts — человек (псевдонимно): язык, отключение, удаление;
--   · app.account_identities — чем человек доказывает, что это он: Telegram
--     или телефон. value_hash — тот же HMAC(ID_HASH_KEY, …), что у клиентов и
--     вендоров: Telegram ID десятичной записью, телефон — «+998XXXXXXXXX».
--     Одно значение — один аккаунт; у аккаунта не больше одного Telegram и
--     одного телефона;
--   · pii.account_profiles — Telegram ID, имя пользователя и имена из
--     Telegram, подтверждённый телефон;
--   · роли — членства со ссылкой на аккаунт:
--       – клиент: app.clients.account_id, 1:1, создаётся при входе в
--         клиентское приложение (app.account_ensure_client);
--       – партнёр: app.vendor_users.account_id, человек может быть в
--         нескольких вендорах. Привязывается, когда аккаунт доказал телефон,
--         который завёл сотрудник: кодом из сообщения или контактом в боте;
--       – сотрудник: app.staff.account_id. Только по приглашению: имя
--         пользователя Telegram из подписанных данных (виджет, initData,
--         сообщение боту) или телефон приглашения. Входом сотрудника не создать;
--   · сессии: сессия аккаунта — 7 дней; сессия сотрудника — не дольше 12 часов
--     от доказательства входа и только по свежему доказательству
--     (app.staff_elevate). proof_at — когда человек в последний раз доказал,
--     кто он (подпись Telegram, код из сообщения); сессия, выданная по коду
--     хаба, наследует его от сессии хаба;
--   · коды хаба входа (app.hub_codes): 60 секунд, один раз, привязаны к
--     приложению, его origin, PKCE и state;
--   · коды из сообщения (app.otp_codes): не чаще раза в минуту и не больше трёх
--     за 10 минут на номер и на IP, пять попыток, 10 минут, в базе — HMAC;
--   · всё, что создаёт и привязывает, — функции ниже под актором system (вход)
--     или account (свой аккаунт); записи app.audit_log — без ПДн.
--
-- Перенос: каждый клиент, пользователь вендора и сотрудник с Telegram получает
-- аккаунт; строки с одним хэшем Telegram — один аккаунт (app.accounts_backfill,
-- повторный вызов ничего не меняет). Приглашения и пользователи вендоров без
-- привязки остаются без аккаунта до первого доказательства. Действующие сессии
-- продолжают работать: они становятся сессиями аккаунта (сотрудника — сессиями
-- сотрудника).
--
-- Код API, развёрнутый до этой миграции, продолжает работать до выкладки
-- нового: app.staff_sign_in, app.vendor_user_claim_telegram и
-- app.telegram_started сохраняют сигнатуры, а строки клиентов и сессий без
-- account_id получают его триггером.
--
-- Откат: supabase/rollbacks/20260930190000_accounts.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── актор «аккаунт» ─────────────────────────────────────────────────────────
-- Действия над своим аккаунтом: профиль, способы входа, удаление. Функции и
-- политики ниже сравнивают app.actor_kind() как текст — значение перечисления
-- нужно только при вставке в журналы, то есть уже после этой миграции
alter type app.actor_kind add value if not exists 'account';

create type app.identity_kind as enum ('telegram', 'phone');

-- ════════════════════════════════════════════════════════════════════════════
-- Аккаунты
-- ════════════════════════════════════════════════════════════════════════════

create table app.accounts (
  id              uuid primary key default gen_random_uuid(),
  locale          app.locale not null default 'uz',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_seen_at    timestamptz,
  disabled_at     timestamptz,
  disabled_reason text check (length(btrim(disabled_reason)) between 1 and 500),
  disabled_by     uuid references app.staff,
  deleted_at      timestamptz,
  check ((disabled_at is null) = (disabled_reason is null))
);
create trigger accounts_touch_updated_at before update on app.accounts
  for each row execute function app.touch_updated_at();

comment on table app.accounts is
  'Человек: одна запись на все роли (клиент, партнёр, сотрудник). Без ПДн — они в pii.account_profiles';
comment on column app.accounts.disabled_at is 'Отключён сотрудником: все роли и сессии сразу';
comment on column app.accounts.deleted_at is
  'Удалён самим человеком: профиль стёрт, членства отвязаны; вход тем же способом восстанавливает аккаунт';

create table app.account_identities (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references app.accounts on delete cascade,
  kind         app.identity_kind not null,
  value_hash   bytea not null check (octet_length(value_hash) = 32),
  verified_at  timestamptz not null default now(),
  last_used_at timestamptz,
  created_at   timestamptz not null default now(),
  constraint account_identities_value_key unique (kind, value_hash),
  constraint account_identities_one_per_kind unique (account_id, kind)
);

comment on table app.account_identities is
  'Способы входа: Telegram или телефон, HMAC(ID_HASH_KEY, значение). Одно значение — один аккаунт';

create table pii.account_profiles (
  account_id        uuid primary key references app.accounts on delete cascade,
  telegram_id       bigint unique check (telegram_id > 0),
  telegram_username text check (telegram_username ~ '^[A-Za-z0-9_]{4,32}$'),
  first_name        text check (length(first_name) <= 128),
  last_name         text check (length(last_name) <= 128),
  phone             text check (phone ~ '^\+998[0-9]{9}$'),
  phone_verified_at timestamptz,
  updated_at        timestamptz not null default now(),
  check ((phone is null) = (phone_verified_at is null))
);
create trigger account_profiles_touch_updated_at before update on pii.account_profiles
  for each row execute function app.touch_updated_at();

comment on table pii.account_profiles is
  'Профиль аккаунта: Telegram ID, имя пользователя и имена из Telegram, подтверждённый телефон';

-- Одноразовые коды хаба входа: сайт выдаёт код другому приложению (кабинету,
-- панели), то меняет его на свою сессию. В базе — sha256 кода и state
create table app.hub_codes (
  id         uuid primary key default gen_random_uuid(),
  code_hash  bytea not null unique check (octet_length(code_hash) = 32),
  account_id uuid not null references app.accounts on delete cascade,
  app        text not null check (app in ('web', 'vendor', 'admin')),
  origin     text not null check (origin ~ '^https?://[a-z0-9.-]+(:[0-9]{1,5})?$'),
  challenge  text not null check (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  state_hash bytea not null check (octet_length(state_hash) = 32),
  proof_at   timestamptz not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '60 seconds')
);
create index hub_codes_expires on app.hub_codes (expires_at);

comment on table app.hub_codes is
  'Код хаба входа: 60 секунд, один раз; приложение, origin, PKCE (S256) и state — те, с которыми его выдали';

-- ════════════════════════════════════════════════════════════════════════════
-- Членства
-- ════════════════════════════════════════════════════════════════════════════

-- Клиент: account_id станет обязательным после переноса. Аккаунт, вошедший
-- только по телефону, — клиент без Telegram
alter table app.clients
  add column account_id uuid references app.accounts,
  alter column tg_id_hash drop not null;

comment on column app.clients.tg_id_hash is
  'HMAC(ID_HASH_KEY, Telegram ID) аккаунта; null — у аккаунта нет Telegram (вход по телефону)';

-- Партнёр: человек может быть в нескольких вендорах, но в одном — один раз.
-- Один номер — у пользователей разных вендоров (менеджер нескольких залов),
-- в одном вендоре номер не повторяется. Хэш Telegram здесь — привязка
-- уведомлений, а не вход: одинаков у всех членств человека
alter table app.vendor_users add column account_id uuid references app.accounts;
create unique index vendor_users_account_vendor on app.vendor_users (account_id, vendor_id)
  where account_id is not null;
alter table app.vendor_users
  drop constraint vendor_users_phone_hash_key,
  add constraint vendor_users_vendor_phone_key unique (vendor_id, phone_hash);
create index vendor_users_phone on app.vendor_users (phone_hash);
alter table app.vendor_users drop constraint vendor_users_tg_user_hash_key;
create index vendor_users_tg_user on app.vendor_users (tg_user_hash) where tg_user_hash is not null;
alter table pii.vendor_user_profiles drop constraint vendor_user_profiles_telegram_user_id_key;

comment on column app.vendor_users.account_id is
  'Аккаунт партнёра; null — пользователь заведён сотрудником и ещё не подтвердил номер';
comment on column app.vendor_users.tg_user_hash is
  'HMAC Telegram ID аккаунта — уведомления о заявках в Telegram; null — не привязан';

-- Сотрудник: приглашение по имени пользователя Telegram или по телефону
-- (phone_hash — HMAC номера, как у вендоров)
alter table app.staff
  add column account_id uuid unique references app.accounts,
  add column phone_hash bytea check (octet_length(phone_hash) = 32);
create index staff_phone_invite on app.staff (phone_hash) where phone_hash is not null and account_id is null;

comment on column app.staff.account_id is 'Аккаунт сотрудника; null — приглашение ещё не принято';
comment on column app.staff.tg_id_hash is
  'HMAC-SHA256(ID_HASH_KEY, Telegram ID) аккаунта сотрудника — оповещения команды; null — Telegram не привязан';
comment on column app.staff.phone_hash is
  'Приглашение по телефону: HMAC(ID_HASH_KEY, +998XXXXXXXXX); принимается кодом из сообщения';

-- ════════════════════════════════════════════════════════════════════════════
-- Сессии
-- ════════════════════════════════════════════════════════════════════════════
-- via — чем доказан вход:
--   tg_webapp — initData Mini App; tg_widget — виджет входа; phone_otp — код
--   из сообщения; hub_code — код хаба (доказательство — у сессии хаба);
--   staff_elevation — сессия сотрудника по свежему доказательству.
--   tg_client, tg_partner, sms_otp, tg_staff — сессии до аккаунтов: действуют
--   до истечения.
-- app — где выдана: web (сайт и Mini App клиента), vendor, admin.
-- client_id и vendor_user_id — только у старых сессий; роль сессии аккаунта
-- берётся из членств на каждый запрос
alter table app.sessions
  add column account_id uuid references app.accounts on delete cascade,
  add column app text check (app in ('web', 'vendor', 'admin')),
  add column proof_at timestamptz,
  drop constraint sessions_via_check,
  add constraint sessions_via_check check (via in ('tg_client', 'tg_partner', 'sms_otp', 'tg_staff',
                                                   'tg_webapp', 'tg_widget', 'phone_otp', 'hub_code',
                                                   'staff_elevation')),
  drop constraint sessions_one_subject,
  add constraint sessions_one_subject check (num_nonnulls(client_id, vendor_user_id, staff_id) <= 1),
  drop constraint sessions_staff_via,
  add constraint sessions_staff_via check ((via in ('tg_staff', 'staff_elevation')) = (staff_id is not null)),
  drop constraint sessions_staff_ttl,
  add constraint sessions_staff_ttl check (staff_id is null or expires_at <= created_at + interval '12 hours'),
  add constraint sessions_staff_proof check (staff_id is null or expires_at <= proof_at + interval '12 hours'),
  add constraint sessions_account_ttl check (via not in ('tg_webapp', 'tg_widget', 'phone_otp', 'hub_code')
                                             or expires_at <= created_at + interval '7 days');
create index sessions_account on app.sessions (account_id);

-- ════════════════════════════════════════════════════════════════════════════
-- Служебные функции (API их не вызывает)
-- ════════════════════════════════════════════════════════════════════════════

-- Новый аккаунт и запись о нём в журнале: только способ (telegram, phone, backfill)
create function app.account_new(p_locale app.locale, p_via text, p_source app.source) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into app.accounts (locale) values (coalesce(p_locale, 'uz')) returning id into v_id;
  insert into app.audit_log (actor_kind, actor_id, action, object_type, object_id, detail, source)
  values (app.effective_actor(), app.actor_id(), 'account.create', 'account', v_id::text,
          jsonb_build_object('via', p_via), p_source);
  return v_id;
end $$;

-- Роли, заведённые под этот Telegram до аккаунтов (или прямым SQL), — к аккаунту;
-- членствам аккаунта без привязки уведомлений — этот Telegram. Одна роль каждого
-- вида на аккаунт (вендор — одна на каждого вендора): лишнее не привязывается
create function app.account_bind_telegram_rows(p_account uuid, p_hash bytea) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update app.clients c set account_id = p_account
  where c.tg_id_hash = p_hash and c.account_id is null
    and not exists (select 1 from app.clients x where x.account_id = p_account);
  update app.staff s set account_id = p_account
  where s.tg_id_hash = p_hash and s.account_id is null
    and not exists (select 1 from app.staff x where x.account_id = p_account);
  update app.vendor_users u set account_id = p_account
  where u.tg_user_hash = p_hash and u.account_id is null
    and not exists (select 1 from app.vendor_users x where x.account_id = p_account and x.vendor_id = u.vendor_id);

  update app.vendor_users u set tg_user_hash = p_hash, tg_linked_at = now()
  where u.account_id = p_account and u.tg_user_hash is null;
  update app.staff s set tg_id_hash = p_hash, tg_linked_at = now()
  where s.account_id = p_account and s.tg_id_hash is null
    and not exists (select 1 from app.staff x where x.tg_id_hash = p_hash);
  update app.clients c set tg_id_hash = p_hash
  where c.account_id = p_account and c.tg_id_hash is null
    and not exists (select 1 from app.clients x where x.tg_id_hash = p_hash);
end $$;

-- Аккаунт этого Telegram. Нет — создать, если p_create или под этим Telegram уже
-- есть роли без аккаунта; иначе null. Параллельные первые входы одного человека
-- идут по очереди (advisory-блокировка на хэш)
create function app.telegram_account(p_hash bytea, p_create boolean, p_locale app.locale,
                                     p_via text, p_source app.source)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  select i.account_id into v_id from app.account_identities i where i.kind = 'telegram' and i.value_hash = p_hash;
  if v_id is null then
    if not p_create
       and not exists (select 1 from app.clients c where c.tg_id_hash = p_hash and c.account_id is null)
       and not exists (select 1 from app.staff s where s.tg_id_hash = p_hash and s.account_id is null)
       and not exists (select 1 from app.vendor_users u where u.tg_user_hash = p_hash and u.account_id is null) then
      return null;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('bayramm.identity:telegram:' || encode(p_hash, 'hex'), 0));
    select i.account_id into v_id from app.account_identities i where i.kind = 'telegram' and i.value_hash = p_hash;
    if v_id is null then
      v_id := app.account_new(p_locale, p_via, p_source);
      insert into app.account_identities (account_id, kind, value_hash) values (v_id, 'telegram', p_hash);
    end if;
  end if;
  perform app.account_bind_telegram_rows(v_id, p_hash);
  return v_id;
end $$;

-- Приглашение сотрудника по имени пользователя Telegram → этот аккаунт. Только
-- действующее и ещё не принятое; у аккаунта не больше одной роли сотрудника.
-- Имя сравнивается как в приглашении: нижний регистр, без «@». Возвращает id
-- сотрудника или null
create function app.account_accept_staff_invite(p_account uuid, p_username text, p_tg_hash bytea,
                                                p_telegram_id bigint)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_username text := nullif(lower(ltrim(btrim(p_username), '@')), '');
  v_staff    uuid;
begin
  if v_username is null or exists (select 1 from app.staff s where s.account_id = p_account) then
    return null;
  end if;
  begin
    -- Строку приглашения блокирует UPDATE: параллельный вход ждёт и видит его принятым
    update app.staff s
    set account_id = p_account,
        tg_id_hash = p_tg_hash,
        tg_linked_at = case when p_tg_hash is null then null else now() end
    from pii.staff_profiles p
    where p.staff_id = s.id and p.telegram_username = v_username
      and s.active and s.account_id is null and s.tg_id_hash is null
    returning s.id into v_staff;
    if v_staff is not null and p_telegram_id is not null then
      update pii.staff_profiles p set telegram_id = p_telegram_id where p.staff_id = v_staff;
    end if;
  exception when unique_violation then
    -- этот Telegram уже у другого сотрудника: приглашение остаётся непринятым
    return null;
  end;
  if v_staff is null then
    return null;
  end if;
  -- в журнал — только id и код роли, без имени и Telegram ID
  insert into app.audit_log (actor_kind, actor_id, action, object_type, object_id, detail, source)
  select app.effective_actor(), app.actor_id(), 'staff.telegram_claim', 'staff', s.id::text,
         jsonb_build_object('role', s.role), 'admin'
  from app.staff s where s.id = v_staff;
  return v_staff;
end $$;

-- Аккаунт доказал телефон: пользователи вендоров с этим номером (ещё без
-- аккаунта) и приглашение сотрудника по этому номеру — к нему
create function app.account_bind_phone(p_account uuid, p_phone_hash bytea, p_source app.source) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_row   record;
  v_count int := 0;
  v_staff uuid;
  v_tg    bytea;
begin
  for v_row in
    update app.vendor_users u set account_id = p_account
    where u.phone_hash = p_phone_hash and u.account_id is null and u.disabled_at is null
      and not exists (select 1 from app.vendor_users x where x.account_id = p_account and x.vendor_id = u.vendor_id)
    returning u.id, u.vendor_id
  loop
    v_count := v_count + 1;
    insert into app.audit_log (actor_kind, actor_id, action, object_type, object_id, detail, source)
    values (app.effective_actor(), app.actor_id(), 'vendor_user.account_bind', 'vendor_user', v_row.id::text,
            jsonb_build_object('vendor_id', v_row.vendor_id, 'via', 'phone'), p_source);
  end loop;

  if not exists (select 1 from app.staff s where s.account_id = p_account) then
    update app.staff s set account_id = p_account
    where s.id = (select x.id from app.staff x
                  where x.phone_hash = p_phone_hash and x.account_id is null and x.active
                  order by x.created_at limit 1)
    returning s.id into v_staff;
    if v_staff is not null then
      v_count := v_count + 1;
      insert into app.audit_log (actor_kind, actor_id, action, object_type, object_id, detail, source)
      select app.effective_actor(), app.actor_id(), 'staff.phone_claim', 'staff', s.id::text,
             jsonb_build_object('role', s.role), p_source
      from app.staff s where s.id = v_staff;
    end if;
  end if;

  -- у аккаунта есть Telegram — новые членства сразу получают привязку уведомлений
  select i.value_hash into v_tg from app.account_identities i where i.account_id = p_account and i.kind = 'telegram';
  if v_tg is not null and v_count > 0 then
    perform app.account_bind_telegram_rows(p_account, v_tg);
  end if;
  return v_count;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Перенос существующих строк (идемпотентно; только актор system)
-- ════════════════════════════════════════════════════════════════════════════

create function app.accounts_backfill()
returns table (accounts_created int, phone_identities int)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row    record;
  v_before int;
  v_id     uuid;
  v_phones int;
begin
  if app.effective_actor() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  select count(*) into v_before from app.accounts;

  -- один хэш Telegram — один аккаунт; дата аккаунта — самая ранняя из его ролей,
  -- язык — клиента, если он есть
  for v_row in
    select t.h, min(t.at) as at, (array_agg(t.loc order by t.loc is null, t.at))[1] as loc
    from (
      select c.tg_id_hash as h, c.created_at as at, c.locale as loc
      from app.clients c where c.account_id is null and c.tg_id_hash is not null
      union all
      select s.tg_id_hash, s.created_at, null::app.locale
      from app.staff s where s.account_id is null and s.tg_id_hash is not null
      union all
      select u.tg_user_hash, u.created_at, u.locale
      from app.vendor_users u where u.account_id is null and u.tg_user_hash is not null
    ) t
    group by t.h
    order by min(t.at)
  loop
    v_id := app.telegram_account(v_row.h, true, v_row.loc, 'backfill', 'system');
    update app.accounts a set created_at = least(a.created_at, v_row.at) where a.id = v_id;
  end loop;

  -- профиль: имена и Telegram ID — из профилей ролей
  insert into pii.account_profiles (account_id) select a.id from app.accounts a on conflict do nothing;
  update pii.account_profiles a
  set telegram_id = p.telegram_id, telegram_username = coalesce(a.telegram_username, p.username),
      first_name = coalesce(a.first_name, p.first_name), last_name = coalesce(a.last_name, p.last_name)
  from app.clients c join pii.client_profiles p on p.client_id = c.id
  where a.account_id = c.account_id and a.telegram_id is null
    and not exists (select 1 from pii.account_profiles x where x.telegram_id = p.telegram_id);
  update pii.account_profiles a
  set telegram_id = p.telegram_id, telegram_username = coalesce(a.telegram_username, p.telegram_username)
  from app.staff s join pii.staff_profiles p on p.staff_id = s.id
  where a.account_id = s.account_id and a.telegram_id is null and p.telegram_id is not null
    and not exists (select 1 from pii.account_profiles x where x.telegram_id = p.telegram_id);
  update pii.account_profiles a
  set telegram_id = p.telegram_user_id
  from app.vendor_users u join pii.vendor_user_profiles p on p.vendor_user_id = u.id
  where a.account_id = u.account_id and a.telegram_id is null and p.telegram_user_id is not null
    and not exists (select 1 from pii.account_profiles x where x.telegram_id = p.telegram_user_id);

  -- Номер пользователя вендора, подтверждённый контактом в боте (Telegram отдаёт
  -- только свой номер), — способ входа его аккаунта
  insert into app.account_identities (account_id, kind, value_hash, verified_at, created_at)
  select distinct on (u.account_id) u.account_id, 'phone', u.phone_hash, u.tg_linked_at, u.tg_linked_at
  from app.vendor_users u
  where u.account_id is not null and u.tg_linked_at is not null and u.disabled_at is null
    and not exists (select 1 from app.account_identities i where i.account_id = u.account_id and i.kind = 'phone')
  order by u.account_id, u.tg_linked_at
  on conflict do nothing;
  get diagnostics v_phones = row_count;
  update pii.account_profiles a set phone = p.phone, phone_verified_at = i.verified_at
  from app.account_identities i
  join app.vendor_users u on u.account_id = i.account_id and u.phone_hash = i.value_hash
  join pii.vendor_user_profiles p on p.vendor_user_id = u.id
  where i.kind = 'phone' and a.account_id = i.account_id and a.phone is null;

  return query select (select count(*)::int from app.accounts) - v_before, v_phones;
end $$;

comment on function app.accounts_backfill() is
  'Аккаунты для ролей с Telegram, заведённых до аккаунтов: один хэш — один аккаунт. Повтор ничего не меняет. Только system';

select * from app.accounts_backfill();

-- Клиент без аккаунта больше не бывает: каждый клиент — с Telegram, аккаунт у него есть
alter table app.clients
  alter column account_id set not null,
  add constraint clients_account_key unique (account_id);

-- Сессии до аккаунтов: аккаунт — от их субъекта; где он не выводится
-- (пользователь вендора или сотрудник без привязки), сессия всё равно не дала бы
-- войти — такие удаляются
update app.sessions s
set account_id = coalesce((select c.account_id from app.clients c where c.id = s.client_id),
                          (select u.account_id from app.vendor_users u where u.id = s.vendor_user_id),
                          (select t.account_id from app.staff t where t.id = s.staff_id)),
    app = case s.via when 'tg_client' then 'web' when 'tg_staff' then 'admin' else 'vendor' end,
    proof_at = s.created_at
where s.account_id is null;
delete from app.sessions s where s.account_id is null;
alter table app.sessions
  alter column account_id set not null,
  alter column app set not null,
  alter column proof_at set not null;

-- ════════════════════════════════════════════════════════════════════════════
-- Триггеры
-- ════════════════════════════════════════════════════════════════════════════

-- Клиент без account_id (код до аккаунтов) — аккаунт его Telegram
create function app.clients_fill_account() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.account_id is null and new.tg_id_hash is not null then
    new.account_id := app.telegram_account(new.tg_id_hash, true, new.locale, 'telegram', 'tma');
  end if;
  return new;
end $$;
create trigger clients_fill_account before insert on app.clients
  for each row execute function app.clients_fill_account();

-- Сессия без account_id (код до аккаунтов) — аккаунт её субъекта; app и proof_at
-- старых видов — по via. Субъект сессии — всегда роль этого же аккаунта
create function app.sessions_fill_account() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_subject uuid;
begin
  if new.client_id is not null then
    select c.account_id into v_subject from app.clients c where c.id = new.client_id;
  elsif new.vendor_user_id is not null then
    select u.account_id into v_subject from app.vendor_users u where u.id = new.vendor_user_id;
  elsif new.staff_id is not null then
    select s.account_id into v_subject from app.staff s where s.id = new.staff_id;
  end if;
  if new.account_id is null then
    new.account_id := v_subject;
  elsif num_nonnulls(new.client_id, new.vendor_user_id, new.staff_id) > 0
        and v_subject is distinct from new.account_id then
    raise exception 'forbidden_for_actor' using errcode = 'BR003',
      detail = 'роль сессии принадлежит другому аккаунту';
  end if;
  new.app := coalesce(new.app, case new.via when 'tg_client' then 'web' when 'tg_staff' then 'admin'
                                            when 'tg_partner' then 'vendor' when 'sms_otp' then 'vendor' end);
  if new.via in ('tg_client', 'tg_partner', 'sms_otp', 'tg_staff') then
    new.proof_at := coalesce(new.proof_at, now());
  end if;
  return new;
end $$;
create trigger sessions_fill_account before insert on app.sessions
  for each row execute function app.sessions_fill_account();

-- Членство можно отвязать и привязать заново, но не перевесить на другой аккаунт
create function app.membership_account_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.account_id is not null and new.account_id is not null and new.account_id <> old.account_id then
    raise exception 'immutable_column' using errcode = 'BR006',
      detail = 'членство можно только отвязать, но не перевесить на другой аккаунт';
  end if;
  return new;
end $$;
create trigger vendor_users_account_guard before update of account_id on app.vendor_users
  for each row execute function app.membership_account_guard();
create trigger staff_account_guard before update of account_id on app.staff
  for each row execute function app.membership_account_guard();

-- Клиент — навсегда клиент своего аккаунта
create function app.clients_account_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.account_id is distinct from old.account_id then
    raise exception 'immutable_column' using errcode = 'BR006', detail = 'аккаунт клиента не меняется';
  end if;
  return new;
end $$;
create trigger clients_account_guard before update of account_id on app.clients
  for each row execute function app.clients_account_guard();

-- Сотрудника отключили или отвязали — его сессии сотрудника отзываются сразу
create function app.staff_revoke_sessions() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update app.sessions s set revoked_at = now() where s.staff_id = new.id and s.revoked_at is null;
  return null;
end $$;
create trigger staff_revoke_sessions after update of active, account_id on app.staff
  for each row when ((old.active and not new.active) or old.account_id is distinct from new.account_id)
  execute function app.staff_revoke_sessions();

-- Аккаунт отключили или удалили — все его сессии отзываются
create function app.accounts_revoke_sessions() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update app.sessions s set revoked_at = now() where s.account_id = new.id and s.revoked_at is null;
  return null;
end $$;
create trigger accounts_revoke_sessions after update of disabled_at, deleted_at on app.accounts
  for each row when ((old.disabled_at is null and new.disabled_at is not null)
                     or (old.deleted_at is null and new.deleted_at is not null))
  execute function app.accounts_revoke_sessions();

-- ════════════════════════════════════════════════════════════════════════════
-- Вход (актор system; API вызывает после проверки доказательства)
-- ════════════════════════════════════════════════════════════════════════════

-- Вход по подписанным данным Telegram (initData Mini App, виджет входа).
-- Нет аккаунта — создаётся; удалённый — восстанавливается; профиль — из
-- Telegram. Приглашение сотрудника на это имя пользователя принимается.
-- Отключённый аккаунт — disabled = true, ничего не меняется
create function app.account_sign_in_telegram(p_tg_hash bytea, p_telegram_id bigint, p_username text,
                                             p_first_name text, p_last_name text, p_locale app.locale,
                                             p_source app.source)
returns table (account_id uuid, created boolean, disabled boolean)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id       uuid;
  v_created  boolean;
  v_disabled boolean;
  v_username text := case when p_username ~ '^[A-Za-z0-9_]{4,32}$' then p_username end;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if octet_length(p_tg_hash) is distinct from 32 or p_telegram_id is null or p_telegram_id <= 0 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  v_created := not exists (select 1 from app.account_identities i
                           where i.kind = 'telegram' and i.value_hash = p_tg_hash);
  v_id := app.telegram_account(p_tg_hash, true, p_locale, 'telegram', p_source);

  select a.disabled_at is not null into v_disabled from app.accounts a where a.id = v_id for update;
  if v_disabled then
    return query select v_id, v_created, true;
    return;
  end if;

  update app.accounts a set deleted_at = null, last_seen_at = now() where a.id = v_id;
  update app.account_identities i set last_used_at = now() where i.account_id = v_id and i.kind = 'telegram';

  -- Имена и имя пользователя меняют в Telegram — берём из свежих данных
  insert into pii.account_profiles as ap (account_id, telegram_id, telegram_username, first_name, last_name)
  values (v_id, p_telegram_id, v_username, left(p_first_name, 128), left(p_last_name, 128))
  on conflict (account_id) do update
    set telegram_id = excluded.telegram_id,
        telegram_username = excluded.telegram_username,
        first_name = coalesce(excluded.first_name, ap.first_name),
        last_name = case when excluded.first_name is null then ap.last_name else excluded.last_name end;

  perform app.account_accept_staff_invite(v_id, v_username, p_tg_hash, p_telegram_id);
  update pii.staff_profiles p set telegram_id = p_telegram_id
  from app.staff s
  where s.id = p.staff_id and s.account_id = v_id and p.telegram_id is null
    and not exists (select 1 from pii.staff_profiles x where x.telegram_id = p_telegram_id);
  update pii.vendor_user_profiles p set telegram_user_id = p_telegram_id
  from app.vendor_users u
  where u.id = p.vendor_user_id and u.account_id = v_id and p.telegram_user_id is null;

  return query select v_id, v_created, false;
end $$;

-- Вход по коду из сообщения на телефон (код уже проверен: app.otp_check).
-- Нет аккаунта с этим номером — создаётся. Пользователи вендоров и приглашение
-- сотрудника с этим номером привязываются
create function app.account_sign_in_phone(p_phone_hash bytea, p_phone text, p_locale app.locale,
                                          p_source app.source)
returns table (account_id uuid, created boolean, disabled boolean)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id       uuid;
  v_created  boolean := false;
  v_disabled boolean;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if octet_length(p_phone_hash) is distinct from 32 or p_phone is null or p_phone !~ '^\+998[0-9]{9}$' then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  select i.account_id into v_id from app.account_identities i where i.kind = 'phone' and i.value_hash = p_phone_hash;
  if v_id is null then
    perform pg_advisory_xact_lock(hashtextextended('bayramm.identity:phone:' || encode(p_phone_hash, 'hex'), 0));
    select i.account_id into v_id from app.account_identities i
    where i.kind = 'phone' and i.value_hash = p_phone_hash;
    if v_id is null then
      v_id := app.account_new(p_locale, 'phone', p_source);
      insert into app.account_identities (account_id, kind, value_hash) values (v_id, 'phone', p_phone_hash);
      v_created := true;
    end if;
  end if;

  select a.disabled_at is not null into v_disabled from app.accounts a where a.id = v_id for update;
  if v_disabled then
    return query select v_id, v_created, true;
    return;
  end if;

  update app.accounts a set deleted_at = null, last_seen_at = now() where a.id = v_id;
  update app.account_identities i set last_used_at = now() where i.account_id = v_id and i.kind = 'phone';
  insert into pii.account_profiles as ap (account_id, phone, phone_verified_at)
  values (v_id, p_phone, now())
  on conflict (account_id) do update set phone = excluded.phone, phone_verified_at = excluded.phone_verified_at;

  perform app.account_bind_phone(v_id, p_phone_hash, p_source);
  return query select v_id, v_created, false;
end $$;

-- Роль клиента у аккаунта: создаётся при входе в клиентское приложение,
-- удалённый клиент восстанавливается. Язык — только при создании; can_message
-- только включается. Профиль клиента (Telegram ID, имена) — из профиля
-- аккаунта, если у него есть Telegram. blocked — клиента заблокировал сотрудник
create function app.account_ensure_client(p_account uuid, p_locale app.locale, p_can_message boolean)
returns table (client_id uuid, blocked boolean)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tg      bytea;
  v_client  uuid;
  v_blocked boolean;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if not exists (select 1 from app.accounts a where a.id = p_account and a.disabled_at is null) then
    raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'аккаунта нет или он отключён';
  end if;

  select i.value_hash into v_tg from app.account_identities i where i.account_id = p_account and i.kind = 'telegram';
  insert into app.clients as c (account_id, tg_id_hash, locale, can_message, last_seen_at)
  values (p_account, v_tg,
          coalesce(p_locale, (select a.locale from app.accounts a where a.id = p_account)),
          coalesce(p_can_message, false), now())
  on conflict (account_id) do update
    set last_seen_at = now(),
        can_message = c.can_message or excluded.can_message,
        tg_id_hash = coalesce(c.tg_id_hash, excluded.tg_id_hash),
        deleted_at = null
  returning c.id, c.blocked_at is not null into v_client, v_blocked;

  if not v_blocked then
    insert into pii.client_profiles as cp (client_id, telegram_id, first_name, last_name, username)
    select v_client, p.telegram_id, p.first_name, p.last_name, p.telegram_username
    from pii.account_profiles p
    where p.account_id = p_account and p.telegram_id is not null
    on conflict (client_id) do update
      set telegram_id = excluded.telegram_id, first_name = excluded.first_name,
          last_name = excluded.last_name, username = excluded.username;
  end if;
  return query select v_client, v_blocked;
end $$;

-- Сессия сотрудника по свежему доказательству: аккаунт действует, у него
-- действующая роль сотрудника, доказательство — не старше 12 часов. Сессия
-- живёт до proof_at + 12 часов. result: ok | stale (доказать заново) | forbidden
create function app.staff_elevate(p_account uuid, p_proof_at timestamptz, p_token_hash bytea, p_via text)
returns table (result text, staff_id uuid, role app.staff_role, session_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_staff   uuid;
  v_role    app.staff_role;
  v_session uuid;
  v_expires timestamptz;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if octet_length(p_token_hash) is distinct from 32 or p_via is null or p_via !~ '^[a-z_]{2,20}$' then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  select s.id, s.role into v_staff, v_role
  from app.staff s
  join app.accounts a on a.id = s.account_id
  where s.account_id = p_account and s.active and a.disabled_at is null and a.deleted_at is null;
  if v_staff is null then
    return query select 'forbidden'::text, null::uuid, null::app.staff_role, null::uuid, null::timestamptz;
    return;
  end if;
  if p_proof_at is null or p_proof_at <= now() - interval '12 hours' + interval '1 minute'
     or p_proof_at > now() + interval '5 minutes' then
    return query select 'stale'::text, null::uuid, null::app.staff_role, null::uuid, null::timestamptz;
    return;
  end if;

  v_expires := least(p_proof_at, now()) + interval '12 hours';
  insert into app.sessions (token_hash, account_id, staff_id, via, app, proof_at, expires_at)
  values (p_token_hash, p_account, v_staff, 'staff_elevation', 'admin', least(p_proof_at, now()), v_expires)
  returning id into v_session;

  -- в журнал — роль и чем доказан вход, без ПДн
  insert into app.audit_log (actor_kind, actor_id, action, object_type, object_id, detail, source)
  values ('system', null, 'staff.elevate', 'staff', v_staff::text,
          jsonb_build_object('role', v_role, 'via', p_via, 'session_id', v_session), 'admin');

  return query select 'ok'::text, v_staff, v_role, v_session, v_expires;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Свой аккаунт (актор account)
-- ════════════════════════════════════════════════════════════════════════════

-- Добавить Telegram к своему аккаунту. result:
--   linked    — добавлен (приглашение сотрудника на это имя — принято);
--   already   — этот Telegram уже у этого аккаунта;
--   taken     — этот Telegram — способ входа другого аккаунта (слияния нет);
--   kind_taken — у аккаунта уже другой Telegram
create function app.account_link_telegram(p_tg_hash bytea, p_telegram_id bigint, p_username text,
                                          p_first_name text, p_last_name text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_account  uuid := app.actor_id();
  v_owner    uuid;
  v_username text := case when p_username ~ '^[A-Za-z0-9_]{4,32}$' then p_username end;
begin
  if app.actor_kind() is distinct from 'account' or v_account is null then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if octet_length(p_tg_hash) is distinct from 32 or p_telegram_id is null or p_telegram_id <= 0 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('bayramm.identity:telegram:' || encode(p_tg_hash, 'hex'), 0));
  select i.account_id into v_owner from app.account_identities i
  where i.kind = 'telegram' and i.value_hash = p_tg_hash;
  if v_owner = v_account then
    return 'already';
  elsif v_owner is not null then
    return 'taken';
  elsif exists (select 1 from app.account_identities i where i.account_id = v_account and i.kind = 'telegram') then
    return 'kind_taken';
  end if;

  begin
    insert into app.account_identities (account_id, kind, value_hash) values (v_account, 'telegram', p_tg_hash);
    insert into pii.account_profiles as ap (account_id, telegram_id, telegram_username, first_name, last_name)
    values (v_account, p_telegram_id, v_username, left(p_first_name, 128), left(p_last_name, 128))
    on conflict (account_id) do update
      set telegram_id = excluded.telegram_id,
          telegram_username = excluded.telegram_username,
          first_name = coalesce(ap.first_name, excluded.first_name),
          last_name = coalesce(ap.last_name, excluded.last_name);
  exception when unique_violation then
    return 'taken';
  end;

  perform app.account_bind_telegram_rows(v_account, p_tg_hash);
  perform app.account_accept_staff_invite(v_account, v_username, p_tg_hash, p_telegram_id);
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('account.identity_link', 'account', v_account::text, jsonb_build_object('kind', 'telegram'), 'web');
  return 'linked';
end $$;

-- Добавить телефон к своему аккаунту (код уже проверен: app.otp_check). result —
-- как у app.account_link_telegram. Пользователи вендоров и приглашение
-- сотрудника с этим номером привязываются
create function app.account_link_phone(p_phone_hash bytea, p_phone text, p_source app.source)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_account uuid := app.actor_id();
  v_owner   uuid;
begin
  if app.actor_kind() is distinct from 'account' or v_account is null then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if octet_length(p_phone_hash) is distinct from 32 or p_phone is null or p_phone !~ '^\+998[0-9]{9}$' then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('bayramm.identity:phone:' || encode(p_phone_hash, 'hex'), 0));
  select i.account_id into v_owner from app.account_identities i where i.kind = 'phone' and i.value_hash = p_phone_hash;
  if v_owner = v_account then
    return 'already';
  elsif v_owner is not null then
    return 'taken';
  elsif exists (select 1 from app.account_identities i where i.account_id = v_account and i.kind = 'phone') then
    return 'kind_taken';
  end if;

  begin
    insert into app.account_identities (account_id, kind, value_hash) values (v_account, 'phone', p_phone_hash);
  exception when unique_violation then
    return 'taken';
  end;
  insert into pii.account_profiles as ap (account_id, phone, phone_verified_at)
  values (v_account, p_phone, now())
  on conflict (account_id) do update set phone = excluded.phone, phone_verified_at = excluded.phone_verified_at;

  perform app.account_bind_phone(v_account, p_phone_hash, p_source);
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('account.identity_link', 'account', v_account::text, jsonb_build_object('kind', 'phone'), p_source);
  return 'linked';
end $$;

-- Свой аккаунт одним документом: профиль без телефона, способы входа (только
-- вид и дата), роли — клиент, вендоры с названиями, роль сотрудника
create function app.account_me() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_account uuid := app.actor_id();
begin
  if app.actor_kind() is distinct from 'account' or v_account is null then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  return (
    select jsonb_build_object(
      'account', jsonb_build_object('id', a.id, 'locale', a.locale, 'createdAt', a.created_at),
      'profile', jsonb_build_object('firstName', p.first_name, 'lastName', p.last_name,
                                    'username', p.telegram_username),
      'identities', coalesce((
        select jsonb_agg(jsonb_build_object('kind', i.kind, 'verifiedAt', i.verified_at) order by i.kind)
        from app.account_identities i where i.account_id = a.id), '[]'::jsonb),
      'roles', jsonb_build_object(
        'client', (
          select jsonb_build_object('id', c.id, 'locale', c.locale, 'canMessage', c.can_message,
                                    'blocked', c.blocked_at is not null)
          from app.clients c where c.account_id = a.id and c.deleted_at is null),
        'vendors', coalesce((
          select jsonb_agg(jsonb_build_object('vendorUserId', u.id, 'vendorId', v.id, 'code', v.public_code,
                                              'name', v.name, 'role', u.role) order by u.created_at, u.id)
          from app.vendor_users u join app.vendor_accounts v on v.id = u.vendor_id
          where u.account_id = a.id and u.disabled_at is null), '[]'::jsonb),
        'staff', (
          select jsonb_build_object('role', s.role)
          from app.staff s where s.account_id = a.id and s.active)))
    from app.accounts a
    left join pii.account_profiles p on p.account_id = a.id
    where a.id = v_account and a.deleted_at is null);
end $$;

-- Удаление аккаунта самим человеком — для всех ролей сразу:
--   1. роль клиента — как app.client_delete_account (согласия и открытые заявки
--      отзываются от имени клиента, контакты из заявок и профиль стираются);
--   2. членства вендоров и сотрудника отвязываются (с привязкой уведомлений);
--      записи вендоров и заявок остаются псевдонимными;
--   3. профиль аккаунта (Telegram ID, имена, телефон) удаляется; хэши способов
--      входа остаются — новый вход тем же способом восстанавливает аккаунт, а
--      блокировку клиента не обойти удалением;
--   4. все сессии отзываются; в журнал — только числа.
-- Уже удалённый аккаунт — ни одной строки в ответе
create function app.account_delete(p_source app.source, p_ip_hash bytea default null)
returns table (consents_withdrawn int, requests_withdrawn int, contacts_purged int, sessions_revoked int,
               memberships_detached int)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_account  uuid := app.actor_id();
  v_client   uuid;
  v_kind     text;
  v_id       text;
  v_consents int := 0;
  v_requests int := 0;
  v_contacts int := 0;
  v_sessions int;
  v_vendors  int;
  v_staff    int;
begin
  if app.actor_kind() is distinct from 'account' or v_account is null then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  perform 1 from app.accounts a where a.id = v_account and a.deleted_at is null for update;
  if not found then
    return;
  end if;

  select c.id into v_client from app.clients c where c.account_id = v_account and c.deleted_at is null;
  if v_client is not null then
    -- Роль клиента удаляется от имени клиента: отзыв заявок и согласий — его действия
    v_kind := current_setting('app.actor_kind', true);
    v_id := current_setting('app.actor_id', true);
    perform set_config('app.actor_kind', 'client', true), set_config('app.actor_id', v_client::text, true);
    select d.consents_withdrawn, d.requests_withdrawn, d.contacts_purged
      into v_consents, v_requests, v_contacts
    from app.client_delete_account(p_source, p_ip_hash) d;
    perform set_config('app.actor_kind', coalesce(v_kind, ''), true),
            set_config('app.actor_id', coalesce(v_id, ''), true);
  end if;

  update pii.vendor_user_profiles p set telegram_user_id = null, telegram_chat_id = null
  from app.vendor_users u where u.id = p.vendor_user_id and u.account_id = v_account;
  update app.vendor_users u set account_id = null, tg_user_hash = null, tg_linked_at = null
  where u.account_id = v_account;
  get diagnostics v_vendors = row_count;
  update pii.staff_profiles p set telegram_id = null, telegram_chat_id = null
  from app.staff s where s.id = p.staff_id and s.account_id = v_account;
  update app.staff s set account_id = null, tg_id_hash = null, tg_linked_at = null
  where s.account_id = v_account;
  get diagnostics v_staff = row_count;

  delete from pii.account_profiles p where p.account_id = v_account;
  update app.sessions s set revoked_at = now() where s.account_id = v_account and s.revoked_at is null;
  get diagnostics v_sessions = row_count;
  update app.accounts a set deleted_at = now() where a.id = v_account;

  insert into app.audit_log (action, object_type, object_id, detail, source, ip_hash)
  values ('account.delete', 'account', v_account::text,
          jsonb_build_object('consents_withdrawn', v_consents, 'requests_withdrawn', v_requests,
                             'contacts_purged', v_contacts, 'sessions_revoked', v_sessions,
                             'memberships_detached', v_vendors + v_staff),
          p_source, p_ip_hash);

  return query select v_consents, v_requests, v_contacts, v_sessions, v_vendors + v_staff;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Коды из сообщения (актор system)
-- ════════════════════════════════════════════════════════════════════════════
-- Код — HMAC(ID_HASH_KEY, "otp:" || номер || ":" || код): без ключа по базе его
-- не подобрать. Выдача:
--   too_soon    — предыдущий код на этот номер отправлен меньше минуты назад;
--   phone_limit — три кода на номер за 10 минут;
--   ip_limit    — три кода с этого IP за 10 минут (без IP не считается);
--   ok          — новый код; прежние коды номера больше не действуют.
-- retry_after — через сколько секунд можно снова

comment on column app.otp_codes.code_hash is 'HMAC(ID_HASH_KEY, "otp:<номер>:<код>")';

create function app.otp_issue(p_phone_hash bytea, p_code_hash bytea, p_ip_hash bytea, p_provider text,
                              p_ttl_seconds int)
returns table (result text, otp_id uuid, retry_after int)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_last   timestamptz;
  v_oldest timestamptz;
  v_count  int;
  v_id     uuid;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if octet_length(p_phone_hash) is distinct from 32 or octet_length(p_code_hash) is distinct from 32
     or (p_ip_hash is not null and octet_length(p_ip_hash) <> 32)
     or p_ttl_seconds is null or p_ttl_seconds not between 60 and 900 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  -- выдачи на один номер — по очереди
  perform pg_advisory_xact_lock(hashtextextended('bayramm.otp:' || encode(p_phone_hash, 'hex'), 0));

  select max(o.created_at), min(o.created_at) filter (where o.created_at > now() - interval '10 minutes'),
         count(*) filter (where o.created_at > now() - interval '10 minutes')
    into v_last, v_oldest, v_count
  from app.otp_codes o where o.phone_hash = p_phone_hash;
  if v_last > now() - interval '60 seconds' then
    return query select 'too_soon'::text, null::uuid,
                        greatest(1, ceil(60 - extract(epoch from now() - v_last)))::int;
    return;
  end if;
  if v_count >= 3 then
    return query select 'phone_limit'::text, null::uuid,
                        greatest(1, ceil(600 - extract(epoch from now() - v_oldest)))::int;
    return;
  end if;

  if p_ip_hash is not null then
    select min(o.created_at), count(*) into v_oldest, v_count
    from app.otp_codes o where o.ip_hash = p_ip_hash and o.created_at > now() - interval '10 minutes';
    if v_count >= 3 then
      return query select 'ip_limit'::text, null::uuid,
                          greatest(1, ceil(600 - extract(epoch from now() - v_oldest)))::int;
      return;
    end if;
  end if;

  update app.otp_codes o set consumed_at = now() where o.phone_hash = p_phone_hash and o.consumed_at is null;
  insert into app.otp_codes (phone_hash, code_hash, provider, ip_hash, expires_at)
  values (p_phone_hash, p_code_hash, p_provider, p_ip_hash, now() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;
  return query select 'ok'::text, v_id, 60;
end $$;

-- Проверка кода: последний действующий код номера. result:
--   ok — совпал (код больше не действует); mismatch — не совпал, попытка
--   засчитана; too_many_attempts — пять попыток исчерпаны; expired — 10 минут
--   прошли; no_code — действующего кода нет. attempts_left — сколько осталось
create function app.otp_check(p_phone_hash bytea, p_code_hash bytea)
returns table (result text, attempts_left int)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_code app.otp_codes;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if octet_length(p_phone_hash) is distinct from 32 or octet_length(p_code_hash) is distinct from 32 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  select o.* into v_code from app.otp_codes o
  where o.phone_hash = p_phone_hash and o.consumed_at is null
  order by o.created_at desc limit 1
  for update;
  if not found then
    return query select 'no_code'::text, 0;
    return;
  end if;
  if v_code.expires_at <= now() then
    return query select 'expired'::text, 0;
    return;
  end if;
  if v_code.attempts >= 5 then
    return query select 'too_many_attempts'::text, 0;
    return;
  end if;
  if v_code.code_hash = p_code_hash then
    update app.otp_codes o set consumed_at = now() where o.id = v_code.id;
    return query select 'ok'::text, 5 - v_code.attempts;
    return;
  end if;
  update app.otp_codes o set attempts = o.attempts + 1 where o.id = v_code.id;
  if v_code.attempts + 1 >= 5 then
    return query select 'too_many_attempts'::text, 0;
  else
    return query select 'mismatch'::text, 5 - (v_code.attempts + 1);
  end if;
end $$;

-- Отметка отправителя: id сообщения у провайдера (без номера и кода)
create function app.otp_sent(p_otp uuid, p_provider_msg_id text) returns void
language sql security definer set search_path = ''
as $$
  update app.otp_codes o set provider_msg_id = left(p_provider_msg_id, 200)
  where o.id = p_otp and app.actor_kind() = 'system'
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Функции до аккаунтов: те же сигнатуры, теперь через аккаунты
-- ════════════════════════════════════════════════════════════════════════════

-- Вход сотрудника по Telegram (сообщение боту; раньше — и виджет панели).
-- Возвращает действующего сотрудника или ничего:
--   1. у аккаунта этого Telegram есть роль сотрудника — она (имя не важно);
--   2. иначе — действующее, ещё не принятое приглашение с этим именем
--      пользователя: аккаунт создаётся (если его нет) и принимает приглашение;
--   3. отключённый сотрудник, чужое или уже принятое приглашение — ничего.
create or replace function app.staff_sign_in(p_tg_id_hash bytea, p_telegram_id bigint, p_username text)
returns table (staff_id uuid, role app.staff_role, display_name text, telegram_username text, claimed boolean)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_username text := nullif(lower(ltrim(btrim(p_username), '@')), '');
  v_account  uuid;
  v_staff    uuid;
  v_claimed  boolean := false;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if octet_length(p_tg_id_hash) is distinct from 32 or p_telegram_id is null or p_telegram_id <= 0 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  v_account := app.telegram_account(p_tg_id_hash, false, null, 'telegram', 'partner_bot');
  if v_account is not null then
    select s.id into v_staff from app.staff s where s.account_id = v_account;
  end if;

  if v_staff is null and v_username is not null and exists (
       select 1 from app.staff s join pii.staff_profiles p on p.staff_id = s.id
       where p.telegram_username = v_username and s.active and s.account_id is null and s.tg_id_hash is null) then
    if v_account is null then
      v_account := app.telegram_account(p_tg_id_hash, true, null, 'telegram', 'partner_bot');
    end if;
    v_staff := app.account_accept_staff_invite(v_account, v_username, p_tg_id_hash, p_telegram_id);
    v_claimed := v_staff is not null;
  end if;

  if v_staff is null then
    return;
  end if;
  if v_account is not null then
    insert into pii.account_profiles as ap (account_id, telegram_id)
    values (v_account, p_telegram_id)
    on conflict (account_id) do update set telegram_id = coalesce(ap.telegram_id, excluded.telegram_id)
    where not exists (select 1 from pii.account_profiles x
                      where x.telegram_id = excluded.telegram_id and x.account_id <> ap.account_id);
  end if;

  return query
    select s.id, s.role, p.display_name, p.telegram_username, v_claimed
    from app.staff s
    join pii.staff_profiles p on p.staff_id = s.id
    where s.id = v_staff and s.active;
end $$;

-- Привязка партнёра по контакту из бота (контакт — свой: проверил API).
-- Номер подтверждён самим Telegram: пользователи вендоров с этим номером (ещё
-- без аккаунта) привязываются к аккаунту этого Telegram — он создаётся, если
-- его нет, — а номер становится способом входа аккаунта, если телефона у него
-- ещё нет. Ответ — одна строка (первый по времени пользователь):
--   claimed          — привязали сейчас (запись в audit_log на каждого);
--   linked           — уже привязаны к этому же аккаунту (обновляется только чат);
--   linked_elsewhere — пользователи или номер уже у другого аккаунта: отказ;
--   telegram_taken   — этот аккаунт уже партнёр этого вендора другим пользователем;
--   not_found        — такого действующего пользователя нет: ничего не пишем
create or replace function app.vendor_user_claim_telegram(p_phone_hash bytea, p_phone text, p_tg_user_hash bytea,
                                                          p_telegram_user_id bigint, p_chat_id bigint)
returns table (result text, vendor_user_id uuid, vendor_id uuid, locale app.locale)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_account  uuid;
  v_owner    uuid;
  v_user     record;
  v_first    uuid;
  v_found    boolean := false;
  v_mine     boolean := false;
  v_taken    boolean := false;
  v_bindable uuid[] := '{}';
  v_added    int;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if octet_length(p_phone_hash) is distinct from 32 or octet_length(p_tg_user_hash) is distinct from 32
     or p_phone is null or p_phone !~ '^\+998[0-9]{9}$'
     or p_telegram_user_id is null or p_telegram_user_id <= 0 or p_chat_id is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  -- аккаунт этого Telegram, если он уже есть (новый — только когда есть что привязать)
  v_account := app.telegram_account(p_tg_user_hash, false, null, 'telegram', 'partner_bot');
  select i.account_id into v_owner from app.account_identities i
  where i.kind = 'phone' and i.value_hash = p_phone_hash;

  -- Строки блокируются: параллельные привязки одного номера идут по очереди
  for v_user in
    select u.id, u.vendor_id, u.locale, u.account_id, u.tg_user_hash
    from app.vendor_users u
    where u.phone_hash = p_phone_hash and u.disabled_at is null
    order by u.created_at, u.id
    for update
  loop
    v_found := true;
    if v_user.account_id is not null and v_user.account_id = v_account then
      v_mine := true;
      v_first := coalesce(v_first, v_user.id);
    elsif v_user.account_id is null
          and (v_user.tg_user_hash is null or v_user.tg_user_hash = p_tg_user_hash)
          and (v_owner is null or v_owner is not distinct from v_account) then
      if v_account is not null and exists (select 1 from app.vendor_users x
                                           where x.account_id = v_account and x.vendor_id = v_user.vendor_id) then
        v_taken := true;
      else
        v_bindable := v_bindable || v_user.id;
      end if;
    end if;
  end loop;

  if not v_found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::app.locale;
    return;
  end if;

  if cardinality(v_bindable) = 0 then
    if v_mine then
      update pii.vendor_user_profiles p set telegram_chat_id = p_chat_id
      from app.vendor_users u
      where u.id = p.vendor_user_id and u.phone_hash = p_phone_hash and u.account_id = v_account
        and p.telegram_chat_id is distinct from p_chat_id;
      return query select 'linked'::text, u.id, u.vendor_id, u.locale from app.vendor_users u where u.id = v_first;
    elsif v_taken then
      return query select 'telegram_taken'::text, null::uuid, null::uuid, null::app.locale;
    else
      return query select 'linked_elsewhere'::text, null::uuid, null::uuid, null::app.locale;
    end if;
    return;
  end if;

  if v_account is null then
    v_account := app.telegram_account(p_tg_user_hash, true,
                   (select u.locale from app.vendor_users u where u.id = v_bindable[1]), 'telegram', 'partner_bot');
  end if;

  update app.vendor_users u
  set account_id = v_account, tg_user_hash = p_tg_user_hash, tg_linked_at = coalesce(u.tg_linked_at, now())
  where u.id = any (v_bindable);
  insert into pii.vendor_user_profiles (vendor_user_id, phone, telegram_user_id, telegram_chat_id)
  select u.id, p_phone, p_telegram_user_id, p_chat_id from app.vendor_users u where u.id = any (v_bindable)
  on conflict on constraint vendor_user_profiles_pkey do update
    set telegram_user_id = excluded.telegram_user_id, telegram_chat_id = excluded.telegram_chat_id;

  insert into app.account_identities (account_id, kind, value_hash) values (v_account, 'phone', p_phone_hash)
  on conflict do nothing;
  get diagnostics v_added = row_count;
  insert into pii.account_profiles as ap (account_id, telegram_id, phone, phone_verified_at)
  values (v_account, p_telegram_user_id,
          case when v_added > 0 then p_phone end, case when v_added > 0 then now() end)
  on conflict (account_id) do update
    set telegram_id = coalesce(ap.telegram_id, excluded.telegram_id),
        phone = coalesce(excluded.phone, ap.phone),
        phone_verified_at = coalesce(excluded.phone_verified_at, ap.phone_verified_at);

  -- в журнал — только id, без номера и Telegram ID
  insert into app.audit_log (actor_kind, actor_id, action, object_type, object_id, detail, source)
  select 'system', null, 'vendor_user.telegram_claim', 'vendor_user', u.id::text,
         jsonb_build_object('vendor_id', u.vendor_id), 'partner_bot'
  from app.vendor_users u where u.id = any (v_bindable);

  return query
    select 'claimed'::text, u.id, u.vendor_id, u.locale
    from app.vendor_users u where u.id = v_bindable[1];
end $$;

-- Человек написал боту (/start): теперь бот может ему писать. По аккаунту этого
-- Telegram: клиенту — can_message, действующему сотруднику и каждому
-- пользователю вендора — чат для уведомлений. Никого не создаёт
create or replace function app.telegram_started(p_tg_hash bytea, p_chat_id bigint)
returns table (staff boolean, vendor boolean)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_account uuid;
  v_staff   uuid;
  v_vendors int;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if octet_length(p_tg_hash) is distinct from 32 or p_chat_id is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  v_account := app.telegram_account(p_tg_hash, false, null, 'telegram', 'partner_bot');
  if v_account is null then
    return query select false, false;
    return;
  end if;

  update app.clients c set can_message = true where c.account_id = v_account and not c.can_message;

  select s.id into v_staff from app.staff s where s.account_id = v_account and s.active;
  if v_staff is not null then
    update pii.staff_profiles p set telegram_chat_id = p_chat_id
    where p.staff_id = v_staff and p.telegram_chat_id is distinct from p_chat_id;
  end if;

  update pii.vendor_user_profiles p set telegram_chat_id = p_chat_id
  from app.vendor_users u
  where u.id = p.vendor_user_id and u.account_id = v_account and u.disabled_at is null
    and u.tg_user_hash = p_tg_hash and p.telegram_chat_id is distinct from p_chat_id;
  select count(*) into v_vendors from app.vendor_users u
  where u.account_id = v_account and u.disabled_at is null and u.tg_user_hash = p_tg_hash;

  return query select v_staff is not null, v_vendors > 0;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- RLS и права
-- ════════════════════════════════════════════════════════════════════════════

alter table app.accounts enable row level security;
alter table app.account_identities enable row level security;
alter table pii.account_profiles enable row level security;
alter table app.hub_codes enable row level security;

-- Аккаунт видит только себя; staff и system — все. Пишут только функции выше
create policy accounts_read on app.accounts for select to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'account' and id = (select app.actor_id())));
create policy account_identities_read on app.account_identities for select to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'account' and account_id = (select app.actor_id())));
create policy account_profiles_read on pii.account_profiles for select to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'account' and account_id = (select app.actor_id())));

-- Коды хаба выдаёт и погашает только система (API после проверки сессии и PKCE)
create policy hub_codes_system on app.hub_codes for all to bayramm_api
  using ((select app.actor_kind()) = 'system') with check ((select app.actor_kind()) = 'system');

-- Сессии: аккаунт видит и отзывает свои (все виды, включая сессии сотрудника)
drop policy sessions_read on app.sessions;
create policy sessions_read on app.sessions for select to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'account' and account_id = (select app.actor_id()))
         or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id()))
         or ((select app.actor_kind()) = 'vendor_user' and vendor_user_id = (select app.actor_id())));
drop policy sessions_update on app.sessions;
create policy sessions_update on app.sessions for update to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'account' and account_id = (select app.actor_id()))
         or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id()))
         or ((select app.actor_kind()) = 'vendor_user' and vendor_user_id = (select app.actor_id())))
  with check ((select app.is_privileged())
              or ((select app.actor_kind()) = 'account' and account_id = (select app.actor_id()))
              or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id()))
              or ((select app.actor_kind()) = 'vendor_user' and vendor_user_id = (select app.actor_id())));

grant select on app.accounts, app.account_identities to bayramm_api;
-- телефон аккаунта через SELECT не читается
grant select (account_id, telegram_id, telegram_username, first_name, last_name, phone_verified_at, updated_at)
  on pii.account_profiles to bayramm_api;
grant select, insert, update, delete on app.hub_codes to bayramm_api;

revoke execute on all functions in schema app, pii from public;
grant execute on function
  app.account_sign_in_telegram(bytea, bigint, text, text, text, app.locale, app.source),
  app.account_sign_in_phone(bytea, text, app.locale, app.source),
  app.account_ensure_client(uuid, app.locale, boolean),
  app.staff_elevate(uuid, timestamptz, bytea, text),
  app.account_link_telegram(bytea, bigint, text, text, text),
  app.account_link_phone(bytea, text, app.source),
  app.account_me(),
  app.account_delete(app.source, bytea),
  app.otp_issue(bytea, bytea, bytea, text, int),
  app.otp_check(bytea, bytea),
  app.otp_sent(uuid, text)
  to bayramm_api;
