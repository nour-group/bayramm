-- Один аккаунт на человека: способы входа, роли-членства, перенос старых строк,
-- вход по Telegram и телефону, привязка способов, сессии сотрудника по свежему
-- доказательству, коды из сообщения, удаление аккаунта
begin;
\ir _fixtures.psql
select plan(102);

-- Аккаунты теста по коротким именам: a, b — Telegram; p — телефон
create temp table acc (k text primary key, id uuid not null) on commit drop;
grant select, insert on acc to bayramm_api;

-- ════════════════════════════════════════════════════════════════════════════
-- Структура и права
-- ════════════════════════════════════════════════════════════════════════════
select ok((select relrowsecurity from pg_class where oid = 'app.accounts'::regclass)
          and (select relrowsecurity from pg_class where oid = 'app.account_identities'::regclass)
          and (select relrowsecurity from pg_class where oid = 'pii.account_profiles'::regclass)
          and (select relrowsecurity from pg_class where oid = 'app.hub_codes'::regclass),
  'RLS включён на аккаунтах, способах входа, профилях и кодах хаба');
select col_is_unique('app', 'account_identities', array['kind', 'value_hash'], 'одно значение — один аккаунт');
select col_is_unique('app', 'clients', array['account_id'], 'у аккаунта не больше одного клиента');
select col_not_null('app', 'clients', 'account_id', 'клиент без аккаунта не бывает');
select col_not_null('app', 'sessions', 'account_id', 'сессия без аккаунта не бывает');
select is_empty(
  $$select t || ' ' || p from unnest(array['app.accounts', 'app.account_identities', 'pii.account_profiles']) t,
                              unnest(array['INSERT', 'UPDATE', 'DELETE']) p
    where has_table_privilege('bayramm_api', t, p)$$,
  'аккаунты, способы входа и профили API не пишет в обход функций');
select ok(not has_column_privilege('bayramm_api', 'pii.account_profiles', 'phone', 'SELECT'),
  'телефон аккаунта через SELECT не читается');
select is_empty(
  $$select f from unnest(array[
      'app.account_sign_in_telegram(bytea, bigint, text, text, text, app.locale, app.source)',
      'app.account_sign_in_phone(bytea, text, app.locale, app.source)',
      'app.account_ensure_client(uuid, app.locale, boolean)',
      'app.staff_elevate(uuid, timestamptz, bytea, text)',
      'app.account_link_telegram(bytea, bigint, text, text, text)',
      'app.account_link_phone(bytea, text, app.source)',
      'app.account_me()', 'app.account_delete(app.source, bytea)',
      'app.otp_issue(bytea, bytea, bytea, text, integer)', 'app.otp_check(bytea, bytea)',
      'app.otp_sent(uuid, text)']) f
    where not has_function_privilege('bayramm_api', f, 'EXECUTE')$$,
  'API вызывает функции входа, привязки, своего аккаунта и кодов');
select is_empty(
  $$select f from unnest(array[
      'app.accounts_backfill()', 'app.account_new(app.locale, text, app.source)',
      'app.telegram_account(bytea, boolean, app.locale, text, app.source)',
      'app.account_bind_telegram_rows(uuid, bytea)', 'app.account_bind_phone(uuid, bytea, app.source)',
      'app.account_accept_staff_invite(uuid, text, bytea, bigint)']) f
    where has_function_privilege('bayramm_api', f, 'EXECUTE')$$,
  'служебные функции аккаунтов API недоступны');

-- ════════════════════════════════════════════════════════════════════════════
-- Перенос: роли с одним хэшем Telegram — один аккаунт
-- ════════════════════════════════════════════════════════════════════════════
select is((select count(*)::int from app.clients where account_id is null), 0, 'у каждого клиента есть аккаунт');
select isnt((select account_id from app.clients where id = 'cccccccc-0000-0000-0000-000000000001'),
            (select account_id from app.clients where id = 'cccccccc-0000-0000-0000-000000000002'),
  'разные клиенты — разные аккаунты');

