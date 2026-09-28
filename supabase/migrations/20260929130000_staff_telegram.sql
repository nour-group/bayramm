-- ════════════════════════════════════════════════════════════════════════════
-- Миграция 3 — вход сотрудников через Telegram.
--
--   · сотрудника приглашают по имени пользователя Telegram
--     (pii.staff_profiles.telegram_username); при первом входе приглашение
--     привязывается к постоянному Telegram ID — app.staff.tg_id_hash =
--     HMAC(ID_HASH_KEY, Telegram ID), та же схема, что у клиентов. Дальше в
--     счёт идёт только id: смена имени в Telegram вход не ломает;
--   · e-mail больше не обязателен — вход не по нему;
--   · сессии сотрудников — app.sessions.staff_id, via = 'tg_staff', не дольше
--     12 часов;
--   · найти или привязать сотрудника может только app.staff_sign_in под
--     актором system; каждая привязка — в app.audit_log.
--
-- Приглашение (SQL, сотрудников в v0.1 заводят вручную):
--   with s as (insert into app.staff (role) values ('moderator') returning id)
--   insert into pii.staff_profiles (staff_id, display_name, telegram_username)
--   select id, 'Имя Фамилия', '@username' from s;
--
-- Откат: supabase/rollbacks/20260929130000_staff_telegram.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── сотрудники: привязка к Telegram ─────────────────────────────────────────
alter table app.staff
  add column tg_id_hash   bytea unique check (octet_length(tg_id_hash) = 32),
  add column tg_linked_at timestamptz,
  add constraint staff_tg_link_consistent check ((tg_id_hash is null) = (tg_linked_at is null));

comment on column app.staff.tg_id_hash is
  'HMAC-SHA256(ID_HASH_KEY, Telegram ID); null — приглашение ещё не принято';

alter table pii.staff_profiles
  alter column email drop not null,
  -- имя, по которому пригласили: нижний регистр, без «@» (приводит триггер)
  add column telegram_username text check (telegram_username ~ '^[a-z0-9_]{5,32}$'),
  -- ставится при первом входе вместе с app.staff.tg_id_hash
  add column telegram_id bigint unique check (telegram_id > 0);

-- Сотрудники заводились под вход через Cloudflare Access — комментарий устарел
comment on table app.staff is
  'Сотрудники. Вход — виджет Telegram: приглашение по имени пользователя, после первого входа — по Telegram ID';

-- ── одно имя — один действующий сотрудник ───────────────────────────────────
-- Среди действующих (привязанных и ещё нет) имя пользователя уникально: иначе
-- приглашение нельзя принять однозначно, а человек, занявший освободившееся
-- имя, принял бы второе приглашение уже привязанного сотрудника. Отключённые
-- в счёт не идут. Строки в двух таблицах — поэтому не индекс, а проверка в
-- триггерах под advisory-блокировкой имени: параллельные вставки одного имени
-- проверяются по очереди
create function app.assert_staff_username_free(p_username text, p_staff uuid) returns void
language plpgsql set search_path = ''
as $$
begin
  if p_username is null then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bayramm.staff_username:' || p_username, 0));
  if exists (select 1
             from pii.staff_profiles p
             join app.staff s on s.id = p.staff_id
             where p.telegram_username = p_username and s.active and p.staff_id <> p_staff) then
    raise exception 'staff_username_taken' using errcode = '23505',
      constraint = 'staff_profiles_telegram_username_active',
      detail = 'имя пользователя Telegram уже у действующего сотрудника';
  end if;
end $$;

-- Имя приводится к виду, в котором его присылает виджет (без «@», нижний регистр);
-- новое имя действующего сотрудника проверяется на занятость
create function app.staff_profiles_username_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.telegram_username := nullif(lower(ltrim(btrim(new.telegram_username), '@')), '');
  if (tg_op = 'INSERT' or new.telegram_username is distinct from old.telegram_username)
     and exists (select 1 from app.staff s where s.id = new.staff_id and s.active) then
    perform app.assert_staff_username_free(new.telegram_username, new.staff_id);
  end if;
  return new;
end $$;
create trigger staff_profiles_username_guard before insert or update on pii.staff_profiles
  for each row execute function app.staff_profiles_username_guard();

-- Сотрудник: id неизменен; привязку к Telegram нельзя перевесить на другой
-- аккаунт — только снять (оба поля в null) и дать принять приглашение заново;
-- при включении отключённого сотрудника его имя снова проверяется на занятость
create function app.staff_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_username text;
begin
  if new.id <> old.id or new.created_at <> old.created_at then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;
  if old.tg_id_hash is not null and new.tg_id_hash is not null and new.tg_id_hash <> old.tg_id_hash then
    raise exception 'immutable_column' using errcode = 'BR006',
      detail = 'привязку к Telegram можно только снять, но не перевесить';
  end if;
  if new.active and not old.active then
    select p.telegram_username into v_username from pii.staff_profiles p where p.staff_id = new.id;
    perform app.assert_staff_username_free(v_username, new.id);
  end if;
  return new;
end $$;
create trigger staff_guard before update on app.staff
  for each row execute function app.staff_guard();

-- ── сессии сотрудников ──────────────────────────────────────────────────────
-- via — текст с CHECK (не перечисление): расширяем список пересозданием
-- ограничения. Субъект сессии — ровно один из клиента, пользователя вендора и
-- сотрудника; сессия сотрудника живёт не дольше 12 часов
alter table app.sessions
  add column staff_id uuid references app.staff,
  drop constraint sessions_via_check,
  add constraint sessions_via_check check (via in ('tg_client', 'tg_partner', 'sms_otp', 'tg_staff')),
  drop constraint sessions_check,
  add constraint sessions_one_subject check (num_nonnulls(client_id, vendor_user_id, staff_id) = 1),
  add constraint sessions_staff_via check ((via = 'tg_staff') = (staff_id is not null)),
  add constraint sessions_staff_ttl check (via <> 'tg_staff' or expires_at <= created_at + interval '12 hours');
create index sessions_staff on app.sessions (staff_id) where staff_id is not null;

-- RLS сессий не меняется: сотрудник — привилегированный актор (app.is_privileged),
-- свою сессию он читает и отзывает по политикам sessions_read / sessions_update

-- ── вход сотрудника ─────────────────────────────────────────────────────────
-- API вызывает после проверки подписи виджета Telegram, под актором system.
-- Возвращает действующего сотрудника или ничего:
--   1. сотрудник уже привязан к этому Telegram ID — он (имя пользователя не важно);
--   2. иначе — действующее, ещё не принятое приглашение с этим именем: оно
--      привязывается к Telegram ID атомарно (одно приглашение — один аккаунт);
--   3. отключённый сотрудник, чужое или уже принятое приглашение — ничего.
-- Почему ничего — наружу не говорим: API отвечает одним и тем же 403
create function app.staff_sign_in(p_tg_id_hash bytea, p_telegram_id bigint, p_username text)
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

comment on function app.staff_sign_in(bytea, bigint, text) is
  'Вход сотрудника по данным виджета Telegram: найти по Telegram ID или принять приглашение по имени. Только актор system';

-- ── права ───────────────────────────────────────────────────────────────────
-- Привязывает только app.staff_sign_in: UPDATE на app.staff у API нет
revoke execute on all functions in schema app, pii from public;
grant execute on function app.staff_sign_in(bytea, bigint, text) to bayramm_api;
