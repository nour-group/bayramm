-- Избранное клиента: только свои строки, добавляют функции (опубликованные площадки,
-- не больше 100), слияние гостевого списка, выгрузка и удаление аккаунта
begin;
\ir _fixtures.psql
select plan(27);

-- ════════════════════════════════════════════════════════════════════════════
-- Таблица и права
-- ════════════════════════════════════════════════════════════════════════════
select has_table('app', 'favorites', 'избранное клиента');
select ok(has_table_privilege('bayramm_api', 'app.favorites', 'SELECT')
          and has_table_privilege('bayramm_api', 'app.favorites', 'DELETE'),
  'API читает и убирает отметки (под RLS)');
select ok(not has_table_privilege('bayramm_api', 'app.favorites', 'INSERT')
          and not has_table_privilege('bayramm_api', 'app.favorites', 'UPDATE'),
  'добавляют только функции: INSERT и UPDATE у API нет');
select ok(has_function_privilege('bayramm_api', 'app.client_favorite_add(uuid)', 'EXECUTE')
          and has_function_privilege('bayramm_api', 'app.client_favorites_merge(uuid[])', 'EXECUTE'),
  'API добавляет отметку и сливает гостевой список функциями базы');
select is_empty(
  $$select f from unnest(array['app.favorites_client()', 'app.clients_forget_favorites()']) f
    where has_function_privilege('bayramm_api', f, 'EXECUTE')$$,
  'служебные функции избранного API недоступны');

-- ════════════════════════════════════════════════════════════════════════════
-- Добавление: только опубликованные, без повторов
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select is(app.client_favorite_add('aaaaaaaa-0000-0000-0000-000000000101'), 'added',
  'клиент C1 отмечает опубликованную площадку A1');
select is(app.client_favorite_add('aaaaaaaa-0000-0000-0000-000000000101'), 'already',
  'повторная отметка ничего не меняет');
select is(app.client_favorite_add('aaaaaaaa-0000-0000-0000-000000000102'), 'not_found',
  'черновик A2 не отметить — как будто его нет');
select is(app.client_favorite_add('00000000-0000-4000-8000-000000000999'), 'not_found',
  'несуществующую площадку — тоже not_found');
select throws_ok(
  $$insert into app.favorites (client_id, listing_id)
    values ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000101')$$,
  '42501', null, 'вставить строку в обход функции нельзя');

-- ════════════════════════════════════════════════════════════════════════════
-- Только свои строки
-- ════════════════════════════════════════════════════════════════════════════
select results_eq($$select listing_id::text from app.favorites$$,
  $$values ('aaaaaaaa-0000-0000-0000-000000000101')$$, 'C1 видит свою отметку');

select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000002');
select is_empty($$select 1 from app.favorites$$, 'C2 чужих отметок не видит');
delete from app.favorites where client_id = 'cccccccc-0000-0000-0000-000000000001';

select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select is_empty($$select 1 from app.favorites$$, 'сотруднику избранное клиентов не видно');
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select is_empty($$select 1 from app.favorites$$, 'вендору — тоже');
select throws_ok($$select app.client_favorite_add('aaaaaaaa-0000-0000-0000-000000000101')$$,
  'BR003', 'forbidden_for_actor', 'вендор отметок не ставит');

reset role;
select is((select count(*)::int from app.favorites where client_id = 'cccccccc-0000-0000-0000-000000000001'), 1,
  'удаление от имени C2 чужую отметку не тронуло');

-- ════════════════════════════════════════════════════════════════════════════
-- Слияние гостевого списка
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000002');
select is(app.client_favorites_merge(array[
  'bbbbbbbb-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000102',
  'aaaaaaaa-0000-0000-0000-000000000101', 'bbbbbbbb-0000-0000-0000-000000000101',
  '00000000-0000-4000-8000-000000000999']::uuid[]), 2,
  'из гостевого списка — только опубликованные, повторы — один раз');
select is(app.client_favorites_merge(array['aaaaaaaa-0000-0000-0000-000000000101']::uuid[]), 0,
  'уже отмеченные не добавляются второй раз');
select throws_ok(
  $$select app.client_favorites_merge(array(select gen_random_uuid() from generate_series(1, 101)))$$,
  '22023', 'invalid_argument', 'больше 100 id за раз — ошибка аргумента');

-- ════════════════════════════════════════════════════════════════════════════
-- Не больше 100
-- ════════════════════════════════════════════════════════════════════════════
reset role;
insert into app.listings (id, vendor_id, slug, category_code, name)
select ('f0f0f0f0-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'aaaaaaaa-0000-0000-0000-000000000001',
       'fav-test-' || n, 'hall', 'Fav ' || n
from generate_series(1, 99) n;
insert into app.favorites (client_id, listing_id)
select 'cccccccc-0000-0000-0000-000000000001', ('f0f0f0f0-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
from generate_series(1, 99) n;

set local role bayramm_api;
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select is(app.client_favorite_add('bbbbbbbb-0000-0000-0000-000000000101'), 'full',
  'сотая отметка есть — сто первую не добавить');
select is(app.client_favorites_merge(array['bbbbbbbb-0000-0000-0000-000000000101']::uuid[]), 0,
  'слияние сверх лимита молча ничего не добавляет');
delete from app.favorites where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101';
select is(app.client_favorite_add('bbbbbbbb-0000-0000-0000-000000000101'), 'added',
  'убрал одну — место освободилось');

-- ════════════════════════════════════════════════════════════════════════════
-- Снятая с публикации площадка, выгрузка, удаление аккаунта
-- ════════════════════════════════════════════════════════════════════════════
reset role;
select pg_temp.as_actor(null);
update app.listings set status = 'suspended', status_reason = 'ремонт' where id = 'bbbbbbbb-0000-0000-0000-000000000101';
select is((select count(*)::int from app.favorites where listing_id = 'bbbbbbbb-0000-0000-0000-000000000101'), 2,
  'снятая с публикации площадка из избранного не пропадает (API её просто не показывает)');

set local role bayramm_api;
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000002');
select results_eq(
  $$select f -> 'listing' ->> 'id' from jsonb_array_elements(app.client_export() -> 'favorites') f
    order by 1$$,
  $$values ('aaaaaaaa-0000-0000-0000-000000000101'), ('bbbbbbbb-0000-0000-0000-000000000101')$$,
  'выгрузка своих данных — со списком избранного');
select ok((select bool_and(f ? 'savedAt') from jsonb_array_elements(app.client_export() -> 'favorites') f),
  'в выгрузке — когда отмечена');

select lives_ok($$select * from app.client_delete_account('tma')$$, 'C2 удаляет аккаунт');
reset role;
select is((select count(*)::int from app.favorites where client_id = 'cccccccc-0000-0000-0000-000000000002'), 0,
  'удаление аккаунта стирает избранное');

select * from finish();
rollback;