-- Строки «как до аккаунтов»: сотрудник и пользователь вендора с одним Telegram
insert into app.staff (id, role, tg_id_hash, tg_linked_at) values
  ('00000000-0000-0000-0000-00000000c001', 'manager', sha256('tg-legacy'), now());
insert into pii.staff_profiles (staff_id, display_name, telegram_id) values
  ('00000000-0000-0000-0000-00000000c001', 'Legacy', 8001);
insert into app.vendor_users (id, vendor_id, phone_hash, tg_user_hash, tg_linked_at) values
  ('bbbbbbbb-0000-0000-0000-0000000000c1', 'bbbbbbbb-0000-0000-0000-000000000001', sha256('vendor-legacy'),
   sha256('tg-legacy'), now() - interval '1 day');
insert into pii.vendor_user_profiles (vendor_user_id, phone, telegram_user_id) values
  ('bbbbbbbb-0000-0000-0000-0000000000c1', '+998000000401', 8001);

select results_eq(
  $$select accounts_created, phone_identities from app.accounts_backfill()$$,
  $$values (1, 1)$$,
  'перенос: один аккаунт на Telegram и телефон пользователя вендора как способ входа');
select results_eq(
  $$select (select account_id from app.staff where id = '00000000-0000-0000-0000-00000000c001')
         = (select account_id from app.vendor_users where id = 'bbbbbbbb-0000-0000-0000-0000000000c1'),
           (select count(*)::int from app.account_identities i
            join app.staff s on s.account_id = i.account_id
            where s.id = '00000000-0000-0000-0000-00000000c001')$$,
  $$values (true, 2)$$,
  'сотрудник и партнёр с одним Telegram — один аккаунт с Telegram и телефоном');
select results_eq(
  $$select p.telegram_id, p.phone from pii.account_profiles p
    join app.staff s on s.account_id = p.account_id where s.id = '00000000-0000-0000-0000-00000000c001'$$,
  $$values (8001::bigint, '+998000000401'::text)$$,
  'профиль аккаунта — Telegram ID и подтверждённый телефон из профилей ролей');
select results_eq(
  $$select accounts_created, phone_identities from app.accounts_backfill()$$,
  $$values (0, 0)$$,
  'повторный перенос ничего не меняет');

-- Клиент, заведённый кодом до аккаунтов, получает аккаунт своего Telegram
insert into app.clients (id, tg_id_hash) values ('cccccccc-0000-0000-0000-0000000000c1', sha256('tg-legacy'));
select is((select account_id from app.clients where id = 'cccccccc-0000-0000-0000-0000000000c1'),
          (select account_id from app.staff where id = '00000000-0000-0000-0000-00000000c001'),
  'новый клиент без account_id — аккаунт его Telegram');
select throws_ok(
  $$update app.clients set account_id = (select account_id from app.clients where id = 'cccccccc-0000-0000-0000-000000000002')
    where id = 'cccccccc-0000-0000-0000-0000000000c1'$$,
  'BR006', 'immutable_column', 'аккаунт клиента не меняется');
select throws_ok(
  $$update app.staff set account_id = (select account_id from app.clients where id = 'cccccccc-0000-0000-0000-000000000002')
    where id = '00000000-0000-0000-0000-00000000c001'$$,
  'BR006', 'immutable_column', 'членство сотрудника не перевесить на другой аккаунт');

-- ════════════════════════════════════════════════════════════════════════════
-- Вход по Telegram
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;

select pg_temp.as_actor(null);
select throws_ok(
  $$select * from app.account_sign_in_telegram(sha256('tg-a'), 5101, 'user_a', 'A', null, 'ru', 'web')$$,
  'BR003', 'forbidden_for_actor', 'без актора вход не выполняется');
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select throws_ok(
  $$select * from app.account_sign_in_telegram(sha256('tg-a'), 5101, 'user_a', 'A', null, 'ru', 'web')$$,
  'BR003', 'forbidden_for_actor', 'клиент не входит за другого');

