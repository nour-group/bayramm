-- Контакты витрины по «Связаться»: Telegram рядом с телефоном, читается только функциями;
-- открыть контакты нельзя без события «открыли»; события — без клиента; метрики — сотруднику
begin;
\ir _fixtures.psql
select plan(13);

select has_column('pii', 'listing_contacts', 'public_telegram', 'Telegram витрины — рядом с телефоном');
select ok(not has_column_privilege('bayramm_api', 'pii.listing_contacts', 'public_telegram', 'SELECT'),
  'столбцом API его не читает — только функциями');
select has_table('app', 'contact_events', 'события «связаться»');
select hasnt_column('app', 'contact_events', 'client_id', 'без клиента: только витрина, канал, источник');

select throws_ok(
  $$update pii.listing_contacts set public_telegram = 'bad name'
     where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  '23514', null, 'не имя Telegram база не примет');
update pii.listing_contacts set public_telegram = 'test_hall_a1'
 where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101';

set local role bayramm_api;
select pg_temp.as_actor(null);
select is(pii.listing_contact_kinds('aaaaaaaa-0000-0000-0000-000000000101'), array['phone', 'telegram'],
  'гостю — какие каналы есть, без значений');
select results_eq(
  $$select phone, telegram from pii.reveal_listing_contacts('aaaaaaaa-0000-0000-0000-000000000101', 'web', false)$$,
  $$values ('+998000000999'::text, 'test_hall_a1'::text)$$,
  'гостю — контакты опубликованной витрины');
select is_empty(
  $$select * from pii.reveal_listing_contacts('aaaaaaaa-0000-0000-0000-000000000102', 'web', false)$$,
  'черновика — ничего');
select ok(app.record_contact_event('aaaaaaaa-0000-0000-0000-000000000101', 'phone', 'tma', true),
  'выбор канала записан');
select ok(not app.record_contact_event('aaaaaaaa-0000-0000-0000-000000000102', 'phone', 'tma', true),
  'у черновика — нет');
select throws_ok(
  $$select app.record_contact_event('aaaaaaaa-0000-0000-0000-000000000101', 'sms', 'web', false)$$,
  '22023', null, 'неизвестный канал — ошибка');
select throws_ok($$select * from app.metrics_contacts(30)$$, 'BR003', null, 'метрики гостю — нет');

select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select results_eq(
  $$select opens, phone, telegram from app.metrics_contacts(30)
     where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  $$values (1, 1, 0)$$,
  'сотруднику — открытия и звонки витрины');
reset role;

select * from finish();
rollback;
