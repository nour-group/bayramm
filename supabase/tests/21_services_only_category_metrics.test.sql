-- После перехода на услуги: пакетов залов v0.1 нет, цена «от» и готовность — из услуг,
-- правка карточки без ключей цены; метрики по категориям; каталог — политика фото без
-- функций на каждой строке и загрузка на дату одним запросом (app.catalog_day_load)
begin;
\ir _fixtures.psql
select plan(39);

-- ════════════════════════════════════════════════════════════════════════════
-- Пакетов v0.1 нет
-- ════════════════════════════════════════════════════════════════════════════
select hasnt_table('app', 'listing_packages', 'таблицы пакетов v0.1 нет');
select hasnt_type('app', 'package_kind', 'и типа их вида');
select hasnt_column('app', 'listing_services', 'package_id', 'услуга не помнит пакет');
select hasnt_function('app', 'listing_packages_sync', 'зеркала пакетов в услуги нет');
select hasnt_function('app', 'listing_packages_guard', 'защиты пакетов нет');
select hasnt_function('app', 'listing_packages_keep_ready', 'и проверки готовности по пакетам');
select ok(not has_column_privilege('bayramm_api', 'app.listings', 'price_from_uzs', 'UPDATE')
          and not has_column_privilege('bayramm_api', 'app.listings', 'price_unit', 'UPDATE'),
  'цену «от» роль API не пишет — её считает база из услуг');