select pg_temp.as_actor('system');
select throws_ok(
  $$select * from app.account_sign_in_telegram('\x00'::bytea, 5101, 'user_a', 'A', null, 'ru', 'web')$$,
  '22023', null, 'хэш не 32 байта — ошибка вызова');
select results_eq(
  $$select created, disabled from app.account_sign_in_telegram(sha256('tg-a'), 5101, 'user_a', 'Aziz', 'A', 'ru', 'web')$$,
  $$values (true, false)$$,
  'первый вход создаёт аккаунт');
insert into acc select 'a', account_id from app.account_identities where kind = 'telegram' and value_hash = sha256('tg-a');
select results_eq(
  $$select created, account_id = (select id from acc where k = 'a')
    from app.account_sign_in_telegram(sha256('tg-a'), 5101, 'user_a', 'Aziz', null, 'uz', 'web')$$,
  $$values (false, true)$$,
  'повторный вход — тот же аккаунт');
select results_eq(
  $$select a.locale::text, p.telegram_id, p.telegram_username, p.first_name, p.last_name
    from app.accounts a join pii.account_profiles p on p.account_id = a.id where a.id = (select id from acc where k = 'a')$$,
  $$values ('ru'::text, 5101::bigint, 'user_a'::text, 'Aziz'::text, null::text)$$,
  'язык — при создании; имена — из свежих данных Telegram');
select is((select count(*)::int from app.clients where account_id = (select id from acc where k = 'a')), 0,
  'вход сам по себе клиента не создаёт');

-- роль клиента — при входе в клиентское приложение
select results_eq(
  $$select blocked from app.account_ensure_client((select id from acc where k = 'a'), 'ru', true)$$,
  $$values (false)$$,
  'клиент создан');
select results_eq(
  $$select c.tg_id_hash = sha256('tg-a'), c.locale::text, c.can_message, p.telegram_id, p.first_name
    from app.clients c join pii.client_profiles p on p.client_id = c.id
    where c.account_id = (select id from acc where k = 'a')$$,
  $$values (true, 'ru'::text, true, 5101::bigint, 'Aziz'::text)$$,
  'клиент — с хэшем Telegram аккаунта, профиль клиента — из профиля аккаунта');
select is((select count(*)::int from app.account_ensure_client((select id from acc where k = 'a'), 'uz', false)), 1,
  'повторно — тот же клиент');
select is((select count(*)::int from app.clients where account_id = (select id from acc where k = 'a')), 1,
  'клиент у аккаунта один');

-- приглашение сотрудника на имя пользователя принимается при входе
reset role;
insert into app.staff (id, role) values ('00000000-0000-0000-0000-00000000c002', 'moderator');
insert into pii.staff_profiles (staff_id, display_name, telegram_username) values
  ('00000000-0000-0000-0000-00000000c002', 'Invited', 'user_b');
set local role bayramm_api;
select pg_temp.as_actor('system');
select results_eq(
  $$select created from app.account_sign_in_telegram(sha256('tg-b'), 5102, 'User_B', 'Bek', null, 'uz', 'web')$$,
  $$values (true)$$,
  'второй человек');
insert into acc select 'b', account_id from app.account_identities where kind = 'telegram' and value_hash = sha256('tg-b');
select results_eq(
  $$select account_id = (select id from acc where k = 'b'), tg_id_hash = sha256('tg-b')
    from app.staff where id = '00000000-0000-0000-0000-00000000c002'$$,
  $$values (true, true)$$,
  'приглашение по имени пользователя принято при входе');

-- ════════════════════════════════════════════════════════════════════════════
-- Вход по телефону и привязка партнёра
-- ════════════════════════════════════════════════════════════════════════════
reset role;
insert into app.vendor_users (id, vendor_id, phone_hash, role) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', sha256('phone-p'), 'member'),
  ('bbbbbbbb-0000-0000-0000-0000000000c2', 'bbbbbbbb-0000-0000-0000-000000000001', sha256('phone-p'), 'owner');
