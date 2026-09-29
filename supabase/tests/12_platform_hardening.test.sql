-- Закрытость app/pii для Data API, ежедневное обслуживание (истечение заявок,
-- сроки хранения), права клиента: выгрузка, отзыв согласия, удаление аккаунта
begin;
\ir _fixtures.psql
select plan(66);

-- ════════════════════════════════════════════════════════════════════════════
-- Data API Supabase (anon, authenticated) не видит схемы app и pii
-- ════════════════════════════════════════════════════════════════════════════
select is_empty(
  $$select r || ' ' || s from unnest(array['anon', 'authenticated']) r, unnest(array['app', 'pii']) s
    where has_schema_privilege(r, s, 'USAGE, CREATE')$$,
  'anon и authenticated: нет USAGE и CREATE на схемы app и pii');
select is_empty(
  $$select r || ' ' || c.oid::regclass::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['anon', 'authenticated']) r
    where n.nspname in ('app', 'pii') and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and (has_table_privilege(r, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
           or has_any_column_privilege(r, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))$$,
  'anon и authenticated: ни одного права на таблицы, представления и столбцы app/pii');
select is_empty(
  $$select r || ' ' || c.oid::regclass::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['anon', 'authenticated']) r
    where n.nspname in ('app', 'pii') and c.relkind = 'S'
      and has_sequence_privilege(r, c.oid, 'USAGE, SELECT, UPDATE')$$,
  'anon и authenticated: нет прав на последовательности app/pii');
select is_empty(
  $$select r || ' ' || p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join unnest(array['anon', 'authenticated']) r
    where n.nspname in ('app', 'pii') and has_function_privilege(r, p.oid, 'EXECUTE')$$,
  'anon и authenticated: не исполняют ни одной функции app/pii');
select is_empty(
  $$select d.defaclrole::regrole::text || ' ' || coalesce(d.defaclnamespace::regnamespace::text, '*')
    from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
    where (d.defaclnamespace = 0 or d.defaclnamespace in ('app'::regnamespace, 'pii'::regnamespace))
      and a.grantee in ('anon'::regrole, 'authenticated'::regrole)$$,
  'права по умолчанию не выдают anon и authenticated будущие объекты app/pii');

-- ════════════════════════════════════════════════════════════════════════════
-- Права API на новые функции
-- ════════════════════════════════════════════════════════════════════════════
select ok(has_function_privilege('bayramm_api', 'app.run_daily_maintenance()', 'EXECUTE'),
  'API запускает обслуживание целиком');
select is_empty(
  $$select f from unnest(array['app.expire_past_requests()', 'app.purge_request_contacts()',
                               'app.purge_otp_codes()', 'app.purge_sessions()']) f
    where has_function_privilege('bayramm_api', f, 'EXECUTE')$$,
  'отдельные шаги обслуживания API не вызывает');
select ok(has_function_privilege('bayramm_api', 'app.client_export()', 'EXECUTE')
          and has_function_privilege('bayramm_api',
                'app.client_withdraw_consent(app.consent_purpose, uuid, app.source, bytea)', 'EXECUTE')
          and has_function_privilege('bayramm_api', 'app.client_delete_account(app.source, bytea)', 'EXECUTE'),
  'API вызывает выгрузку, отзыв согласия и удаление аккаунта');
select throws_ok(
  $$update app.settings set value = '0' where key = 'session_retention_days'$$,
  '23514', null, 'session_retention_days — не меньше дня');

