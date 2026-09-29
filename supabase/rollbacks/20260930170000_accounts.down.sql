-- Откат миграции 20260930170000_accounts.sql.
--
-- Только для локальной разработки и проверки в CI (up → down → up). На
-- staging/production откат — новая миграция «вперёд»; после ручного отката:
-- supabase migration repair --status reverted <версия>.
-- Сессии аккаунтов (новых видов) удаляются: у прежней схемы для них нет субъекта.
-- Записи account.*, staff.elevate и другие в app.audit_log остаются: журнал только на добавление.
-- Значение 'account' перечисления app.actor_kind остаётся: Postgres значения не
-- удаляет, тип целиком удаляет откат миграции 1.

-- ── функции до аккаунтов — прежние тела ─────────────────────────────────────
create or replace function app.staff_sign_in(p_tg_id_hash bytea, p_telegram_id bigint, p_username text)
returns table (staff_id uuid, role app.staff_role, display_name text, telegram_username text, claimed boolean)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_username text := nullif(lower(ltrim(btrim(p_username), '@')), '');
  v_id       uuid;
  v_active   boolean;
  v_claimed  boolean := false;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if octet_length(p_tg_id_hash) is distinct from 32 or p_telegram_id is null or p_telegram_id <= 0 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  select s.id, s.active into v_id, v_active from app.staff s where s.tg_id_hash = p_tg_id_hash;

  if v_id is null and v_username is not null then
    begin
      -- Строку приглашения блокирует UPDATE: второй параллельный вход ждёт и после
      -- снятия блокировки видит tg_id_hash уже заполненным — ничего не обновляет
      update app.staff s
      set tg_id_hash = p_tg_id_hash, tg_linked_at = now()
      from pii.staff_profiles p
      where p.staff_id = s.id and p.telegram_username = v_username
        and s.active and s.tg_id_hash is null
      returning s.id into v_id;
      if v_id is not null then
        update pii.staff_profiles p set telegram_id = p_telegram_id where p.staff_id = v_id;
        v_active := true;
        v_claimed := true;
      end if;
    exception when unique_violation then
      -- этот Telegram ID (или его хэш) уже у другого сотрудника: привязки нет
      v_id := null;
      v_claimed := false;
    end;

    if not v_claimed then
      -- параллельный вход того же человека мог принять приглашение раньше нас
      select s.id, s.active into v_id, v_active from app.staff s where s.tg_id_hash = p_tg_id_hash;
    end if;
  end if;

  if v_id is null or not v_active then
    return;
  end if;

  if v_claimed then
    -- в журнал — только id и код роли, без имени и Telegram ID
    insert into app.audit_log (actor_kind, actor_id, action, object_type, object_id, detail, source)
    select 'system', null, 'staff.telegram_claim', 'staff', s.id::text, jsonb_build_object('role', s.role), 'admin'
    from app.staff s where s.id = v_id;
  end if;

  return query
    select s.id, s.role, p.display_name, p.telegram_username, v_claimed
    from app.staff s
    join pii.staff_profiles p on p.staff_id = s.id
    where s.id = v_id;
end $$;
create or replace function app.vendor_user_claim_telegram(p_phone_hash bytea, p_phone text, p_tg_user_hash bytea,
                                               p_telegram_user_id bigint, p_chat_id bigint)