set local role bayramm_api;
select pg_temp.as_actor('system');
select throws_ok(
  $$select * from app.account_sign_in_phone(sha256('phone-p'), '998000000501', 'uz', 'web')$$,
  '22023', null, 'номер не в виде +998XXXXXXXXX — ошибка вызова');
select results_eq(
  $$select created, disabled from app.account_sign_in_phone(sha256('phone-p'), '+998000000501', 'uz', 'web')$$,
  $$values (true, false)$$,
  'вход по телефону создаёт аккаунт');
insert into acc select 'p', account_id from app.account_identities where kind = 'phone' and value_hash = sha256('phone-p');
select is(
  (select count(*)::int from app.vendor_users where account_id = (select id from acc where k = 'p')), 2,
  'пользователи вендоров с этим номером — к аккаунту, в обоих вендорах');
select results_eq(
  $$select created, account_id = (select id from acc where k = 'p')
    from app.account_sign_in_phone(sha256('phone-p'), '+998000000501', 'uz', 'web')$$,
  $$values (false, true)$$,
  'повторный вход по номеру — тот же аккаунт');
select is(
  (select count(*)::int from app.audit_log where action = 'vendor_user.account_bind'
     and object_id in ('aaaaaaaa-0000-0000-0000-0000000000c1', 'bbbbbbbb-0000-0000-0000-0000000000c2')
     and detail ? 'vendor_id' and not detail ? 'phone'),
  2, 'привязки — в журнале, без номера');

-- приглашение сотрудника по телефону
reset role;
insert into app.staff (id, role, phone_hash) values ('00000000-0000-0000-0000-00000000c003', 'manager', sha256('phone-s'));
insert into pii.staff_profiles (staff_id, display_name) values ('00000000-0000-0000-0000-00000000c003', 'By phone');
set local role bayramm_api;
select pg_temp.as_actor('system');
insert into acc select 's', account_id from app.account_sign_in_phone(sha256('phone-s'), '+998000000502', 'ru', 'web');
select results_eq(
  $$select id from app.staff where account_id = (select id from acc where k = 's')$$,
  $$values ('00000000-0000-0000-0000-00000000c003'::uuid)$$,
  'приглашение по телефону принято кодом из сообщения');

-- ════════════════════════════════════════════════════════════════════════════
-- Свой аккаунт: чужие роли и данные не видны
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor('account', (select id from acc where k = 'a'));
select is((select count(*)::int from app.accounts), 1, 'аккаунт видит только себя');
select is((select count(*)::int from app.account_identities), 1, 'и только свои способы входа');
select is((select count(*)::int from pii.account_profiles), 1, 'и только свой профиль');
select is((select count(*)::int from app.hub_codes), 0, 'коды хаба — только системе');
select results_eq(
  $$select app.account_me() -> 'roles' -> 'client' ->> 'id' is not null,
           jsonb_array_length(app.account_me() -> 'roles' -> 'vendors'),
           app.account_me() -> 'roles' -> 'staff',
           app.account_me() -> 'identities',
           app.account_me() -> 'profile' ->> 'firstName'$$,
  $$select true, 0, 'null'::jsonb, jsonb_build_array(jsonb_build_object('kind', 'telegram',
             'verifiedAt', (select verified_at from app.account_identities))), 'Aziz'::text$$,
  'account_me: свой клиент, ни вендоров, ни роли сотрудника; способы входа — только вид и дата');

select pg_temp.as_actor('account', (select id from acc where k = 'p'));
select results_eq(
  $$select v ->> 'vendorId' from jsonb_array_elements(app.account_me() -> 'roles' -> 'vendors') v order by 1$$,
  $$values ('aaaaaaaa-0000-0000-0000-000000000001'::text), ('bbbbbbbb-0000-0000-0000-000000000001'::text)$$,
  'партнёр двух вендоров видит оба членства');
select is(app.account_me() -> 'profile' ->> 'phone', null, 'телефона в account_me нет');

select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok($$select app.account_me()$$, 'BR003', 'forbidden_for_actor', 'account_me — только своему аккаунту');