-- ════════════════════════════════════════════════════════════════════════════
-- Данные для обслуживания (клиент C1 → листинг A1, у всех — фикстурное согласие)
--   p1 viewed, событие вчера          → expired, контакты остаются
--   p2 new, событие 100 дней назад    → expired, контакты стёрты
--   p3 deal, событие 200 дней назад   → статус не меняется, контакты стёрты
--   p4 new, событие сегодня           → не трогается
-- ════════════════════════════════════════════════════════════════════════════
insert into app.requests (id, client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
select v.id::uuid, 'cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101',
       'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1', 'toy',
       app.tashkent_today() + v.shift, 100, 'tma'
from (values ('eeeeeeee-0000-0000-0000-0000000000c1', -1),
             ('eeeeeeee-0000-0000-0000-0000000000c2', -100),
             ('eeeeeeee-0000-0000-0000-0000000000c3', -200),
             ('eeeeeeee-0000-0000-0000-0000000000c4', 0)) v(id, shift);
insert into pii.request_contacts (request_id, contact_name, contact_phone, comment) values
  ('eeeeeeee-0000-0000-0000-0000000000c1', 'Client1', '+998000000301', 'p1'),
  ('eeeeeeee-0000-0000-0000-0000000000c2', 'Client1', '+998000000301', 'p2'),
  ('eeeeeeee-0000-0000-0000-0000000000c3', 'Client1', '+998000000301', 'p3');

select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
update app.requests set status = 'viewed' where id = 'eeeeeeee-0000-0000-0000-0000000000c1';
update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000c3';
update app.requests set status = 'deal' where id = 'eeeeeeee-0000-0000-0000-0000000000c3';
select pg_temp.as_actor(null);

-- коды входа: старый и свежий
insert into app.otp_codes (id, phone_hash, code_hash, provider, created_at, expires_at) values
  ('0f000000-0000-0000-0000-000000000001', sha256('otp-phone'), sha256('otp-1'), 'console',
   now() - interval '2 days', now() - interval '2 days' + interval '5 minutes'),
  ('0f000000-0000-0000-0000-000000000002', sha256('otp-phone'), sha256('otp-2'), 'console',
   now() - interval '1 minute', now() + interval '4 minutes');

-- сессии C2: истекла 40 дней назад, отозвана 40 дней назад, истекла вчера, действующая
insert into app.sessions (id, token_hash, client_id, via, created_at, expires_at, revoked_at) values
  ('5e000000-0000-0000-0000-000000000001', sha256('s-1'), 'cccccccc-0000-0000-0000-000000000002', 'tg_client',
   now() - interval '47 days', now() - interval '40 days', null),
  ('5e000000-0000-0000-0000-000000000002', sha256('s-2'), 'cccccccc-0000-0000-0000-000000000002', 'tg_client',
   now() - interval '45 days', now() + interval '1 day', now() - interval '40 days'),
  ('5e000000-0000-0000-0000-000000000003', sha256('s-3'), 'cccccccc-0000-0000-0000-000000000002', 'tg_client',
   now() - interval '8 days', now() - interval '1 day', null),
  ('5e000000-0000-0000-0000-000000000004', sha256('s-4'), 'cccccccc-0000-0000-0000-000000000002', 'tg_client',
   now(), now() + interval '7 days', null);

-- ════════════════════════════════════════════════════════════════════════════
-- Шаги обслуживания (владелец таблиц, актор system)
-- ════════════════════════════════════════════════════════════════════════════
select throws_ok($$select app.expire_past_requests()$$, 'BR003', 'forbidden_for_actor',
  'без актора system заявки не истекают');

select pg_temp.as_actor('system');
select cmp_ok(app.expire_past_requests(), '>=', 2, 'заявки с прошедшей датой события истекли');
select results_eq(
  $$select id::text, status::text from app.requests
    where id in ('eeeeeeee-0000-0000-0000-0000000000c1', 'eeeeeeee-0000-0000-0000-0000000000c2',
                 'eeeeeeee-0000-0000-0000-0000000000c3', 'eeeeeeee-0000-0000-0000-0000000000c4',
                 'eeeeeeee-0000-0000-0000-0000000000a1')
    order by id$$,
  $$values ('eeeeeeee-0000-0000-0000-0000000000a1', 'new'),
           ('eeeeeeee-0000-0000-0000-0000000000c1', 'expired'),
           ('eeeeeeee-0000-0000-0000-0000000000c2', 'expired'),
           ('eeeeeeee-0000-0000-0000-0000000000c3', 'deal'),
           ('eeeeeeee-0000-0000-0000-0000000000c4', 'new')$$,
  'истекают только открытые заявки с датой раньше сегодняшней (по Ташкенту)');
select results_eq(
  $$select from_status::text, to_status::text, actor_kind::text, actor_id, source::text, reason
    from app.request_status_log where request_id = 'eeeeeeee-0000-0000-0000-0000000000c1'
    order by at desc, id desc limit 1$$,
  $$values ('viewed', 'expired', 'system', null::uuid, 'system', 'event_date_passed')$$,
  'истечение записано в журнал статусов: system, причина event_date_passed');
select is(current_setting('app.reason', true), '', 'причина не остаётся в транзакции после шага');
select is(app.expire_past_requests(), 0, 'повторный запуск ничего не меняет');

select cmp_ok(app.purge_request_contacts(), '>=', 2, 'старые контакты стёрты');
select results_eq(
  $$select request_id::text, contact_name, contact_phone, comment, purged_at is not null
    from pii.request_contacts
    where request_id in ('eeeeeeee-0000-0000-0000-0000000000c1', 'eeeeeeee-0000-0000-0000-0000000000c2',
                         'eeeeeeee-0000-0000-0000-0000000000c3')
    order by request_id$$,
  $$values ('eeeeeeee-0000-0000-0000-0000000000c1', 'Client1', '+998000000301', 'p1', false),
           ('eeeeeeee-0000-0000-0000-0000000000c2', null, null, null, true),
           ('eeeeeeee-0000-0000-0000-0000000000c3', null, null, null, true)$$,
  'через 90 дней после события контакты стёрты (строка с отметкой остаётся), раньше — нет');
select is(app.purge_request_contacts(), 0, 'повторная очистка контактов ничего не меняет');

select cmp_ok(app.purge_otp_codes(), '>=', 1, 'старые коды входа удалены');
select results_eq(
  $$select id::text from app.otp_codes where id::text like '0f000000-%'$$,
  $$values ('0f000000-0000-0000-0000-000000000002')$$,
  'код старше суток удалён, свежий остался');
select is(app.purge_otp_codes(), 0, 'повторная очистка кодов ничего не меняет');

select cmp_ok(app.purge_sessions(), '>=', 2, 'давно истёкшие и отозванные сессии удалены');
select results_eq(
  $$select id::text from app.sessions where id::text like '5e000000-%' order by id$$,
  $$values ('5e000000-0000-0000-0000-000000000003'), ('5e000000-0000-0000-0000-000000000004')$$,
  'удалены сессии, истёкшие или отозванные больше 30 дней назад; недавние и действующие остались');
select is(app.purge_sessions(), 0, 'повторная очистка сессий ничего не меняет');

-- ── запуск целиком: ролью API, раз в день ───────────────────────────────────
set local role bayramm_api;

select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select throws_ok($$select * from app.run_daily_maintenance()$$, 'BR003', 'forbidden_for_actor',
  'клиент не запускает обслуживание');
select pg_temp.as_actor(null);
select throws_ok($$select * from app.run_daily_maintenance()$$, 'BR003', 'forbidden_for_actor',
  'без актора обслуживание не запускается');

select pg_temp.as_actor('system');
-- на живой базе обслуживание за сегодня могло уже пройти — тогда первый запуск тоже пустой
create temporary table marked_before on commit drop as
  select exists (select 1 from app.audit_log
                 where action = 'maintenance.daily' and object_id = app.tashkent_today()::text) as marked;
create temporary table first_run on commit drop as select * from app.run_daily_maintenance();
select results_eq(
  $$select ran, run_day, expired_requests, purged_request_contacts, deleted_otp_codes, deleted_sessions
    from first_run$$,
  $$select not marked, app.tashkent_today(), 0, 0, 0, 0 from marked_before$$,
  'первый запуск за день; всё уже сделано шагами выше — нули');
select results_eq(
  $$select ran from app.run_daily_maintenance()$$,
  $$values (false)$$,
  'второй запуск в тот же день ничего не делает');
select results_eq(
  $$select count(*)::int, min(actor_kind::text), min(source::text),
           bool_and(detail ?& array['expired_requests', 'purged_request_contacts', 'deleted_otp_codes',
                                    'deleted_sessions'])
    from app.audit_log
    where action = 'maintenance.daily' and object_id = app.tashkent_today()::text$$,
  $$values (1, 'system', 'system', true)$$,
  'запуск отмечен в журнале действий одной записью: только числа');

-- ════════════════════════════════════════════════════════════════════════════
-- Выгрузка своих данных (ролью API)
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
create temporary table export_c1 on commit drop as select app.client_export() as doc;

select is((select doc -> 'account' ->> 'id' from export_c1), 'cccccccc-0000-0000-0000-000000000001',
  'выгрузка — своего аккаунта');
select results_eq(
  $$select doc -> 'profile' ->> 'firstName', doc -> 'profile' ->> 'phone', (doc -> 'profile' ->> 'telegramId')::bigint
    from export_c1$$,
  $$values ('Client1', '+998000000301', 1000001::bigint)$$,
  'профиль: имя, Telegram ID и свой телефон');
select set_eq(
  $$select r ->> 'id' from export_c1, jsonb_array_elements(doc -> 'requests') r$$,
  array['eeeeeeee-0000-0000-0000-0000000000a1', 'eeeeeeee-0000-0000-0000-0000000000c1',
        'eeeeeeee-0000-0000-0000-0000000000c2', 'eeeeeeee-0000-0000-0000-0000000000c3',
        'eeeeeeee-0000-0000-0000-0000000000c4'],
  'в выгрузке все свои заявки и только они');
select results_eq(
  $$select r -> 'contact' ->> 'name', r -> 'contact' ->> 'phone', r -> 'contact' ->> 'comment',
           r -> 'listing' ->> 'name', jsonb_array_length(r -> 'history')
    from export_c1, jsonb_array_elements(doc -> 'requests') r
    where r ->> 'id' = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  $$values ('Client1', '+998000000301', 'комментарий', 'Test Hall A1', 1)$$,
  'заявка: свои контакты, название площадки, история статусов');
select results_eq(
  $$select r -> 'contact' ->> 'phone', r -> 'contact' -> 'purgedAt' is not null
    from export_c1, jsonb_array_elements(doc -> 'requests') r
    where r ->> 'id' = 'eeeeeeee-0000-0000-0000-0000000000c2'$$,
  $$values (null::text, true)$$,
  'стёртые контакты в выгрузке — только отметка');
select results_eq(
  $$select c ->> 'purpose', c ->> 'action', (c ->> 'textVersion')::int, c ->> 'listingId'
    from export_c1, jsonb_array_elements(doc -> 'consents') c$$,
  $$values ('request_transfer', 'grant', 1, 'aaaaaaaa-0000-0000-0000-000000000101')$$,
  'журнал согласий: цель, действие, версия текста, листинг');
select ok(
  (select doc::text !~ '\+998000000(999|101|111|201|211|302)' and doc::text !~ 'actorId'
          and doc::text !~ 'eeeeeeee-0000-0000-0000-0000000000b1'
   from export_c1),
  'нет телефонов вендоров и чужих клиентов, id актёров и заявок другого клиента');
select results_eq(
  $$select h ->> 'to', h ->> 'actorKind'
    from export_c1, jsonb_array_elements(doc -> 'requests') r, jsonb_array_elements(r -> 'history') h
    where r ->> 'id' = 'eeeeeeee-0000-0000-0000-0000000000c3'
    order by h ->> 'at'$$,
  $$values ('new', 'system'), ('contacted', 'vendor_user'), ('deal', 'vendor_user')$$,
  'история: статусы и вид актора, без его id');

select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000002');
select results_eq(
  $$select r ->> 'id' from jsonb_array_elements(app.client_export() -> 'requests') r$$,
  $$values ('eeeeeeee-0000-0000-0000-0000000000b1')$$,
  'клиент C2 выгружает только свою заявку — заявки C1 ему не видны');

select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok($$select app.client_export()$$, 'BR003', 'forbidden_for_actor', 'вендор не выгружает данные клиента');
select pg_temp.as_actor(null);
select throws_ok($$select app.client_export()$$, 'BR003', 'forbidden_for_actor', 'без актора выгрузки нет');

reset role;
select results_eq(
  $$select actor_kind::text, subject_kind, subject_id::text, purpose from app.pii_access_log
    where actor_id = 'cccccccc-0000-0000-0000-000000000001' and subject_kind = 'client'$$,
  $$values ('client', 'client', 'cccccccc-0000-0000-0000-000000000001', 'self')$$,
  'чтение своего телефона при выгрузке записано в журнал доступа');

-- ════════════════════════════════════════════════════════════════════════════
-- Отзыв согласия (ролью API)
-- ════════════════════════════════════════════════════════════════════════════
insert into app.consent_texts (id, purpose, version, locale, body) values
  ('dddddddd-0000-0000-0000-000000000003', 'bot_notifications', 1, 'ru', 'Тестовый текст: уведомления в боте');
set local role bayramm_api;

select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$select app.client_withdraw_consent('request_transfer', 'aaaaaaaa-0000-0000-0000-000000000101', 'vendor_cabinet')$$,
  'BR003', 'forbidden_for_actor', 'вендор не отзывает согласие клиента');
