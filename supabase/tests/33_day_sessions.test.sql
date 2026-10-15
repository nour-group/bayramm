-- Несколько мероприятий в день (20261015100000_day_sessions.sql): время работы витрины, части дня
-- заявки, занятость по частям — одни правила у app.listing_busy, app.listing_day_load и
-- app.catalog_day_load, поводы с частями по умолчанию
begin;
\ir _fixtures.psql
select plan(58);

-- ════════════════════════════════════════════════════════════════════════════
-- Схема и значения по умолчанию
-- ════════════════════════════════════════════════════════════════════════════
select results_eq(
  $$select part_mode::text, day_parts::text, part_windows is null from app.listings
     where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  $$values ('parts', '{morning,day,evening}', true)$$,
  'по умолчанию — несколько мероприятий в день, все три части, окна категории');
select hasnt_column('app', 'requests', 'day_part', 'одной части дня у заявки больше нет');
select col_not_null('app', 'requests', 'day_parts', 'части дня заявки — всегда массив');
select is((select day_parts from app.requests where id = 'eeeeeeee-0000-0000-0000-0000000000a1'),
  '{}'::app.day_part[], 'заявка без частей — на весь день');
select results_eq(
  $$select code, default_parts::text from app.occasions where code in ('toy', 'nahorgi_osh', 'nikoh') order by sort$$,
  $$values ('toy', '{evening}'), ('nahorgi_osh', '{morning}'), ('nikoh', '{day}')$$,
  'повод задаёт части дня по умолчанию; порядок — свадьба, нахорги ош, никах');
select is((select count(*)::int from app.categories where availability_mode in ('day', 'slot')), 0,
  'режимы day и slot больше не используются: у зала, студии и ЗАГС — части дня');
select has_index('app', 'requests', 'requests_deals_day', 'договорённости дня — по индексу, без прежнего столбца');

-- Перенос прежней части: то же выражение, что в миграции, на временном столбце
alter table app.requests add column day_part app.day_part;
alter table app.requests disable trigger user;
update app.requests set day_part = 'evening', day_parts = '{}' where id = 'eeeeeeee-0000-0000-0000-0000000000b1';
update app.requests set day_parts = array[day_part] where day_part is not null;
alter table app.requests enable trigger user;
select results_eq(
  $$select id::text, day_parts::text from app.requests
     where id in ('eeeeeeee-0000-0000-0000-0000000000a1', 'eeeeeeee-0000-0000-0000-0000000000b1') order by 1$$,
  $$values ('eeeeeeee-0000-0000-0000-0000000000a1', '{}'), ('eeeeeeee-0000-0000-0000-0000000000b1', '{evening}')$$,
  'перенос: часть — массивом из неё одной, без части — весь день');
alter table app.requests drop column day_part;
alter table app.requests disable trigger user;
update app.requests set day_parts = '{}' where id = 'eeeeeeee-0000-0000-0000-0000000000b1';
alter table app.requests enable trigger user;

-- ════════════════════════════════════════════════════════════════════════════
-- Проверки столбцов витрины
-- ════════════════════════════════════════════════════════════════════════════
select throws_ok($$update app.listings set day_parts = '{}' where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  '23514', null, 'рабочих частей — хотя бы одна');
select throws_ok(
  $$update app.listings set day_parts = '{morning,morning}' where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  '23514', null, 'рабочие части — без повторов');
select throws_ok(
  $$update app.listings set part_windows = '{"morning": {"from": "11:00", "to": "06:00"}}'
     where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  '23514', null, 'окно: начало раньше конца');
select throws_ok(
  $$update app.listings set part_windows = '{"evening": {"from": "18:00", "to": "24:30"}}'
     where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  '23514', null, 'окно: в пределах суток');
select throws_ok(
  $$update app.listings set part_windows = '{"morning": {"from": "6:00", "to": "11:00"}}'
     where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  '23514', null, 'окно: «ЧЧ:ММ»');
select throws_ok(
  $$update app.listings set part_windows = '{"morning": {"from": "06:00", "to": "13:00"}, "day": {"from": "12:00", "to": "17:00"}}'
     where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  '23514', null, 'окна по порядку и без пересечений');
select throws_ok(
  $$update app.listings set part_windows = '{"night": {"from": "00:00", "to": "05:00"}}'
     where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  '23514', null, 'окна — только у утра, дня и вечера');