-- ════════════════════════════════════════════════════════════════════════════
-- Добавить способ входа: чужой — отказ, слияния нет
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor('account', (select id from acc where k = 'a'));
select is(app.account_link_phone(sha256('phone-p'), '+998000000501', 'web'), 'taken',
  'телефон другого аккаунта не добавить');
select is(app.account_link_telegram(sha256('tg-b'), 5102, 'user_b', 'Bek', null), 'taken',
  'чужой Telegram не добавить');
select is(app.account_link_telegram(sha256('tg-a2'), 5199, null, 'X', null), 'kind_taken',
  'второй Telegram не добавить');
select is(app.account_link_telegram(sha256('tg-a'), 5101, 'user_a', 'Aziz', null), 'already',
  'свой Telegram — уже есть');
select is(app.account_link_phone(sha256('phone-a'), '+998000000503', 'web'), 'linked', 'свободный телефон добавлен');
select is((select count(*)::int from app.account_identities), 2, 'теперь у аккаунта Telegram и телефон');
select is(app.account_link_phone(sha256('phone-a2'), '+998000000504', 'web'), 'kind_taken', 'второй телефон не добавить');

select pg_temp.as_actor('account', (select id from acc where k = 'p'));
select is(app.account_link_telegram(sha256('tg-p'), 5103, 'user_p', 'Pulat', null), 'linked',
  'партнёр без Telegram добавил Telegram');
select pg_temp.as_actor('system');
select is(
  (select count(*)::int from app.vendor_users
   where account_id = (select id from acc where k = 'p') and tg_user_hash = sha256('tg-p') and tg_linked_at is not null),
  2, 'его членства получили привязку уведомлений');
select is(
  (select count(*)::int from app.audit_log
   where action = 'account.identity_link' and object_id = (select id::text from acc where k = 'p')
     and actor_kind = 'account' and detail = '{"kind": "telegram"}'::jsonb),
  1, 'добавление способа — в журнале от имени аккаунта, без значения');

-- ════════════════════════════════════════════════════════════════════════════
-- Сессии: аккаунт видит и отзывает только свои
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor('system');
insert into app.sessions (id, token_hash, account_id, via, app, proof_at, expires_at) values
  ('5e000000-0000-0000-0000-0000000000a1', sha256('session-a'), (select id from acc where k = 'a'), 'tg_webapp',
   'web', now(), now() + interval '7 days'),
  ('5e000000-0000-0000-0000-0000000000b1', sha256('session-b'), (select id from acc where k = 'b'), 'tg_widget',
   'web', now(), now() + interval '7 days');
select throws_ok(
  $$insert into app.sessions (token_hash, account_id, via, app, proof_at, expires_at)
    values (sha256('session-x'), (select id from acc where k = 'a'), 'tg_webapp', 'web', now(), now() + interval '8 days')$$,
  '23514', null, 'сессия аккаунта — не дольше 7 дней');
select throws_ok(
  $$insert into app.sessions (token_hash, account_id, via, expires_at)
    values (sha256('session-y'), (select id from acc where k = 'a'), 'tg_webapp', now() + interval '1 day')$$,
  '23502', null, 'новая сессия — с приложением и временем доказательства');
select throws_ok(
  $$insert into app.sessions (token_hash, account_id, staff_id, via, app, proof_at, expires_at)
    values (sha256('session-z'), (select id from acc where k = 'a'), '00000000-0000-0000-0000-00000000c002',
            'staff_elevation', 'admin', now(), now() + interval '1 hour')$$,
  'BR003', 'forbidden_for_actor', 'роль сотрудника чужого аккаунта в сессию не вписать');

select pg_temp.as_actor('account', (select id from acc where k = 'a'));
select results_eq($$select id from app.sessions$$, $$values ('5e000000-0000-0000-0000-0000000000a1'::uuid)$$,
  'аккаунт видит только свои сессии');
update app.sessions set revoked_at = now() where id = '5e000000-0000-0000-0000-0000000000b1';
select pg_temp.as_actor('system');
select is((select revoked_at from app.sessions where id = '5e000000-0000-0000-0000-0000000000b1'), null,
  'чужую сессию не отозвать');