returns table (result text, vendor_user_id uuid, vendor_id uuid, locale app.locale)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user app.vendor_users;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if octet_length(p_phone_hash) is distinct from 32 or octet_length(p_tg_user_hash) is distinct from 32
     or p_phone is null or p_phone !~ '^\+998[0-9]{9}$'
     or p_telegram_user_id is null or p_telegram_user_id <= 0 or p_chat_id is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  -- Строка блокируется: параллельные привязки одного номера идут по очереди
  select u.* into v_user from app.vendor_users u
  where u.phone_hash = p_phone_hash and u.disabled_at is null
  for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::app.locale;
    return;
  end if;

  if v_user.tg_user_hash = p_tg_user_hash then
    update pii.vendor_user_profiles p set telegram_chat_id = p_chat_id
    where p.vendor_user_id = v_user.id and p.telegram_chat_id is distinct from p_chat_id;
    return query select 'linked'::text, v_user.id, v_user.vendor_id, v_user.locale;
    return;
  end if;
  if v_user.tg_user_hash is not null then
    return query select 'linked_elsewhere'::text, null::uuid, null::uuid, null::app.locale;
    return;
  end if;

  begin
    update app.vendor_users u set tg_user_hash = p_tg_user_hash, tg_linked_at = now() where u.id = v_user.id;
    insert into pii.vendor_user_profiles (vendor_user_id, phone, telegram_user_id, telegram_chat_id)
    values (v_user.id, p_phone, p_telegram_user_id, p_chat_id)
    on conflict on constraint vendor_user_profiles_pkey do update
      set telegram_user_id = excluded.telegram_user_id, telegram_chat_id = excluded.telegram_chat_id;
  exception when unique_violation then
    -- этот Telegram (или его хэш) уже у другого пользователя вендора
    return query select 'telegram_taken'::text, null::uuid, null::uuid, null::app.locale;
    return;
  end;

  -- в журнал — только id, без номера и Telegram ID
  insert into app.audit_log (actor_kind, actor_id, action, object_type, object_id, detail, source)
  values ('system', null, 'vendor_user.telegram_claim', 'vendor_user', v_user.id::text,
          jsonb_build_object('vendor_id', v_user.vendor_id), 'partner_bot');

  return query select 'claimed'::text, v_user.id, v_user.vendor_id, v_user.locale;
end $$;
create or replace function app.telegram_started(p_tg_hash bytea, p_chat_id bigint)
returns table (staff boolean, vendor boolean)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_staff  uuid;
  v_vendor uuid;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if octet_length(p_tg_hash) is distinct from 32 or p_chat_id is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  update app.clients c set can_message = true
  where c.tg_id_hash = p_tg_hash and not c.can_message;

  select s.id into v_staff from app.staff s where s.tg_id_hash = p_tg_hash and s.active;
  if v_staff is not null then
    update pii.staff_profiles p set telegram_chat_id = p_chat_id
    where p.staff_id = v_staff and p.telegram_chat_id is distinct from p_chat_id;
  end if;

  select u.id into v_vendor from app.vendor_users u
  where u.tg_user_hash = p_tg_hash and u.disabled_at is null;
  if v_vendor is not null then
    update pii.vendor_user_profiles p set telegram_chat_id = p_chat_id
    where p.vendor_user_id = v_vendor and p.telegram_chat_id is distinct from p_chat_id;
  end if;

  return query select v_staff is not null, v_vendor is not null;
end $$;

-- ── новые функции ───────────────────────────────────────────────────────────
drop function if exists
  app.otp_sent(uuid, text),
  app.otp_check(bytea, bytea),
  app.otp_issue(bytea, bytea, bytea, text, int),
  app.account_delete(app.source, bytea),
  app.account_me(),
  app.account_link_phone(bytea, text, app.source),
  app.account_link_telegram(bytea, bigint, text, text, text),
  app.staff_elevate(uuid, timestamptz, bytea, text),
  app.account_ensure_client(uuid, app.locale, boolean),
  app.account_sign_in_phone(bytea, text, app.locale, app.source),
  app.account_sign_in_telegram(bytea, bigint, text, text, text, app.locale, app.source),
  app.accounts_backfill();

comment on column app.otp_codes.code_hash is null;

