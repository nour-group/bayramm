-- API клиента: правила создания заявки (миграция 20260930110000_client_api) —
-- гостей не больше вместимости, лимит заявок клиента за 24 часа
begin;
\ir _fixtures.psql
select plan(14);

-- ── структура и права ───────────────────────────────────────────────────────
select has_trigger('app', 'requests', 'requests_client_rules', 'правила клиента — триггер на app.requests');
select ok(not has_function_privilege('bayramm_api', 'app.requests_client_rules()', 'EXECUTE'),
  'триггерную функцию API не вызывает');

-- Лимит в тесте — 3 заявки за 24 часа. У C1 уже есть RA (создана фикстурой только что)
update app.settings set value = '3' where key = 'client_requests_per_day';

-- ── вместимость (роль API, актор — клиент C1; A1: cap_max = 300) ────────────
set local role bayramm_api;
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');

select throws_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101',
            'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1',
            'toy', current_date + 70, 301, 'tma')$$,
  'BR015', 'guests_over_capacity', 'гостей больше cap_max — заявка не создаётся');
select lives_ok(
  $$insert into app.requests (id, client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('eeeeeeee-0000-0000-0000-0000000009a1', 'cccccccc-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001',
            'ffffffff-0000-0000-0000-0000000000a1', 'toy', current_date + 70, 300, 'tma')$$,
  'ровно cap_max гостей — можно (вторая заявка C1 за сутки)');

-- ── лимит за 24 часа ────────────────────────────────────────────────────────
select lives_ok(
  $$insert into app.requests (id, client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('eeeeeeee-0000-0000-0000-0000000009a2', 'cccccccc-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001',
            'ffffffff-0000-0000-0000-0000000000a1', 'toy', current_date + 71, 100, 'web')$$,
  'третья заявка за сутки — можно');
select throws_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101',
            'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1',
            'toy', current_date + 72, 100, 'tma')$$,
  'BR014', 'daily_request_limit', 'четвёртая за сутки — лимит');

select lives_ok(
  $$update app.requests set status = 'withdrawn' where id = 'eeeeeeee-0000-0000-0000-0000000009a2'$$,
  'клиент отзывает заявку');
select throws_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101',
            'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1',
            'toy', current_date + 72, 100, 'tma')$$,
  'BR014', 'daily_request_limit', 'отозванная заявка из лимита не выходит');
select is(
  (select count(*)::int from app.requests where client_id = 'cccccccc-0000-0000-0000-000000000001'),
  3, 'отклонённые вставки ничего не оставили');

-- Лимит — на клиента: у C2 свой счёт
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000002');
select lives_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('cccccccc-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000101',
            'bbbbbbbb-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000b1',
            'bd', current_date + 31, 80, 'tma')$$,
  'лимит одного клиента не мешает другому');

-- Заявка, внесённая оператором за клиента, в лимит не входит
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select lives_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101',
            'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1',
            'toy', current_date + 73, 100, 'admin')$$,
  'source = admin — без лимита');
select throws_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101',
            'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1',
            'toy', current_date + 74, 301, 'admin')$$,
  'BR015', 'guests_over_capacity', 'вместимость проверяется и для заявки оператора');

-- ── окно — последние 24 часа ────────────────────────────────────────────────
-- created_at неизменяем (requests_before_update) — сдвигаем в прошлое в обход
-- триггера: только внутри этой откатываемой транзакции
reset role;
alter table app.requests disable trigger requests_before_update;
update app.requests set created_at = now() - interval '25 hours'
where client_id = 'cccccccc-0000-0000-0000-000000000001';
alter table app.requests enable trigger requests_before_update;

set local role bayramm_api;
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select lives_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101',
            'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1',
            'toy', current_date + 72, 100, 'tma')$$,
  'заявки старше 24 часов в лимит не входят');

-- Лимит меняет миграция или сотрудник в базе — у API нет прав на настройки
select throws_ok(
  $$update app.settings set value = '100' where key = 'client_requests_per_day'$$,
  '42501', null, 'API не меняет лимит');

select * from finish();
rollback;