-- ════════════════════════════════════════════════════════════════════════════
-- Сессия сотрудника — только по свежему доказательству
-- ════════════════════════════════════════════════════════════════════════════
select results_eq(
  $$select result, staff_id from app.staff_elevate((select id from acc where k = 'a'), now(), sha256('st-1'), 'tg_webapp')$$,
  $$values ('forbidden'::text, null::uuid)$$,
  'без роли сотрудника — отказ');
select results_eq(
  $$select result from app.staff_elevate((select id from acc where k = 'b'), now() - interval '13 hours', sha256('st-2'),
                                         'hub_code')$$,
  $$values ('stale'::text)$$,
  'доказательство старше 12 часов — доказать заново');
select is((select count(*)::int from app.sessions where token_hash in (sha256('st-1'), sha256('st-2'))), 0,
  'отказ сессий не создаёт');
select results_eq(
  $$select result, staff_id, role::text, expires_at = date_trunc('second', now() - interval '1 hour') + interval '12 hours'
    from app.staff_elevate((select id from acc where k = 'b'), date_trunc('second', now() - interval '1 hour'),
                           sha256('st-3'), 'tg_widget')$$,
  $$values ('ok'::text, '00000000-0000-0000-0000-00000000c002'::uuid, 'moderator'::text, true)$$,
  'свежее доказательство — сессия сотрудника до proof_at + 12 часов');
select results_eq(
  $$select account_id = (select id from acc where k = 'b'), staff_id, via, app
    from app.sessions where token_hash = sha256('st-3')$$,
  $$values (true, '00000000-0000-0000-0000-00000000c002'::uuid, 'staff_elevation'::text, 'admin'::text)$$,
  'сессия сотрудника — его аккаунта');
select is(
  (select count(*)::int from app.audit_log
   where action = 'staff.elevate' and object_id = '00000000-0000-0000-0000-00000000c002'
     and detail ->> 'role' = 'moderator' and detail ->> 'via' = 'tg_widget'),
  1, 'повышение — в журнале, без ПДн');
select throws_ok(
  $$insert into app.sessions (token_hash, account_id, staff_id, via, app, proof_at, expires_at)
    values (sha256('st-4'), (select id from acc where k = 'b'), '00000000-0000-0000-0000-00000000c002',
            'staff_elevation', 'admin', now() - interval '6 hours', now() + interval '7 hours')$$,
  '23514', null, 'сессия сотрудника не переживает доказательство на 12 часов');

reset role;
update app.staff set active = false where id = '00000000-0000-0000-0000-00000000c002';
select isnt((select revoked_at from app.sessions where token_hash = sha256('st-3')), null,
  'сотрудника отключили — его сессия отозвана');
update app.staff set active = true where id = '00000000-0000-0000-0000-00000000c002';
set local role bayramm_api;
select pg_temp.as_actor('system');

-- ════════════════════════════════════════════════════════════════════════════
-- Коды из сообщения
-- ════════════════════════════════════════════════════════════════════════════
select throws_ok(
  $$select * from app.otp_issue(sha256('otp-1'), sha256('code-1'), null, 'console', 30)$$,
  '22023', null, 'срок кода — от минуты до 15');
select results_eq(
  $$select result, retry_after from app.otp_issue(sha256('otp-1'), sha256('code-1'), sha256('ip-1'), 'console', 600)$$,
  $$values ('ok'::text, 60)$$,
  'первый код выдан');
select results_eq(
  $$select result from app.otp_issue(sha256('otp-1'), sha256('code-2'), sha256('ip-1'), 'console', 600)$$,
  $$values ('too_soon'::text)$$,
  'второй код раньше, чем через минуту, — нет');
select is(
  (select count(*)::int from app.otp_codes where phone_hash = sha256('otp-1')), 1,
  'отказ кода не создаёт');