select is(pii.read_request_phone('eeeeeeee-0000-0000-0000-0000000000a1'), '+998000000301',
  'до отзыва вендор A видит телефон из заявки');

select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select throws_ok(
  $$select app.client_withdraw_consent('request_transfer', null, 'tma')$$,
  '22023', 'invalid_argument', 'request_transfer — только с листингом');
select throws_ok(
  $$select app.client_withdraw_consent('bot_notifications', 'aaaaaaaa-0000-0000-0000-000000000101', 'tma')$$,
  '22023', 'invalid_argument', 'остальные цели — без листинга');
select throws_ok(
  $$select app.client_withdraw_consent('vendor_contact', null, 'tma')$$,
  '22023', 'invalid_argument', 'цели вендора клиенту недоступны');
select is(app.client_withdraw_consent('bot_notifications', null, 'tma'), null,
  'нечего отзывать — null, журнал не меняется');
select is(app.client_withdraw_consent('request_transfer', 'bbbbbbbb-0000-0000-0000-000000000101', 'tma'), null,
  'чужое согласие (C2 → B1) клиент C1 не отзовёт: у него такого нет');
select isnt(app.client_withdraw_consent('request_transfer', 'aaaaaaaa-0000-0000-0000-000000000101', 'tma', sha256('ip')),
  null, 'клиент отзывает согласие на передачу контактов листингу A1');