select lives_ok(
  $$update app.listings set part_windows = '{"morning": {"from": "06:00", "to": "10:30"}, "evening": {"from": "18:00", "to": "24:00"}}'
     where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'свои окна витрины; конец вечера — 24:00');
update app.listings set part_windows = null where id = 'aaaaaaaa-0000-0000-0000-000000000101';

-- ════════════════════════════════════════════════════════════════════════════
-- Время работы: app.listing_set_day_sessions
-- ════════════════════════════════════════════════════════════════════════════
insert into app.vendor_users (id, vendor_id, phone_hash, role) values
  ('aaaaaaaa-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', sha256('vendor-a-member'), 'member');
-- будущая заявка на вечер и прошедшая — на день (C2 → A1)
insert into app.consents (id, subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source) values
  ('ffffffff-0000-0000-0000-0000000033a2', 'client', 'cccccccc-0000-0000-0000-000000000002', 'request_transfer',
   'grant', 'dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101', 'tma');
set local session_replication_role = replica;
insert into app.requests (id, client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests,
                          status, decline_reason, source, sla_due_at, day_parts) values
  ('eeeeeeee-0000-0000-0000-0000000033a1', 'cccccccc-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001',
   'ffffffff-0000-0000-0000-0000000033a2', 'toy', current_date + 40, 100, 'viewed', null, 'tma',
   now() + interval '12 hours', '{evening}'),
  ('eeeeeeee-0000-0000-0000-0000000033a2', 'cccccccc-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001',
   'ffffffff-0000-0000-0000-0000000033a2', 'toy', current_date - 3, 100, 'deal', null, 'tma',
   now() - interval '5 days', '{day}'),
  ('eeeeeeee-0000-0000-0000-0000000033a3', 'cccccccc-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001',
   'ffffffff-0000-0000-0000-0000000033a2', 'toy', current_date + 41, 100, 'declined', 'other', 'tma',
   now() + interval '12 hours', '{day}');
set local session_replication_role = origin;
-- версия календаря — с нуля (правки окон выше её подняли)
delete from app.availability_versions where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101';

set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select is(
  app.listing_set_day_sessions('aaaaaaaa-0000-0000-0000-000000000101', 'parts', '{evening,morning}', null, 2, 0),
  1, 'владелец меняет время работы от версии календаря; версия растёт');
select results_eq(
  $$select part_mode::text, day_parts::text, parallel_capacity from app.listings
     where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  $$values ('parts', '{morning,evening}', 2::smallint)$$,
  'части — по порядку; заказов одновременно — там же; прошедшая и отклонённая заявки на день не мешают');
select throws_ok(
  $$select app.listing_set_day_sessions('aaaaaaaa-0000-0000-0000-000000000101', 'parts', '{morning,evening}', null, 2, 0)$$,
  'BR025', 'calendar_conflict', 'устаревшая версия календаря — конфликт');
select throws_ok(
  $$select app.listing_set_day_sessions('aaaaaaaa-0000-0000-0000-000000000101', 'parts', '{morning}', null, 2, 1)$$,
  'BR039', 'part_in_use', 'часть с будущей заявкой не убрать');
select is(
  pg_temp.error_detail($$select app.listing_set_day_sessions('aaaaaaaa-0000-0000-0000-000000000101', 'parts', '{morning}', null, 2, 1)$$),
  'evening:1', 'в DETAIL — часть и сколько на неё заявок');
select throws_ok(
  $$select app.listing_set_day_sessions('aaaaaaaa-0000-0000-0000-000000000101', 'parts', '{morning,evening}',
      '{"morning": {"from": "10:00", "to": "09:00"}}', 2, 1)$$,
  '22023', null, 'окна проверяет база');
select throws_ok(
  $$select app.listing_set_day_sessions('aaaaaaaa-0000-0000-0000-000000000101', 'parts', '{}', null, 2, 1)$$,
  '22023', null, 'без рабочих частей — нельзя');
select throws_ok(
  $$select app.listing_set_day_sessions('aaaaaaaa-0000-0000-0000-000000000101', 'parts', '{morning,evening}', null, 51, 1)$$,
  '22023', null, 'заказов одновременно — 1–50');
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$select app.listing_set_day_sessions('aaaaaaaa-0000-0000-0000-000000000101', 'whole', '{morning,evening}', null, 2, 1)$$,
  'BR003', 'forbidden_for_actor', 'сотрудник площадки календарь ведёт, а время работы не меняет');