-- проверка: 5 попыток
select results_eq($$select result, attempts_left from app.otp_check(sha256('otp-1'), sha256('wrong'))$$,
  $$values ('mismatch'::text, 4)$$, 'неверный код — попытка засчитана');
select results_eq($$select result from app.otp_check(sha256('otp-1'), sha256('code-1'))$$,
  $$values ('ok'::text)$$, 'верный код');
select results_eq($$select result from app.otp_check(sha256('otp-1'), sha256('code-1'))$$,
  $$values ('no_code'::text)$$, 'код одноразовый');

-- лимит на номер: код отправлен минуту назад, три за 10 минут — дальше нельзя
reset role;
update app.otp_codes set created_at = created_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes'
where phone_hash = sha256('otp-1');
set local role bayramm_api;
select pg_temp.as_actor('system');
select is((select result from app.otp_issue(sha256('otp-1'), sha256('code-3'), null, 'console', 600)), 'ok',
  'через минуту — второй код');
reset role;
update app.otp_codes set created_at = created_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes'
where phone_hash = sha256('otp-1');
set local role bayramm_api;
select pg_temp.as_actor('system');
select is((select result from app.otp_issue(sha256('otp-1'), sha256('code-4'), null, 'console', 600)), 'ok',
  'третий код');
select is(
  (select count(*)::int from app.otp_codes where phone_hash = sha256('otp-1') and consumed_at is null), 1,
  'действует только последний код номера');
reset role;
update app.otp_codes set created_at = created_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes'
where phone_hash = sha256('otp-1');
set local role bayramm_api;
select pg_temp.as_actor('system');
select results_eq(
  $$select result, retry_after between 1 and 600 from app.otp_issue(sha256('otp-1'), sha256('code-5'), null, 'console', 600)$$,
  $$values ('phone_limit'::text, true)$$,
  'четвёртый код за 10 минут на номер — нет');

-- лимит на IP: три кода с одного IP за 10 минут на разные номера
select is((select result from app.otp_issue(sha256('otp-2'), sha256('c'), sha256('ip-1'), 'console', 600)), 'ok',
  'второй код с IP');
select is((select result from app.otp_issue(sha256('otp-3'), sha256('c'), sha256('ip-1'), 'console', 600)), 'ok',
  'третий код с IP');
select is((select result from app.otp_issue(sha256('otp-4'), sha256('c'), sha256('ip-1'), 'console', 600)), 'ip_limit',
  'четвёртый код с IP за 10 минут — нет');

-- пять неверных попыток — код сгорает; истёкший код не принимается
select is((select attempts_left from app.otp_check(sha256('otp-2'), sha256('x'))), 4, 'попытка 1');
select is((select attempts_left from app.otp_check(sha256('otp-2'), sha256('x'))), 3, 'попытка 2');
select is((select attempts_left from app.otp_check(sha256('otp-2'), sha256('x'))), 2, 'попытка 3');
select is((select attempts_left from app.otp_check(sha256('otp-2'), sha256('x'))), 1, 'попытка 4');
select is((select result from app.otp_check(sha256('otp-2'), sha256('x'))), 'too_many_attempts', 'попытка 5 — всё');
select is((select result from app.otp_check(sha256('otp-2'), sha256('c'))), 'too_many_attempts',
  'после пяти попыток и верный код не принимается');
reset role;
update app.otp_codes set expires_at = now() - interval '1 second', created_at = now() - interval '11 minutes'
where phone_hash = sha256('otp-3');
set local role bayramm_api;
select pg_temp.as_actor('system');
select is((select result from app.otp_check(sha256('otp-3'), sha256('c'))), 'expired', 'истёкший код не принимается');

select pg_temp.as_actor('account', (select id from acc where k = 'a'));
select throws_ok($$select * from app.otp_check(sha256('otp-3'), sha256('c'))$$, 'BR003', 'forbidden_for_actor',
  'коды проверяет только система');
select is((select count(*)::int from app.otp_codes), 0, 'аккаунт кодов не видит');