select is(app.client_withdraw_consent('request_transfer', 'aaaaaaaa-0000-0000-0000-000000000101', 'tma'), null,
  'повторный отзыв ничего не пишет');
insert into app.consents (subject_kind, subject_id, purpose, action, text_id, source)
  values ('client', 'cccccccc-0000-0000-0000-000000000001', 'bot_notifications', 'grant',
          'dddddddd-0000-0000-0000-000000000003', 'tma');

select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select is(pii.read_request_phone('eeeeeeee-0000-0000-0000-0000000000a1'), null,
  'после отзыва вендор A телефон из заявки не видит');
select is_empty(
  $$select request_id from pii.request_contacts where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'и строку контактов тоже');

reset role;
select results_eq(
  $$select action::text, text_id::text, source::text, ip_hash = sha256('ip') from app.consents
    where subject_id = 'cccccccc-0000-0000-0000-000000000001' and purpose = 'request_transfer'
    order by created_at$$,
  $$values ('grant', 'dddddddd-0000-0000-0000-000000000001', 'tma', null::boolean),
           ('withdraw', 'dddddddd-0000-0000-0000-000000000001', 'tma', true)$$,
  'журнал согласий: отзыв по тому же тексту, с источником и хэшем IP');
select ok(app.request_consent_active('eeeeeeee-0000-0000-0000-0000000000b1'),
  'согласие клиента C2 не затронуто');

