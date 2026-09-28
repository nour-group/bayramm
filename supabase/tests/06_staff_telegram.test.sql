-- Вход сотрудников через Telegram: приглашение по имени, привязка к Telegram ID,
-- app.staff_sign_in, сессии сотрудников
begin;
\ir _fixtures.psql
select plan(40);

-- ── структура и права ───────────────────────────────────────────────────────
select col_is_null('pii', 'staff_profiles', 'email', 'e-mail сотрудника необязателен');
select col_is_unique('app', 'staff', array['tg_id_hash'], 'один Telegram-аккаунт — один сотрудник');
select col_is_unique('pii', 'staff_profiles', array['telegram_id'], 'Telegram ID в профилях не повторяется');
select ok(has_function_privilege('bayramm_api', 'app.staff_sign_in(bytea, bigint, text)', 'EXECUTE'),
  'API входит через app.staff_sign_in');
select ok(not has_function_privilege('bayramm_api', 'app.assert_staff_username_free(text, uuid)', 'EXECUTE'),
  'служебная проверка имени API недоступна');
select ok(not has_table_privilege('bayramm_api', 'app.staff', 'UPDATE'),
  'API не привязывает сотрудников в обход функции');
select ok(not has_table_privilege('bayramm_api', 'pii.staff_profiles', 'UPDATE'),
  'API не меняет профили сотрудников');

-- ── приглашения ─────────────────────────────────────────────────────────────
--   b001 moderator — приглашение «@Test_Moderator»
--   b002 manager   — приглашение test_manager
--   b003 admin     — отключённое приглашение test_disabled
--   b004 moderator — для проверок формата и занятости имени
insert into app.staff (id, role) values
  ('00000000-0000-0000-0000-00000000b001', 'moderator'),
  ('00000000-0000-0000-0000-00000000b002', 'manager'),
  ('00000000-0000-0000-0000-00000000b003', 'admin'),
  ('00000000-0000-0000-0000-00000000b004', 'moderator');
insert into pii.staff_profiles (staff_id, display_name, telegram_username) values
  ('00000000-0000-0000-0000-00000000b001', 'Test Moderator', '  @Test_Moderator '),
  ('00000000-0000-0000-0000-00000000b002', 'Test Manager', 'test_manager'),
  ('00000000-0000-0000-0000-00000000b003', 'Test Disabled', 'test_disabled');
update app.staff set active = false where id = '00000000-0000-0000-0000-00000000b003';

select results_eq(
  $$select telegram_username, email from pii.staff_profiles where staff_id = '00000000-0000-0000-0000-00000000b001'$$,
  $$values ('test_moderator'::text, null::text)$$,
  'имя хранится без «@» и пробелов, в нижнем регистре; e-mail не нужен');
select throws_ok(
  $$insert into pii.staff_profiles (staff_id, display_name, telegram_username)
    values ('00000000-0000-0000-0000-00000000b004', 'X', 'abc')$$,
  '23514', null, 'имя короче 5 символов не принимается');
select throws_ok(
  $$insert into pii.staff_profiles (staff_id, display_name, telegram_username)
    values ('00000000-0000-0000-0000-00000000b004', 'X', 'bad-name!')$$,
  '23514', null, 'имя только из латиницы, цифр и _');
select throws_ok(
  $$insert into pii.staff_profiles (staff_id, display_name, telegram_username)
    values ('00000000-0000-0000-0000-00000000b004', 'X', '@TEST_MANAGER')$$,
  '23505', null, 'имя уже у действующего сотрудника — второе приглашение не создаётся');
select lives_ok(
  $$insert into pii.staff_profiles (staff_id, display_name, telegram_username)
    values ('00000000-0000-0000-0000-00000000b004', 'X', 'test_disabled')$$,
  'имя отключённого сотрудника можно отдать новому');
select throws_ok(
  $$update app.staff set active = true where id = '00000000-0000-0000-0000-00000000b003'$$,
  '23505', null, 'включить сотрудника, чьё имя уже занято, нельзя');
select throws_ok(
  $$update pii.staff_profiles set telegram_username = 'test_moderator'
    where staff_id = '00000000-0000-0000-0000-00000000b004'$$,
  '23505', null, 'сменить имя на занятое нельзя');
update pii.staff_profiles set telegram_username = 'test_spare' where staff_id = '00000000-0000-0000-0000-00000000b004';

-- ── app.staff_sign_in: только под system ────────────────────────────────────
set local role bayramm_api;

select pg_temp.as_actor(null);
select throws_ok(
  $$select * from app.staff_sign_in(sha256('tg-7001'), 7001, 'test_moderator')$$,
  'BR003', 'forbidden_for_actor', 'без актора вход не выполняется');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok(
  $$select * from app.staff_sign_in(sha256('tg-7001'), 7001, 'test_moderator')$$,
  'BR003', 'forbidden_for_actor', 'даже сотрудник не вызывает вход за другого');

select pg_temp.as_actor('system');
select throws_ok(
  $$select * from app.staff_sign_in('\x00'::bytea, 7001, 'test_moderator')$$,
  '22023', null, 'хэш не 32 байта — ошибка вызова');

-- первый вход принимает приглашение: имя сравнивается без учёта регистра и «@»
select results_eq(
  $$select staff_id, role::text, display_name, telegram_username, claimed
    from app.staff_sign_in(sha256('tg-7001'), 7001, '@Test_Moderator')$$,
  $$values ('00000000-0000-0000-0000-00000000b001'::uuid, 'moderator'::text, 'Test Moderator'::text,
            'test_moderator'::text, true)$$,
  'приглашение принято по имени');