-- ════════════════════════════════════════════════════════════════════════════
-- Коды хаба
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor('system');
select throws_ok(
  $$insert into app.hub_codes (code_hash, account_id, app, origin, challenge, state_hash, proof_at, expires_at)
    values (sha256('hub-1'), (select id from acc where k = 'a'), 'vendor', 'https://vendor.example.test',
            repeat('a', 43), sha256('state'), now(), now() + interval '61 seconds')$$,
  '23514', null, 'код хаба живёт не дольше 60 секунд');
select lives_ok(
  $$insert into app.hub_codes (code_hash, account_id, app, origin, challenge, state_hash, proof_at, expires_at)
    values (sha256('hub-2'), (select id from acc where k = 'a'), 'vendor', 'https://vendor.example.test',
            repeat('a', 43), sha256('state'), now(), now() + interval '60 seconds')$$,
  'код хаба на 60 секунд');
select throws_ok(
  $$insert into app.hub_codes (code_hash, account_id, app, origin, challenge, state_hash, proof_at, expires_at)
    values (sha256('hub-3'), (select id from acc where k = 'a'), 'vendor', 'https://vendor.example.test/path',
            repeat('a', 43), sha256('state'), now(), now() + interval '60 seconds')$$,
  '23514', null, 'origin — без пути');

-- ════════════════════════════════════════════════════════════════════════════
-- Отключение и удаление аккаунта
-- ════════════════════════════════════════════════════════════════════════════
reset role;
update app.accounts set disabled_at = now(), disabled_reason = 'test' where id = (select id from acc where k = 'b');
select isnt((select revoked_at from app.sessions where id = '5e000000-0000-0000-0000-0000000000b1'), null,
  'аккаунт отключили — его сессии отозваны');
set local role bayramm_api;
select pg_temp.as_actor('system');
select results_eq(
  $$select disabled from app.account_sign_in_telegram(sha256('tg-b'), 5102, 'user_b', 'Bek', null, 'uz', 'web')$$,
  $$values (true)$$,
  'отключённый аккаунт не входит');
select results_eq(
  $$select result from app.staff_elevate((select id from acc where k = 'b'), now(), sha256('st-5'), 'tg_widget')$$,
  $$values ('forbidden'::text)$$,
  'и сессию сотрудника не получает');

-- партнёр удаляет аккаунт
select pg_temp.as_actor('account', (select id from acc where k = 'p'));
select results_eq(
  $$select consents_withdrawn, requests_withdrawn, memberships_detached from app.account_delete('web')$$,
  $$values (0, 0, 2)$$,
  'удаление: членства отвязаны');
select is_empty($$select * from app.account_delete('web')$$, 'повторное удаление ничего не делает');
select pg_temp.as_actor('system');
select results_eq(
  $$select (select count(*)::int from app.vendor_users where account_id = (select id from acc where k = 'p')),
           (select count(*)::int from app.vendor_users
            where id in ('aaaaaaaa-0000-0000-0000-0000000000c1', 'bbbbbbbb-0000-0000-0000-0000000000c2')
              and tg_user_hash is null),
           (select count(*)::int from pii.account_profiles where account_id = (select id from acc where k = 'p')),
           (select deleted_at is not null from app.accounts where id = (select id from acc where k = 'p')),
           (select count(*)::int from app.account_identities where account_id = (select id from acc where k = 'p'))$$,
  $$values (0, 2, 0, true, 2)$$,
  'пользователи вендоров остались, но без аккаунта и Telegram; профиль стёрт; хэши способов входа — нет');
select results_eq(
  $$select created, account_id = (select id from acc where k = 'p')
    from app.account_sign_in_phone(sha256('phone-p'), '+998000000501', 'uz', 'web')$$,
  $$values (false, true)$$,
  'вход тем же номером восстанавливает аккаунт');
select results_eq(
  $$select (select deleted_at from app.accounts where id = (select id from acc where k = 'p')) is null,
           (select count(*)::int from app.vendor_users where account_id = (select id from acc where k = 'p'))$$,
  $$values (true, 2)$$,
  'аккаунт снова действует, номер снова привязал членства');

select * from finish();
rollback;