-- ════════════════════════════════════════════════════════════════════════════
-- Удаление аккаунта (ролью API)
-- ════════════════════════════════════════════════════════════════════════════
insert into app.sessions (id, token_hash, client_id, via, expires_at) values
  ('5e000000-0000-0000-0000-0000000000c1', sha256('s-c1'), 'cccccccc-0000-0000-0000-000000000001', 'tg_client',
   now() + interval '7 days');
set local role bayramm_api;

select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok($$select * from app.client_delete_account('tma')$$, 'BR003', 'forbidden_for_actor',
  'вендор не удаляет аккаунт клиента');

select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select results_eq(
  $$select consents_withdrawn, requests_withdrawn, contacts_purged, sessions_revoked
    from app.client_delete_account('tma')$$,
  -- согласие на уведомления; заявки a1 и c4 (new); контакты a1 и c1; одна сессия
  $$values (1, 2, 2, 1)$$,
  'удаление: отзыв согласий, открытых заявок, стирание контактов, отзыв сессий');
select is_empty($$select * from app.client_delete_account('tma')$$,
  'повторное удаление ничего не делает');

reset role;
select is_empty(
  $$select client_id from pii.client_profiles where client_id = 'cccccccc-0000-0000-0000-000000000001'$$,
  'профиль с ПДн удалён');
