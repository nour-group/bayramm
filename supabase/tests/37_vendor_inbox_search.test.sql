-- Поиск во входящих кабинета по концу номера клиента
-- (20261023090000_vendor_inbox_search.sql)
begin;
\ir _fixtures.psql
select plan(14);

select ok(has_function_privilege('bayramm_api', 'pii.vendor_requests_by_phone_tail(text)', 'EXECUTE'),
  'API: поиск по концу номера');
select ok(not has_function_privilege('public', 'pii.vendor_requests_by_phone_tail(text)', 'EXECUTE'),
  'остальным — нет');

-- Партнёр A: заявка C1 (+998000000301) — его, заявка C2 (…0302) — вендора B
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select is(pii.vendor_requests_by_phone_tail('0301'), array['eeeeeeee-0000-0000-0000-0000000000a1']::uuid[],
  'свой клиент — по четырём последним цифрам');
select is(pii.vendor_requests_by_phone_tail('0302'), '{}'::uuid[], 'чужой заявки не видно');
select is(pii.vendor_requests_by_phone_tail('301'), '{}'::uuid[], 'меньше четырёх цифр — не поиск');
select is(pii.vendor_requests_by_phone_tail('03 1'), '{}'::uuid[], 'только цифры');

-- Каждый поиск по номеру — строка журнала доступа к ПДн: вендор, сколько совпало, без цифр
select results_eq(
  $$select actor_kind::text, actor_id, subject_kind, subject_id, purpose, reason from app.pii_access_log
    where subject_kind = 'vendor_inbox' order by id$$,
  $$values ('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011'::uuid, 'vendor_inbox',
            'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'request_search', 'совпадений: 1'),
           ('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011'::uuid, 'vendor_inbox',
            'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'request_search', 'совпадений: 0')$$,
  'в журнале — два поиска; кривой запрос — не поиск, строки нет');
select is_empty($$select 1 from app.pii_access_log where reason ~ '0301|0302'$$, 'цифр номера в журнале нет');

-- Клиент не ищет чужие заявки по номеру
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select is(pii.vendor_requests_by_phone_tail('0301'), '{}'::uuid[], 'не партнёру — пусто');

-- Партнёр B находит своего клиента, пока тот не отозвал согласие
select pg_temp.as_actor('vendor_user', 'bbbbbbbb-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001');
select is(pii.vendor_requests_by_phone_tail('0302'), array['eeeeeeee-0000-0000-0000-0000000000b1']::uuid[],
  'партнёр B — своего клиента');
select pg_temp.as_actor(null);
insert into app.consents (subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source)
values ('client', 'cccccccc-0000-0000-0000-000000000002', 'request_transfer', 'withdraw',
        'dddddddd-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000101', 'tma');
select ok(not app.request_consent_active('eeeeeeee-0000-0000-0000-0000000000b1'), 'согласие C2 отозвано');
select pg_temp.as_actor('vendor_user', 'bbbbbbbb-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001');
select is(pii.vendor_requests_by_phone_tail('0302'), '{}'::uuid[], 'согласие отозвано — не находится');

-- Клиент отозвал заявку — тоже не находится
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select lives_ok($$update app.requests set status = 'withdrawn' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'C1 отзывает заявку');
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select is(pii.vendor_requests_by_phone_tail('0301'), '{}'::uuid[], 'отозванная заявка — не находится');

select * from finish();
rollback;
