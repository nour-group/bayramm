-- Поиск прощает лишние слова (20261023110000_catalog_search_forgiving.sql): служебные слова и слова
-- о цене не ищутся; по всем словам вместе ничего — выдача без слов, которые сами ничего не находят,
-- и они — в dropped
begin;
\ir _fixtures.psql
select plan(16);

-- Слаги найденного по порядку оценки и пропущенные слова — только витрины фикстур (вендоры A и B)
create function pg_temp.found(p_query text, p_category text default null)
returns text[]
language sql
as $$
  select coalesce(array_agg(l.slug order by s.score desc, l.slug), '{}')
  from app.catalog_search(p_query, p_category) s join app.listings l on l.id = s.listing_id
  where l.vendor_id in ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001')
$$;

create function pg_temp.dropped(p_query text, p_category text default null)
returns text[]
language sql
as $$
  select coalesce((select array_agg(distinct d order by d)
                   from app.catalog_search(p_query, p_category) s, unnest(s.dropped) d), '{}')
$$;

-- ── слова запроса ───────────────────────────────────────────────────────────
select is(app.search_query_words('недорогой зал на Чиланзаре'), array['zal', 'chilanzare'],
  'слово о цене и служебное — не ищутся');
select is(app.search_query_words('toʻy uchun arzon tort'), array['toy', 'tort'], 'по-узбекски — так же');
select is(app.search_query_words('за'), array['za'], 'одно служебное слово ищется: «за» — начало «ЗАГС»');
select is(app.search_query_words('Дёшево'), '{}'::text[], 'одни слова о цене — не поиск');
select is(app.search_query_words('aa bb cc dd ee ff gg'), array['aa', 'bb', 'cc', 'dd', 'ee', 'ff'],
  'не больше шести слов');
select is((select provolatile::text from pg_proc where oid = 'app.search_query_words(text)'::regprocedure), 'i',
  'search_query_words — immutable');
select ok(not has_function_privilege('bayramm_api', 'app.search_query_words(text)', 'EXECUTE'),
  'API зовёт только app.catalog_search');

-- ── поиск ───────────────────────────────────────────────────────────────────
select is(pg_temp.found('test hall'), array['test-a1', 'test-b1'], 'все слова нашли — как раньше');
select is(pg_temp.dropped('test hall'), '{}'::text[], 'все слова нашли — пропущенных нет');
select is(pg_temp.found('zzqqxx test hall'), array['test-a1', 'test-b1'],
  'слово, которое ничего не находит, пропускается');
select is(pg_temp.dropped('zzqqxx test hall'), array['zzqqxx'], 'пропущенное слово — в dropped');
select is(pg_temp.found('test hall для банкета'), pg_temp.found('test hall банкета'),
  'служебное слово не мешает');
select is(pg_temp.found('недорогой test hall'), array['test-a1', 'test-b1'],
  'слово о цене не мешает (порядок «сначала дешевле» выбирает API)');
select is(pg_temp.found('a1 b1'), '{}'::text[],
  'каждое слово находит своё, но не вместе, — пусто, а не всё подряд');
select is(pg_temp.found('zzqqxx qqzzyy'), '{}'::text[], 'ни одно слово не нашло — пусто');
select is(pg_temp.found('zzqqxx test hall', 'hall'), array['test-a1', 'test-b1'],
  'в разделе — так же');

select * from finish();
rollback;
