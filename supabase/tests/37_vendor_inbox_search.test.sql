-- Поиск во входящих кабинета по концу номера клиента
-- (20261023090000_vendor_inbox_search.sql)
begin;
\ir _fixtures.psql
select plan(8);

select ok(has_function_privilege('bayramm_api', 'pii.vendor_requests_by_phone_tail(text)', 'EXECUTE'),
  'API: поиск по концу номера');
select ok(not has_function_privilege('public', 'pii.vendor_requests_by_phone_tail(text)', 'EXECUTE'),
  'остальным — нет');

-- Партнёр A: заявка C1 (+998000000301) — его, заявка C2 (…0302) — вендора B
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select results_eq($$select pii.vendor_requests_by_phone_tail('0301')$$,
  $$values ('eeeeeeee-0000-0000-0000-0000000000a1'::uuid)$$, 'свой клиент — по четырём последним цифрам');
select is_empty($$select pii.vendor_requests_by_phone_tail('0302')$$, 'чужой заявки не видно');
select is_empty($$select pii.vendor_requests_by_phone_tail('301')$$, 'меньше четырёх цифр — не поиск');
select is_empty($$select pii.vendor_requests_by_phone_tail('03 1')$$, 'только цифры');

-- Клиент не ищет чужие заявки по номеру
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select is_empty($$select pii.vendor_requests_by_phone_tail('0301')$$, 'не партнёру — пусто');

-- Номер стёрт по сроку хранения — не находится
select pg_temp.as_actor(null);
update pii.request_contacts set purged_at = now(), contact_name = null, contact_phone = null, comment = null
 where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1';
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select is_empty($$select pii.vendor_requests_by_phone_tail('0301')$$, 'стёртый номер не ищется');

select * from finish();
rollback;