select results_eq(
  $$select deleted_at is not null, can_message, tg_id_hash = sha256('client-1') from app.clients
    where id = 'cccccccc-0000-0000-0000-000000000001'$$,
  $$values (true, false, true)$$,
  'аккаунт помечен удалённым, псевдоним остался (для восстановления при входе)');
select is_empty(
  $$select purpose from app.consents_current
    where subject_id = 'cccccccc-0000-0000-0000-000000000001' and action = 'grant'$$,
  'действующих согласий не осталось');
select results_eq(
  $$select id::text, status::text from app.requests
    where client_id = 'cccccccc-0000-0000-0000-000000000001' order by id$$,
  $$values ('eeeeeeee-0000-0000-0000-0000000000a1', 'withdrawn'),
           ('eeeeeeee-0000-0000-0000-0000000000c1', 'expired'),
           ('eeeeeeee-0000-0000-0000-0000000000c2', 'expired'),
           ('eeeeeeee-0000-0000-0000-0000000000c3', 'deal'),
           ('eeeeeeee-0000-0000-0000-0000000000c4', 'withdrawn')$$,
  'заявки остались; открытые отозваны, закрытые не тронуты');
select results_eq(
  $$select actor_kind::text, actor_id::text, source::text, reason from app.request_status_log
    where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1' order by at desc, id desc limit 1$$,
  $$values ('client', 'cccccccc-0000-0000-0000-000000000001', 'tma', 'account_deleted')$$,
  'отзыв заявки при удалении — в журнале статусов с причиной');
select is_empty(
  $$select rc.request_id from pii.request_contacts rc join app.requests r on r.id = rc.request_id
    where r.client_id = 'cccccccc-0000-0000-0000-000000000001'
      and (rc.purged_at is null or rc.contact_name is not null or rc.contact_phone is not null)$$,
  'контакты во всех заявках клиента стёрты');
select is_empty(
  $$select id from app.sessions where client_id = 'cccccccc-0000-0000-0000-000000000001' and revoked_at is null$$,
  'сессии клиента отозваны');
select results_eq(
  $$select actor_kind::text, actor_id::text, source::text, detail ->> 'requests_withdrawn' from app.audit_log
    where action = 'client.delete_account' and object_id = 'cccccccc-0000-0000-0000-000000000001'$$,
  $$values ('client', 'cccccccc-0000-0000-0000-000000000001', 'tma', '2')$$,
  'удаление — в журнале действий, от имени клиента, без ПДн');

-- клиент C2 не затронут
select results_eq(
  $$select (select count(*)::int from pii.client_profiles where client_id = 'cccccccc-0000-0000-0000-000000000002'),
           (select status::text from app.requests where id = 'eeeeeeee-0000-0000-0000-0000000000b1'),
           (select contact_phone from pii.request_contacts where request_id = 'eeeeeeee-0000-0000-0000-0000000000b1'),
           (select count(*)::int from app.sessions
             where client_id = 'cccccccc-0000-0000-0000-000000000002' and revoked_at is null)$$,
  $$values (1, 'new', '+998000000302', 2)$$,
  'клиент C2: профиль, заявка, контакты и сессии на месте');

select * from finish();
rollback;
