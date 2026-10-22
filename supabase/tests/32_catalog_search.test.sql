-- Поиск по каталогу (20261015090000_catalog_search.sql): нормализация — те же векторы, что у
-- searchNorm в TS; документ витрины поддерживают триггеры; app.catalog_search находит активные
-- витрины по всем словам запроса, с опечаткой и в другой записи, и упорядочивает: начало названия
-- > название > раздел, район, услуги > описание
begin;
\ir _fixtures.psql
select plan(84);

-- Опубликовать зал, как в фикстурах: контакты, банкеты, три готовых фото, проверка → каталог
create function pg_temp.publish(p_listing uuid)
returns void
language plpgsql
as $$
begin
  insert into pii.listing_contacts (listing_id, public_phone) values (p_listing, '+998000000999');
  insert into app.listing_services (listing_id, category_code, service_type, status, price_uzs, price_unit, sort) values
    (p_listing, 'hall', 'banquet_weekday', 'active', 150000, 'per_guest', 1),
    (p_listing, 'hall', 'banquet_weekend', 'active', 180000, 'per_guest', 2);
  insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256,
                          sort, no_faces_ack)
  select p_listing, 'ready', 'approved', pg_temp.photo_key(p_listing), 'image/webp', 1000, 1600, 1200,
         sha256(convert_to(p_listing || '/' || n, 'UTF8')), n, true
  from generate_series(1, 3) n;
  update app.listings set status = 'review' where id = p_listing;
  update app.listings set status = 'active' where id = p_listing;
end $$;

-- Слаги найденного по порядку оценки — только витрины фикстур (вендоры A и B): в базе бывают и
-- чужие данные
create function pg_temp.found(p_query text, p_category text default null)
returns text[]
language sql
as $$
  select coalesce(array_agg(l.slug order by s.score desc, l.slug), '{}')
  from app.catalog_search(p_query, p_category) s join app.listings l on l.id = s.listing_id
  where l.vendor_id in ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001')
$$;

-- ── расширение, функции, права ──────────────────────────────────────────────
select is((select extnamespace::regnamespace::text from pg_extension where extname = 'pg_trgm'), 'extensions',
  'pg_trgm — в схеме extensions');
select is((select provolatile::text from pg_proc where oid = 'app.search_norm(text)'::regprocedure), 'i',
  'search_norm — immutable');
select ok((select relrowsecurity from pg_class where oid = 'app.listing_search'::regclass),
  'RLS на документах поиска');
select ok(not has_table_privilege('bayramm_api', 'app.listing_search', 'SELECT'),
  'API документы поиска не читает — только через app.catalog_search');
select ok(has_function_privilege('bayramm_api', 'app.catalog_search(text, text)', 'EXECUTE'),
  'API ищет функцией');
select ok(not has_function_privilege('bayramm_api', 'app.listing_search_refresh(uuid[])', 'EXECUTE'),
  'документы пересобирают только триггеры');
select ok((select relrowsecurity from pg_class where oid = 'app.search_words'::regclass)
          and not has_table_privilege('bayramm_api', 'app.search_words', 'SELECT'),
  'словарь слов: RLS, у API прав нет');