-- ── цена «от» и готовность — из услуг ───────────────────────────────────────
select is((select price_from_uzs from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  150000::bigint, 'цена «от» — самая низкая из банкетов');
update app.listing_services set price_uzs = 140000
 where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and service_type = 'banquet_weekday';
select is((select price_from_uzs from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  140000::bigint, 'и меняется вместе с ними');
select throws_ok(
  $$delete from app.listing_services
     where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and service_type = 'banquet_weekend'$$,
  'BR004', 'publish_blocked', 'у опубликованного зала обязательные услуги не убрать');
select is(
  app.listing_publish_blockers(
    (select l from app.listings l where l.id = 'aaaaaaaa-0000-0000-0000-000000000102'), 'review'),
  array['price', 'capacity', 'district', 'descriptions', 'phone', 'packages', 'photos'],
  'черновик без услуг: нет цены и обязательных услуг категории');

-- ── правка карточки — без ключей цены ───────────────────────────────────────
select ok(app.revision_payload_ok('{"name": "Новое", "attributes": {"stage": true}, "video_links": []}'),
  'правка: название, описания, поля витрины, ссылки');
select ok(not app.revision_payload_ok('{"price_from_uzs": 160000}'), 'цены «от» в правке нет');
select ok(not app.revision_payload_ok('{"packages": []}'), 'пакетов — тоже');
select throws_ok(
  $$insert into app.listing_revisions (listing_id, payload, base_version)
    values ('aaaaaaaa-0000-0000-0000-000000000101', '{"name": "X Hall", "price_unit": "per_event"}', 1)$$,
  '23514', null, 'открытую правку с ключом цены база не примет');

-- ════════════════════════════════════════════════════════════════════════════
-- Метрики по категориям
-- ════════════════════════════════════════════════════════════════════════════
select ok(has_function_privilege('bayramm_api', 'app.metrics_categories(int)', 'EXECUTE'),
  'API: сводка по категориям');
select ok(has_function_privilege('bayramm_api', 'app.catalog_day_load(text, date)', 'EXECUTE'),
  'API: загрузка выдачи на дату');
select has_column('app', 'request_metric_facts', 'category_code', 'в фактах заявки — категория витрины');

-- Кортеж вендора B (опубликован) и черновик кортежа; заявка и договорённость — на кортеж.
-- Без триггеров: здесь важны только факты для метрик и занятости
set local session_replication_role = replica;
insert into app.listings (id, vendor_id, slug, category_code, status, name, price_from_uzs, price_unit) values
  ('bbbbbbbb-0000-0000-0000-000000000201', 'bbbbbbbb-0000-0000-0000-000000000001', 'test-b-car', 'car', 'active',
   'Test Car B', 300000, 'per_hour'),
  ('bbbbbbbb-0000-0000-0000-000000000202', 'bbbbbbbb-0000-0000-0000-000000000001', 'test-b-car-draft', 'car',
   'draft', 'Test Car Draft', null, 'per_hour');
insert into app.consents (id, subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source) values
  ('ffffffff-0000-0000-0000-0000000000c1', 'client', 'cccccccc-0000-0000-0000-000000000001', 'request_transfer',
   'grant', 'dddddddd-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000201', 'tma');
insert into app.requests (id, client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests,
                          status, source, sla_due_at, day_part) values
  ('eeeeeeee-0000-0000-0000-0000000000c1', 'cccccccc-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000201', 'bbbbbbbb-0000-0000-0000-000000000001',
   'ffffffff-0000-0000-0000-0000000000c1', 'toy', current_date + 20, null, 'new', 'tma',
   now() + interval '12 hours', 'evening'),
  ('eeeeeeee-0000-0000-0000-0000000000c2', 'cccccccc-0000-0000-0000-000000000002',
   'bbbbbbbb-0000-0000-0000-000000000201', 'bbbbbbbb-0000-0000-0000-000000000001',
   'ffffffff-0000-0000-0000-0000000000c1', 'toy', current_date + 13, null, 'deal', 'tma',
   now() + interval '12 hours', 'day');
insert into app.outbox (kind, recipient_kind, recipient_id, request_id, status, dedupe_key) values
  ('vendor.request_new', 'vendor_user', 'bbbbbbbb-0000-0000-0000-000000000011',
   'eeeeeeee-0000-0000-0000-0000000000c1', 'dead', 'test:car:dead');
set local session_replication_role = origin;

set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select results_eq(
  $$select (select requests from app.metrics_weekly(1)), (select requests from app.metrics_weekly(1, 'hall')),
           (select requests from app.metrics_weekly(1, 'car'))$$,
  $$values (4, 2, 2)$$,
  'неделя: все заявки, только залы, только кортежи');
select results_eq(
  $$select dead_notifications from app.metrics_period(now() - interval '1 day', now() + interval '1 day', 'car')
    union all
    select dead_notifications from app.metrics_period(now() - interval '1 day', now() + interval '1 day', 'hall')$$,
  $$values (1), (0)$$,
  'недоставленные уведомления — по заявкам своей категории');
select results_eq(
  $$select category_code, active_listings, active_vendors, requests, clients
      from app.metrics_categories(30) where category_code in ('hall', 'car')$$,
  $$values ('hall', 2, 2, 2, 2), ('car', 1, 1, 2, 2)$$,
  'сводка по категориям — по порядку категорий: витрины, вендоры, заявки, клиенты');
select ok((select bool_and(c.enabled or m.requests > 0)
             from app.metrics_categories(30) m join app.categories c on c.code = m.category_code)
          and (select count(*) from app.metrics_categories(30)) = (select count(*) from app.categories where enabled),
  'в сводке — включённые категории');
select throws_ok($$select * from app.metrics_categories(0)$$, '22023', null, 'дней — от 1');
select results_eq(
  $$select vendor_id::text, active_listings, requests from app.metrics_vendors(30, null, 'car')$$,
  $$values ('bbbbbbbb-0000-0000-0000-000000000001', 1, 2)$$,
  'вендоры кортежей: только с заявками или витриной в категории');
select results_eq(
  $$select categories from app.metrics_vendors(30, 'bbbbbbbb-0000-0000-0000-000000000001')$$,
  $$values (array['hall', 'car'])$$,
  'категории вендора — по порядку категорий');
select results_eq(
  $$select listing_id::text, category_code, requests
      from app.metrics_listings('bbbbbbbb-0000-0000-0000-000000000001', 30) order by 1$$,
  $$values ('bbbbbbbb-0000-0000-0000-000000000101', 'hall', 1), ('bbbbbbbb-0000-0000-0000-000000000201', 'car', 2)$$,
  'витрины вендора — с категорией; черновик без заявок не показывается');
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select throws_ok($$select * from app.metrics_categories(30)$$, 'BR003', 'forbidden_for_actor',
  'клиент сводку не видит');
reset role;

-- ════════════════════════════════════════════════════════════════════════════
-- Каталог: фото и загрузка на дату
-- ════════════════════════════════════════════════════════════════════════════
select has_index('app', 'photos', 'photos_public', 'обложка и число фото — по частичному индексу');
select has_index('app', 'requests', 'requests_deals_day', 'договорённости дня — по индексу');

insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256, sort,
                        no_faces_ack) values
  ('aaaaaaaa-0000-0000-0000-000000000101', 'ready', 'pending',
   pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000101'), 'image/webp', 1000, 1600, 1200, sha256('a1/new'), 9,
   true),
  ('aaaaaaaa-0000-0000-0000-000000000102', 'ready', 'approved',
   pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000102'), 'image/webp', 1000, 1600, 1200, sha256('a2/1'), 1,
   true);

insert into app.availability (listing_id, day, source)
values ('aaaaaaaa-0000-0000-0000-000000000101', current_date + 10, 'vendor');
insert into app.availability_parts (listing_id, day, part) values
  ('bbbbbbbb-0000-0000-0000-000000000201', current_date + 11, 'morning'),
  ('bbbbbbbb-0000-0000-0000-000000000202', current_date + 11, 'evening'),
  ('bbbbbbbb-0000-0000-0000-000000000201', current_date + 12, 'morning'),
  ('bbbbbbbb-0000-0000-0000-000000000201', current_date + 12, 'day'),
  ('bbbbbbbb-0000-0000-0000-000000000201', current_date + 12, 'evening');

select is(
  (select pg_get_expr(p.polqual, p.polrelid) ~ 'listing_is_public' from pg_policy p
    where p.polname = 'photos_read' and p.polrelid = 'app.photos'::regclass),
  false, 'политика фото не вызывает функцию на каждой строке');

set local role bayramm_api;
select pg_temp.as_actor(null);
select results_eq(
  $$select listing_id::text, count(*)::int from app.photos
     where listing_id in ('aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000102')
     group by 1$$,
  $$values ('aaaaaaaa-0000-0000-0000-000000000101', 3)$$,
  'гостю — готовые одобренные фото опубликованных витрин: без ждущих решения и черновиков');
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select results_eq(
  $$select listing_id::text, count(*)::int from app.photos
     where listing_id in ('aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000102')
     group by 1 order by 1$$,
  $$values ('aaaaaaaa-0000-0000-0000-000000000101', 4), ('aaaaaaaa-0000-0000-0000-000000000102', 1)$$,
  'партнёру — все фото своих витрин');
select pg_temp.as_actor('vendor_user', 'bbbbbbbb-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001');
select results_eq(
  $$select count(*)::int from app.photos
     where listing_id in ('aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000102')$$,
  $$values (3)$$,
  'чужому партнёру — только публичные');
select pg_temp.as_actor(null);
select results_eq(
  $$select listing_id::text, load from app.catalog_day_load('hall', current_date + 10)$$,
  $$values ('aaaaaaaa-0000-0000-0000-000000000101', 'busy')$$,
  'зал: отметка на день — занят');
select results_eq(
  $$select listing_id::text, load from app.catalog_day_load('car', current_date + 11)$$,
  $$values ('bbbbbbbb-0000-0000-0000-000000000201', 'partial')$$,
  'кортеж: занято утро — частично; черновик в выдачу не попадает');
select results_eq(
  $$select load from app.catalog_day_load('car', current_date + 12)$$,
  $$values ('busy')$$,
  'заняты все части дня — занят');
select results_eq(
  $$select load from app.catalog_day_load('car', current_date + 13)$$,
  $$values ('partial')$$,
  'договорённость на часть дня при одном заказе одновременно — часть занята');
select is_empty($$select 1 from app.catalog_day_load('car', current_date + 14)$$, 'свободные — не в ответе');
select is_empty(
  $$select l.id, d.day
      from app.listings l, generate_series(current_date + 10, current_date + 14, interval '1 day') d(day)
     where l.status = 'active' and l.category_code in ('hall', 'car')
       and app.listing_day_load(l.id, d.day::date) is distinct from
           coalesce((select x.load from app.catalog_day_load(l.category_code, d.day::date) x where x.listing_id = l.id),
                    'free')$$,
  'то же, что app.listing_day_load у каждой витрины');
reset role;

select * from finish();
rollback;