-- ── триггеры ────────────────────────────────────────────────────────────────
drop trigger if exists accounts_revoke_sessions on app.accounts;
drop trigger if exists staff_revoke_sessions on app.staff;
drop trigger if exists clients_account_guard on app.clients;
drop trigger if exists staff_account_guard on app.staff;
drop trigger if exists vendor_users_account_guard on app.vendor_users;
drop trigger if exists sessions_fill_account on app.sessions;
drop trigger if exists clients_fill_account on app.clients;
drop function if exists
  app.accounts_revoke_sessions(),
  app.staff_revoke_sessions(),
  app.clients_account_guard(),
  app.membership_account_guard(),
  app.sessions_fill_account(),
  app.clients_fill_account(),
  app.account_bind_phone(uuid, bytea, app.source),
  app.account_accept_staff_invite(uuid, text, bytea, bigint),
  app.telegram_account(bytea, boolean, app.locale, text, app.source),
  app.account_bind_telegram_rows(uuid, bytea),
  app.account_new(app.locale, text, app.source);

-- ── сессии ──────────────────────────────────────────────────────────────────
drop policy if exists sessions_read on app.sessions;
drop policy if exists sessions_update on app.sessions;
create policy sessions_read on app.sessions for select to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id()))
         or ((select app.actor_kind()) = 'vendor_user' and vendor_user_id = (select app.actor_id())));
create policy sessions_update on app.sessions for update to bayramm_api
  using ((select app.is_privileged())
         or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id()))
         or ((select app.actor_kind()) = 'vendor_user' and vendor_user_id = (select app.actor_id())))
  with check ((select app.is_privileged())
              or ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id()))
              or ((select app.actor_kind()) = 'vendor_user' and vendor_user_id = (select app.actor_id())));

delete from app.sessions where num_nonnulls(client_id, vendor_user_id, staff_id) = 0 or via = 'staff_elevation';
drop index if exists app.sessions_account;
alter table app.sessions
  drop constraint if exists sessions_account_ttl,
  drop constraint if exists sessions_staff_proof,
  drop constraint if exists sessions_staff_ttl,
  add constraint sessions_staff_ttl check (via <> 'tg_staff' or expires_at <= created_at + interval '12 hours'),
  drop constraint if exists sessions_staff_via,
  add constraint sessions_staff_via check ((via = 'tg_staff') = (staff_id is not null)),
  drop constraint if exists sessions_one_subject,
  add constraint sessions_one_subject check (num_nonnulls(client_id, vendor_user_id, staff_id) = 1),
  drop constraint if exists sessions_via_check,
  add constraint sessions_via_check check (via in ('tg_client', 'tg_partner', 'sms_otp', 'tg_staff')),
  drop column if exists proof_at,
  drop column if exists app,
  drop column if exists account_id;

-- ── членства ────────────────────────────────────────────────────────────────
comment on column app.staff.tg_id_hash is
  'HMAC-SHA256(ID_HASH_KEY, Telegram ID); null — приглашение ещё не принято';
drop index if exists app.staff_phone_invite;
alter table app.staff drop column if exists phone_hash, drop column if exists account_id;

alter table pii.vendor_user_profiles
  add constraint vendor_user_profiles_telegram_user_id_key unique (telegram_user_id);
drop index if exists app.vendor_users_tg_user;
alter table app.vendor_users add constraint vendor_users_tg_user_hash_key unique (tg_user_hash);
comment on column app.vendor_users.tg_user_hash is null;
drop index if exists app.vendor_users_account_vendor;
drop index if exists app.vendor_users_phone;
alter table app.vendor_users
  drop constraint if exists vendor_users_vendor_phone_key,
  add constraint vendor_users_phone_hash_key unique (phone_hash);
alter table app.vendor_users drop column if exists account_id;

comment on column app.clients.tg_id_hash is null;
alter table app.clients drop constraint if exists clients_account_key, drop column if exists account_id;
alter table app.clients alter column tg_id_hash set not null;

-- ── аккаунты ────────────────────────────────────────────────────────────────
drop table if exists app.hub_codes;
drop table if exists pii.account_profiles;
drop table if exists app.account_identities;
drop table if exists app.accounts;
drop type if exists app.identity_kind;