-- ── общие векторы TS и SQL ──────────────────────────────────────────────────
-- search-vectors:begin (pnpm --filter @bayramm/shared search:sql)
select is(app.search_norm('Яккасарай'), 'yakkasaray', 'search_norm: Яккасарай');
select is(app.search_norm('Шайхантахур'), 'shayxantaxur', 'search_norm: Шайхантахур');
select is(app.search_norm('кортеж'), 'kortej', 'search_norm: кортеж');
select is(app.search_norm('КОРТЕЖ'), 'kortej', 'search_norm: КОРТЕЖ');
select is(app.search_norm('Toʻyxona'), 'toyxona', 'search_norm: Toʻyxona');
select is(app.search_norm('to''yxona'), 'toyxona', 'search_norm: to''yxona');
select is(app.search_norm('toyxona'), 'toyxona', 'search_norm: toyxona');
select is(app.search_norm('To`yxona'), 'toyxona', 'search_norm: To`yxona');
select is(app.search_norm('To’yxona'), 'toyxona', 'search_norm: To’yxona');
select is(app.search_norm('To‘yxona'), 'toyxona', 'search_norm: To‘yxona');
select is(app.search_norm('To´yxona'), 'toyxona', 'search_norm: To´yxona');
select is(app.search_norm('Тўйхона'), 'toyxona', 'search_norm: Тўйхона');
select is(app.search_norm('Ўрда Қасри'), 'orda qasri', 'search_norm: Ўрда Қасри');
select is(app.search_norm('Ғунча'), 'guncha', 'search_norm: Ғунча');
select is(app.search_norm('Ҳовли'), 'hovli', 'search_norm: Ҳовли');
select is(app.search_norm('Gʻuncha'), 'guncha', 'search_norm: Gʻuncha');
select is(app.search_norm('maʼno'), 'mano', 'search_norm: maʼno');
select is(app.search_norm('Объезд'), 'obezd', 'search_norm: Объезд');
select is(app.search_norm('Щука'), 'shuka', 'search_norm: Щука');
select is(app.search_norm('Цех'), 'tsex', 'search_norm: Цех');
select is(app.search_norm('Ёлка'), 'yolka', 'search_norm: Ёлка');
select is(app.search_norm('Юнусабад'), 'yunusabad', 'search_norm: Юнусабад');
select is(app.search_norm('Чиланзар'), 'chilanzar', 'search_norm: Чиланзар');
select is(app.search_norm('Мирзо-Улугбек'), 'mirzo ulugbek', 'search_norm: Мирзо-Улугбек');
select is(app.search_norm('Mirzo Ulugʻbek'), 'mirzo ulugbek', 'search_norm: Mirzo Ulugʻbek');
select is(app.search_norm('Мерседес S-class'), 'mersedes s class', 'search_norm: Мерседес S-class');
select is(app.search_norm('Café Élite'), 'cafe elite', 'search_norm: Café Élite');
select is(app.search_norm('  Grand   Hall #2  '), 'grand hall 2', 'search_norm:   Grand   Hall #2  ');
select is(app.search_norm('love-story!!!'), 'love story', 'search_norm: love-story!!!');
select is(app.search_norm('★★★'), '', 'search_norm: ★★★');
select is(app.search_norm(''), '', 'search_norm: ');
select ok(app.search_matches('Яккасарай', 'Yakkasaroy'), 'подходит: Яккасарай → Yakkasaroy');
select ok(app.search_matches('Шайхантахур', 'Shayxontohur'), 'подходит: Шайхантахур → Shayxontohur');
select ok(app.search_matches('кортеж', 'Kortej'), 'подходит: кортеж → Kortej');
select ok(app.search_matches('kartej', 'Kortej'), 'подходит: kartej → Kortej');
select ok(app.search_matches('versl', 'Versal'), 'подходит: versl → Versal');
select ok(app.search_matches('kor', 'Kortej'), 'подходит: kor → Kortej');
select ok(app.search_matches('toʻyxona', 'Toyxona Versal'), 'подходит: toʻyxona → Toyxona Versal');
select ok(app.search_matches('mercedes', 'Mercedes-Benz S-Class'), 'подходит: mercedes → Mercedes-Benz S-Class');
select ok(app.search_matches('зал для банкета', 'Банкетный зал'), 'подходит: зал для банкета → Банкетный зал');
select ok(app.search_matches('недорогой зал', 'Зал Наврўз'), 'подходит: недорогой зал → Зал Наврўз');
select ok(app.search_matches('toʻy uchun arzon tort', 'Tort toʻy'), 'подходит: toʻy uchun arzon tort → Tort toʻy');
select ok(not app.search_matches('zal', 'ZAGS'), 'не подходит: zal → ZAGS');
select ok(not app.search_matches('versal', 'Vesna'), 'не подходит: versal → Vesna');
select ok(not app.search_matches('kortej mercedes', 'Kortej'), 'не подходит: kortej mercedes → Kortej');
-- search-vectors:end

-- ── документ витрины ────────────────────────────────────────────────────────
select is_empty(
  $$select l.id from app.listings l left join app.listing_search s on s.listing_id = l.id
    where s.listing_id is null$$,
  'документ есть у каждой витрины');
