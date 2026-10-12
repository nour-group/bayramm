-- Счётчик «Модерации» знает про смену контактов (20261012120000_contacts_queue_count.sql):
-- app.metrics_ops_now().contacts_pending — ждущие запросы, решённые и отозванные не в счёт
begin;
\ir _fixtures.psql
select plan(4);

select ok(has_function_privilege('bayramm_api', 'app.metrics_ops_now()', 'EXECUTE'), 'API: очереди команды');

select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select results_eq($$select contacts_pending from app.metrics_ops_now()$$, $$values (0)$$,
  'запросов нет — ноль');

-- Ждущий у A1, решённые у B1 — прямо в таблицу (как их оставляют функции запроса)
insert into pii.listing_contact_changes (listing_id, public_phone, status) values
  ('aaaaaaaa-0000-0000-0000-000000000101', '+998901112233', 'pending');
insert into pii.listing_contact_changes (listing_id, status, reason, decided_at) values
  ('bbbbbbbb-0000-0000-0000-000000000101', 'declined', 'Номер не отвечает', clock_timestamp()),
  ('bbbbbbbb-0000-0000-0000-000000000101', 'withdrawn', null, clock_timestamp());

select results_eq($$select contacts_pending from app.metrics_ops_now()$$, $$values (1)$$,
  'ждёт решения один запрос: отклонённый и отозванный — не в счёт');

select pg_temp.as_actor(null);
select throws_ok($$select * from app.metrics_ops_now()$$, 'BR003', 'forbidden_for_actor', 'без актора — нет');

select * from finish();
rollback;