select pg_temp.as_actor('vendor_user', 'bbbbbbbb-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001');
select throws_ok(
  $$select app.listing_set_day_sessions('aaaaaaaa-0000-0000-0000-000000000101', 'whole', '{morning,evening}', null, 2, 1)$$,
  '42501', null, 'чужая витрина — как несуществующая');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select is(
  app.listing_set_day_sessions('aaaaaaaa-0000-0000-0000-000000000101', 'whole', '{morning}', null, 2, 1),
  2, 'на одно мероприятие в день — всегда, даже без части с заявкой; менеджер — тоже');
select is(
  app.listing_set_day_sessions('aaaaaaaa-0000-0000-0000-000000000101', 'whole', '{morning}', null, 2, 2),
  2, 'без изменений версия не растёт');
-- назад: утро и вечер — вечер снова рабочий
select is(
  app.listing_set_day_sessions('aaaaaaaa-0000-0000-0000-000000000101', 'parts', '{morning,evening}', null, 2, 2),
  3, 'обратно — несколько мероприятий: утро и вечер');
reset role;
select is(
  (select count(*)::int from app.audit_log where action = 'listing.vendor_update'
      and object_id = 'aaaaaaaa-0000-0000-0000-000000000101' and detail -> 'fields' ? 'day_parts'),
  1, 'правка партнёра — в журнале (только имена полей)');

-- ════════════════════════════════════════════════════════════════════════════
-- Части дня заявки
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor(null);
insert into app.consents (id, subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source) values
  ('ffffffff-0000-0000-0000-0000000033b1', 'client', 'cccccccc-0000-0000-0000-000000000001', 'request_transfer',
   'grant', 'dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101', 'tma');
select throws_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source,
                              sla_due_at, day_parts)
    values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101',
            'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000033b1', 'toy',
            current_date + 50, 100, 'tma', now(), '{day}')$$,
  '23514', null, 'часть заявки — только рабочая часть витрины');
insert into app.requests (id, client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source,
                          sla_due_at, day_parts)
values ('eeeeeeee-0000-0000-0000-0000000033b1', 'cccccccc-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001',
        'ffffffff-0000-0000-0000-0000000033b1', 'nahorgi_osh', current_date + 50, 100, 'tma', now(),
        '{evening,morning}');
select is((select day_parts::text from app.requests where id = 'eeeeeeee-0000-0000-0000-0000000033b1'),
  '{morning,evening}', 'несколько частей одной заявкой — по порядку');
select throws_ok(
  $$update app.requests set day_parts = '{morning}' where id = 'eeeeeeee-0000-0000-0000-0000000033b1'$$,
  'BR006', 'immutable_column', 'части заявки после подачи не меняются');

-- отказ «занято» занимает обе части заявки
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
update app.requests set status = 'declined', decline_reason = 'busy' where id = 'eeeeeeee-0000-0000-0000-0000000033b1';
select results_eq(
  $$select a.part::text as part_name, a.source from app.availability_parts a
     where a.listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and a.day = current_date + 50 order by a.part$$,
  $$values ('morning', 'request_decline'), ('evening', 'request_decline')$$,
  'отказ «занято» — отметки всех частей заявки');
select results_eq(
  $$select parts from app.listing_busy('aaaaaaaa-0000-0000-0000-000000000101', current_date + 50, current_date + 51)$$,
  $$values (array['all'])$$,
  'заняты все рабочие части — день занят');
update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000033b1';
select is_empty(
  $$select 1 from app.availability_parts where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'
     and day = current_date + 50$$,
  '«вернуть в активные» снимает отметки отказа');

-- у одного мероприятия в день частей у заявки нет; у категорий без календаря — тоже
select pg_temp.as_actor(null);
set local session_replication_role = replica;
insert into app.listings (id, vendor_id, slug, category_code, status, name, price_from_uzs, price_unit) values
  ('aaaaaaaa-0000-0000-0000-000000003301', 'aaaaaaaa-0000-0000-0000-000000000001', 'test-a-cake', 'cake', 'active',
   'Test Cake', 100000, 'per_kg');