select ok(
  (select s.doc ~ 'test hall a1' and s.doc ~ 'toyxona' and s.doc ~ 'yunusabad' and s.doc ~ 'yunusobod'
     and s.doc ~ 'banket' and s.descr = 'opisanie tavsif'
   from app.listing_search s where s.listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  'название, раздел, район ru и uz, услуги — в doc; описания — в descr');

-- Название и описание сменились — документ тоже
update app.listings set name = 'Oqsaroy', description_ru = 'Зал у фонтана'
where id = 'aaaaaaaa-0000-0000-0000-000000000101';
select ok(
  (select s.name = 'oqsaroy' and s.doc !~ 'test hall a1' and s.descr ~ 'fontana'
   from app.listing_search s where s.listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  'правка названия и описания пересобирает документ');

-- Услуги: «другая услуга» — своим названием; черновик не ищется, после одобрения — ищется
insert into app.listing_services (id, listing_id, category_code, service_type, status, price_uzs, price_unit,
                                  name_ru, name_uz, sort)
values ('99999999-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101', 'hall', 'other',
        'draft', 50000, 'per_event', 'Фейерверк', 'Mushakbozlik', 9);
select ok((select s.doc !~ 'feyerverk' from app.listing_search s
           where s.listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  'черновик услуги клиенту не виден — и в поиске его нет');
update app.listing_services set status = 'active' where id = '99999999-0000-0000-0000-000000000001';
select ok((select s.doc ~ 'feyerverk' and s.doc ~ 'mushakbozlik' from app.listing_search s
           where s.listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  'одобренная «другая услуга» ищется своим названием на обоих языках');
delete from app.listing_services where id = '99999999-0000-0000-0000-000000000001';
select ok((select s.doc !~ 'feyerverk' from app.listing_search s
           where s.listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  'удалённая услуга из документа уходит');

-- Справочники: район, раздел, тип услуги переименовали — документы витрин тоже
update app.districts set name_ru = 'Юнусабадский' where code = 'yunusobod';
select ok((select s.doc ~ 'yunusabadskiy' from app.listing_search s
           where s.listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  'новое название района — в документах его витрин');
update app.categories set name_ru = 'Банкетный зал' where code = 'hall';
select ok((select bool_and(s.doc ~ 'banketniy zal') from app.listing_search s
           join app.listings l on l.id = s.listing_id where l.category_code = 'hall'),
  'новое название раздела — в документах всех его витрин');
update app.service_types set name_ru = 'Банкет в будни дни' where category_code = 'hall' and code = 'banquet_weekday';
select ok((select s.doc ~ 'budni dni' from app.listing_search s
           where s.listing_id = 'bbbbbbbb-0000-0000-0000-000000000101'),
  'новое название типа услуги — в документах витрин с этой услугой');

-- Поля витрины: текст (марка машины в автопарке) — ищется, коды вариантов — нет
insert into app.listings (id, vendor_id, slug, category_code, name, attributes) values
  ('aaaaaaaa-0000-0000-0000-000000000103', 'aaaaaaaa-0000-0000-0000-000000000001', 'test-car', 'car', 'Auto Lux',
   '{"fleet": [{"model": "Mercedes-Benz S-Class", "class": "premium"}, {"model": "Chevrolet Malibu", "class": "business"}]}');
select ok(
  (select s.doc ~ 'mercedes benz s class' and s.doc ~ 'chevrolet malibu' and s.doc !~ 'premium'
     and s.doc ~ 'kortej'
   from app.listing_search s where s.listing_id = 'aaaaaaaa-0000-0000-0000-000000000103'),
  'марки автопарка — в документе, коды классов — нет');
select is(app.listing_attrs_text('car', '{"fleet": {"model": "Lada"}}'), 'Lada',
  'одна запись вместо списка — тоже текст (lax-режим JSONPath)');
select is(app.listing_attrs_text('hall', '{"fleet": [{"model": "Lada"}]}'), '',
  'у раздела без текстовых полей — пусто');

-- ── поиск ───────────────────────────────────────────────────────────────────
update app.listings set name = 'Test Hall A1', description_ru = 'Описание'
where id = 'aaaaaaaa-0000-0000-0000-000000000101';
insert into app.listings (id, vendor_id, slug, category_code, name, district_code,
                          description_ru, description_uz, cap_min, cap_max) values
  ('bbbbbbbb-0000-0000-0000-000000000102', 'bbbbbbbb-0000-0000-0000-000000000001', 'chilonzor-palace', 'hall',
   'Chilonzor Palace', 'yunusobod', 'Большой зал', 'Katta zal', 50, 400),
  ('bbbbbbbb-0000-0000-0000-000000000103', 'bbbbbbbb-0000-0000-0000-000000000001', 'versal', 'hall',
   'Versal', 'chilonzor', 'Банкетный зал', 'Banket zali', 50, 400),
  ('bbbbbbbb-0000-0000-0000-000000000104', 'bbbbbbbb-0000-0000-0000-000000000001', 'grand', 'hall',
   'Grand', 'sergeli', 'Рядом с Чиланзаром', 'Chilonzor yonida', 50, 400);
select pg_temp.publish('bbbbbbbb-0000-0000-0000-000000000102');
select pg_temp.publish('bbbbbbbb-0000-0000-0000-000000000103');
select pg_temp.publish('bbbbbbbb-0000-0000-0000-000000000104');

select is(pg_temp.found('chilonzor'), array['chilonzor-palace', 'test-b1', 'versal', 'grand'],
  'начало названия > район > описание');
select is(pg_temp.found('Чиланзар'), array['test-b1', 'versal', 'grand'],
  'кириллицей — по русскому названию района и описанию (название латиницей «Chilonzor» — другое слово)');
select is(pg_temp.found('versl'), array['versal'], 'опечатка: «versl» → Versal');
select ok(exists (select 1 from app.search_words where word = 'versal')
          and not exists (select 1 from app.search_words where length(word) < 4),
  'слова документов от четырёх букв — в словаре');
select ok(pg_temp.found('toyhona') @> array['versal', 'grand', 'test-a1'],
  'опечатка через словарь: «toyhona» → все тойханы');
select is(pg_temp.found('Версаль'), array['versal'], 'кириллицей: «Версаль» → Versal');
select is(pg_temp.found('versal chilonzor'), array['versal'], 'нужны все слова: название и район');
select is(pg_temp.found('Яккасарай'), '{}'::text[], 'в районе никого — пусто');
select is(pg_temp.found('test hall'), array['test-a1', 'test-b1'], 'два слова названия');
select ok(not 'test-a2' = any (pg_temp.found('test-a2')),
  'черновик не ищется (слово только из него пропускается — находятся опубликованные «test»)');
select ok(pg_temp.found('Тойхона') @> array['versal', 'grand', 'test-a1', 'test-b1'],
  'по названию раздела — все его витрины');
select is(pg_temp.found('banket', 'car'), '{}'::text[], 'раздел сужает поиск');
select is(pg_temp.found('banket', 'all'), pg_temp.found('banket'), 'all — все разделы');
select is(pg_temp.found('a'), '{}'::text[], 'один символ — не поиск');
select is(pg_temp.found('a b c'), '{}'::text[], 'слова короче двух символов не сравниваются');
select is(pg_temp.found(''), '{}'::text[], 'пустой запрос — пусто');

-- Оценка: начало названия целиком — выше всего; оплаты в оценке нет (её и нет в документе)
select ok(
  (select s.score from app.catalog_search('chilonzor palace') s
   where s.listing_id = 'bbbbbbbb-0000-0000-0000-000000000102') > 4,
  'название начинается с запроса — сверху');

-- Совпадение — по индексу триграмм
create function pg_temp.plan_of(p_query text)
returns text
language plpgsql
as $$
declare
  line text;
  result text := '';
begin
  for line in execute 'explain ' || p_query loop
    result := result || line || E'\n';
  end loop;
  return result;
end $$;
set local enable_seqscan = off;
select matches(
  pg_temp.plan_of($$select s.listing_id from app.listing_search s
                    where s.body operator(extensions.%>) 'versal' or s.body operator(extensions.%>>) 'versal'$$),
  'listing_search_body',
  'совпадение ищется по индексу listing_search_body');
reset enable_seqscan;

-- Под ролью API — только функцией
set local role bayramm_api;
select pg_temp.as_actor(null);
select throws_ok($$select * from app.listing_search$$, '42501', null, 'гость документы напрямую не читает');
select ok(array_length(pg_temp.found('chilonzor'), 1) = 4, 'гость ищет функцией');
reset role;

select * from finish();
rollback;