select results_eq(
  $$select tg_id_hash = sha256('tg-7001'), tg_linked_at is not null
    from app.staff where id = '00000000-0000-0000-0000-00000000b001'$$,
  $$values (true, true)$$,
  'приглашение привязано к HMAC Telegram ID');

-- принятое приглашение не перепривязывается
select is_empty(
  $$select * from app.staff_sign_in(sha256('tg-7002'), 7002, 'test_moderator')$$,
  'другой Telegram-аккаунт с тем же именем не входит');
select is_empty(
  $$select * from app.staff_sign_in(sha256('tg-7002'), 7002, '@TEST_MODERATOR')$$,
  'и с тем же именем в другом регистре тоже');

-- дальше в счёт идёт только id
select results_eq(
  $$select staff_id, claimed from app.staff_sign_in(sha256('tg-7001'), 7001, 'renamed_user')$$,
  $$values ('00000000-0000-0000-0000-00000000b001'::uuid, false)$$,
  'привязанный сотрудник входит по id и после смены имени');
select results_eq(
  $$select staff_id from app.staff_sign_in(sha256('tg-7001'), 7001, null)$$,
  $$values ('00000000-0000-0000-0000-00000000b001'::uuid)$$,
  'и совсем без имени');

select is_empty(
  $$select * from app.staff_sign_in(sha256('tg-7003'), 7003, 'nobody_here')$$,
  'неизвестное имя — ничего');
select is_empty(
  $$select * from app.staff_sign_in(sha256('tg-7004'), 7004, 'test_disabled')$$,
  'отключённое приглашение — ничего');
select is(
  (select tg_id_hash from app.staff where id = '00000000-0000-0000-0000-00000000b003'), null,
  'отключённое приглашение осталось непринятым');
select is_empty(
  $$select * from app.staff_sign_in(sha256('tg-7005'), 7005, '')$$,
  'пустое имя — ничего');

-- каждая привязка — в журнале, без ПДн. Журнал не чистится (только добавление):
-- смотрим лишь на сотрудников этого теста
select results_eq(
  $$select actor_kind::text, actor_id, object_type, object_id, detail, source::text
    from app.audit_log
    where action = 'staff.telegram_claim' and object_id like '00000000-0000-0000-0000-00000000b%'$$,
  $$values ('system'::text, null::uuid, 'staff'::text, '00000000-0000-0000-0000-00000000b001'::text,
            '{"role": "moderator"}'::jsonb, 'admin'::text)$$,
  'одна привязка — одна запись в журнале');

reset role;
select is(
  (select telegram_id from pii.staff_profiles where staff_id = '00000000-0000-0000-0000-00000000b001'), 7001::bigint,
  'Telegram ID — только в pii');

-- ── отключение и привязка ───────────────────────────────────────────────────
update app.staff set active = false where id = '00000000-0000-0000-0000-00000000b001';
set local role bayramm_api;
select pg_temp.as_actor('system');
select is_empty(
  $$select * from app.staff_sign_in(sha256('tg-7001'), 7001, 'test_moderator')$$,
  'отключённый сотрудник не входит');
reset role;

select throws_ok(
  $$update app.staff set tg_id_hash = sha256('tg-9999') where id = '00000000-0000-0000-0000-00000000b001'$$,
  'BR006', 'immutable_column', 'привязку нельзя перевесить на другой аккаунт');
select throws_ok(
  $$update app.staff set tg_linked_at = now() where id = '00000000-0000-0000-0000-00000000b002'$$,
  '23514', null, 'время привязки — только вместе с привязкой');
select lives_ok(
  $$update app.staff set tg_id_hash = null, tg_linked_at = null where id = '00000000-0000-0000-0000-00000000b001'$$,
  'привязку можно снять');

-- привязка атомарна: Telegram ID уже в другом профиле — приглашение не принимается
set local role bayramm_api;
select pg_temp.as_actor('system');
select is_empty(
  $$select * from app.staff_sign_in(sha256('tg-7001'), 7001, 'test_manager')$$,
  'Telegram ID занят другим профилем — ничего');
select is(
  (select tg_id_hash from app.staff where id = '00000000-0000-0000-0000-00000000b002'), null,
  'и приглашение не привязалось наполовину');
reset role;

-- ── сессии сотрудников ──────────────────────────────────────────────────────
select lives_ok(
  $$insert into app.sessions (token_hash, staff_id, via, expires_at)
    values (sha256('staff-session-1'), '00000000-0000-0000-0000-00000000b002', 'tg_staff', now() + interval '12 hours')$$,
  'сессия сотрудника на 12 часов');
select throws_ok(
  $$insert into app.sessions (token_hash, staff_id, via, expires_at)
    values (sha256('staff-session-2'), '00000000-0000-0000-0000-00000000b002', 'tg_staff', now() + interval '13 hours')$$,
  '23514', null, 'дольше 12 часов — нельзя');
select throws_ok(
  $$insert into app.sessions (token_hash, client_id, via, expires_at)
    values (sha256('staff-session-3'), 'cccccccc-0000-0000-0000-000000000001', 'tg_staff', now() + interval '1 hour')$$,
  '23514', null, 'tg_staff — только сессия сотрудника');
select throws_ok(
  $$insert into app.sessions (token_hash, staff_id, via, expires_at)
    values (sha256('staff-session-4'), '00000000-0000-0000-0000-00000000b002', 'tg_client', now() + interval '1 hour')$$,
  '23514', null, 'сотрудник не входит как клиент');
select throws_ok(
  $$insert into app.sessions (token_hash, client_id, staff_id, via, expires_at)
    values (sha256('staff-session-5'), 'cccccccc-0000-0000-0000-000000000001',
            '00000000-0000-0000-0000-00000000b002', 'tg_staff', now() + interval '1 hour')$$,
  '23514', null, 'у сессии ровно один субъект');

select * from finish();
rollback;