set local session_replication_role = origin;
insert into app.consents (id, subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source) values
  ('ffffffff-0000-0000-0000-0000000033c1', 'client', 'cccccccc-0000-0000-0000-000000000001', 'request_transfer',
   'grant', 'dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000003301', 'tma');
select throws_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, source,
                              sla_due_at, day_parts)
    values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000003301',
            'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000033c1', 'toy',
            current_date + 50, 'tma', now(), '{morning}')$$,
  '23514', null, 'у категории без календаря частей у заявки нет');
select throws_ok(
  $$insert into app.availability_parts (listing_id, day, part)
    values ('aaaaaaaa-0000-0000-0000-000000003301', current_date + 10, 'morning')$$,
  '23514', null, 'отметки частей — только у категорий с календарём');

-- ════════════════════════════════════════════════════════════════════════════
-- Занятость: отметки, договорённости и места — по рабочим частям (утро и вечер, 2 места)
-- ════════════════════════════════════════════════════════════════════════════
-- Договорённости C1 и C2 по дням (без триггеров: важны только факты занятости)
set local session_replication_role = replica;
insert into app.requests (id, client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests,
                          status, source, sla_due_at, day_parts)
select gen_random_uuid(), c.client, 'aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001',
       'ffffffff-0000-0000-0000-0000000033b1', 'toy', current_date + d.offset_days, 100, 'deal', 'tma', now(), d.parts
from (values
  -- +30: одна договорённость на утро при двух местах — свободно
  (30, 1, '{morning}'::app.day_part[]),
  -- +31: две на утро — утро занято
  (31, 1, '{morning}'), (31, 2, '{morning}'),
  -- +32: две на утро и вечер отмечен — день занят
  (32, 1, '{morning}'), (32, 2, '{morning}'),
  -- +33: две на весь день — заняты все части
  (33, 1, '{}'), (33, 2, '{}'),
  -- +36: две на день — витрина днём не работает: не в счёт
  (36, 1, '{day}'), (36, 2, '{day}')
) as d(offset_days, n, parts)
cross join lateral (select case d.n when 1 then 'cccccccc-0000-0000-0000-000000000001'::uuid
                                    else 'cccccccc-0000-0000-0000-000000000002'::uuid end as client) c;
set local session_replication_role = origin;
insert into app.availability_parts (listing_id, day, part) values
  ('aaaaaaaa-0000-0000-0000-000000000101', current_date + 32, 'evening'),
  -- +34: отмечен день — витрина днём не работает: свободно
  ('aaaaaaaa-0000-0000-0000-000000000101', current_date + 34, 'day');
insert into app.availability (listing_id, day) values ('aaaaaaaa-0000-0000-0000-000000000101', current_date + 35);

set local role bayramm_api;
select pg_temp.as_actor(null);
select results_eq(
  $$select day - current_date, parts from app.listing_busy('aaaaaaaa-0000-0000-0000-000000000101',
      current_date + 30, current_date + 37)$$,
  $$values (31, array['morning']), (32, array['all']), (33, array['all']), (35, array['all'])$$,
  'занятость витрины: места, отметки частей и дня, заявки на весь день; нерабочая часть — не в счёт');
select results_eq(
  $$select app.listing_day_load('aaaaaaaa-0000-0000-0000-000000000101', current_date + d)
      from generate_series(30, 36) d$$,
  $$values ('free'), ('partial'), ('busy'), ('busy'), ('free'), ('busy'), ('free')$$,
  'загрузка по дням: free · partial · busy');
select results_eq(
  $$select listing_id::text, load, parts::text from app.catalog_day_load('hall', current_date + 31)
     where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  $$values ('aaaaaaaa-0000-0000-0000-000000000101', 'partial', '{morning}')$$,
  'выдача: частично занята и какие рабочие части заняты (фильтр «Время»)');
select results_eq(
  $$select load, parts::text from app.catalog_day_load('hall', current_date + 32)
     where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  $$values ('busy', '{morning,evening}')$$,
  'занята целиком — все рабочие части');
select is_empty(
  $$select 1 from app.catalog_day_load('hall', current_date + 34)
     where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'занятая нерабочая часть — свободна, в ответе нет');
reset role;

