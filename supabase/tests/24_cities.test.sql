-- Города (20261010090000_cities.sql): район — в городе; справочник читают и гости, меняют
-- только миграции
begin;
\ir _fixtures.psql
select plan(7);

select has_table('app', 'cities', 'справочник городов');
select set_eq('select code from app.cities', array['tashkent'], 'пока один город — Ташкент');
select is(
  (select count(*)::int from app.districts where city_code = 'tashkent'), 12,
  'все 12 районов — Ташкента');
select col_not_null('app', 'districts', 'city_code', 'у района всегда есть город');
select is_empty(
  $$select code from app.cities where name_uz ~ '[‘’`'']'$$,
  'в узбекских названиях городов нет прямых и «кавычечных» апострофов');

set local role bayramm_api;
select pg_temp.as_actor(null);
select results_eq(
  $$select c.code, count(d.code)::int from app.cities c join app.districts d on d.city_code = c.code
     group by c.code$$,
  $$values ('tashkent', 12)$$,
  'гость видит города и районы в них');
select throws_ok(
  $$insert into app.cities (code, name_ru, name_uz) values ('samarkand', 'Самарканд', 'Samarqand')$$,
  '42501', null, 'город заводит миграция, а не API');
reset role;

select * from finish();
rollback;