-- те же правила у витрины и у выдачи (по каждому дню)
create function pg_temp.loads_agree() returns boolean
language sql
as $$
  select not exists (
    select 1
    from app.listings l, generate_series(current_date + 29, current_date + 37, interval '1 day') g(day)
    where l.status = 'active' and l.category_code = 'hall'
      and app.listing_day_load(l.id, g.day::date) is distinct from
          coalesce((select x.load from app.catalog_day_load('hall', g.day::date) x where x.listing_id = l.id), 'free')
       or (select b.parts from app.listing_busy(l.id, g.day::date, g.day::date + 1) b) is distinct from
          (select case when x.load = 'busy' then array['all']::text[] else x.parts::text[] end
             from app.catalog_day_load('hall', g.day::date) x where x.listing_id = l.id))
$$;
set local role bayramm_api;
select pg_temp.as_actor(null);
select ok(pg_temp.loads_agree(), 'листинг и выдача — одни правила (несколько мероприятий)');
reset role;

-- одно мероприятие в день: договорённость — весь день (в каждой части), любая отметка — весь день
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select is(
  app.listing_set_day_sessions('aaaaaaaa-0000-0000-0000-000000000101', 'whole', '{morning,evening}', null, 2,
    (select version from app.availability_versions where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101')),
  (select version + 1 from app.availability_versions where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  'на одно мероприятие в день');
set local role bayramm_api;
select pg_temp.as_actor(null);
select results_eq(
  $$select app.listing_day_load('aaaaaaaa-0000-0000-0000-000000000101', current_date + d)
      from generate_series(30, 36) d$$,
  $$values ('free'), ('busy'), ('busy'), ('busy'), ('busy'), ('busy'), ('busy')$$,
  'whole: одна договорённость при двух местах — свободно; две — занято; отметка любой части — весь день');
select ok(pg_temp.loads_agree(), 'листинг и выдача — одни правила (одно мероприятие)');
reset role;

-- одно место: одна договорённость на утро у whole занимает весь день
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select lives_ok(
  $$select app.listing_set_day_sessions('aaaaaaaa-0000-0000-0000-000000000101', 'whole', '{morning,evening}', null, 1,
      (select version from app.availability_versions where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'))$$,
  'одно место');
set local role bayramm_api;
select pg_temp.as_actor(null);
select is(app.listing_day_load('aaaaaaaa-0000-0000-0000-000000000101', current_date + 30), 'busy',
  'whole с одним местом: договорённость на утро — весь день');
reset role;

-- несколько мероприятий, одно место: договорённость на утро — утро
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select lives_ok(
  $$select app.listing_set_day_sessions('aaaaaaaa-0000-0000-0000-000000000101', 'parts', '{morning,day,evening}', null, 1,
      (select version from app.availability_versions where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'))$$,
  'все три части, одно место');
set local role bayramm_api;
select pg_temp.as_actor(null);
select results_eq(
  $$select parts from app.listing_busy('aaaaaaaa-0000-0000-0000-000000000101', current_date + 30, current_date + 31)$$,
  $$values (array['morning'])$$,
  'parts с одним местом: договорённость на утро — только утро');
select results_eq(
  $$select parts from app.listing_busy('aaaaaaaa-0000-0000-0000-000000000101', current_date + 36, current_date + 37)$$,
  $$values (array['day'])$$,
  'день снова рабочий — договорённости на день в счёт');
select ok(pg_temp.loads_agree(), 'листинг и выдача — одни правила (одно место)');
select is_empty(
  $$select * from app.listing_busy('aaaaaaaa-0000-0000-0000-000000000102', current_date, current_date + 30)$$,
  'занятость черновика — только владельцу и сотрудникам');
reset role;

-- ── права ───────────────────────────────────────────────────────────────────
select ok(has_function_privilege('bayramm_api',
  'app.listing_set_day_sessions(uuid, app.part_mode, app.day_part[], jsonb, int, int)', 'EXECUTE'),
  'API меняет время работы функцией');
select ok(has_function_privilege('bayramm_api', 'app.catalog_day_load(text, date)', 'EXECUTE'),
  'API читает загрузку выдачи');
select ok(not has_function_privilege('bayramm_api', 'app.listing_load_days(uuid[], date, date)', 'EXECUTE'),
  'общие правила занятости — только внутри функций с проверкой прав');
select ok(not has_column_privilege('bayramm_api', 'app.listings', 'day_parts', 'UPDATE'),
  'время работы — только функцией (с версией календаря и проверкой заявок)');

select * from finish();
rollback;
