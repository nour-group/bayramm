-- Партнёр настраивает витрину сам (20261012090000_vendor_listing_facts.sql): пока витрины
-- нет на сайте — вместимость, район, адрес, название, описания, поля витрины и видео
-- сохраняются сразу; после отправки на проверку — только предложением. Адрес страницы партнёр
-- не меняет. Правка партнёра, сохранённая сразу, — запись в журнале (только имена полей).
-- Предложение не «устаревает» от правок, которые его не касаются.
begin;
\ir _fixtures.psql
select plan(46);

-- Модератор …a003 и сотрудник площадки (member) вендора A
insert into app.staff (id, role) values ('00000000-0000-0000-0000-00000000a003', 'moderator');
insert into pii.staff_profiles (staff_id, display_name) values ('00000000-0000-0000-0000-00000000a003', 'Moderator');
insert into app.vendor_users (id, vendor_id, role, phone_hash) values
  ('aaaaaaaa-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', 'member', sha256('vendor-a-member'));

-- ── допустимые ключи предложения ────────────────────────────────────────────
select ok(app.revision_payload_ok('{"cap_max": 350}'), 'вместимость — ключ предложения');
select ok(app.revision_payload_ok('{"cap_min": 80, "cap_max": 350, "district_code": "sergeli", "address_ru": "ул. Навои, 1", "address_uz": "Navoiy k., 1"}'),
  'район и адрес — тоже');
select ok(app.revision_payload_ok('{"name": "Х", "attributes": {"parking": true}, "video_links": []}'),
  'прежние ключи по-прежнему принимаются');
select ok(not app.revision_payload_ok('{"foo": 1}'), 'неизвестный ключ — нет');
select ok(not app.revision_payload_ok('{"slug": "x"}'), 'адрес страницы правкой не предлагается');
select ok(not app.revision_payload_ok('{"price_from_uzs": 1}'), 'цены в предложении нет — они в услугах');
select ok(not app.revision_payload_ok('{}'), 'пустое предложение — нет');

-- ════════════════════════════════════════════════════════════════════════════
-- Витрины нет на сайте: партнёр меняет всё сам (A2 — черновик)
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');

select lives_ok(
  $$update app.listings set cap_min = 80, cap_max = 300 where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  'черновик: вместимость — сразу');
select lives_ok(
  $$update app.listings set district_code = 'sergeli', address_ru = 'ул. Навои, 1', address_uz = 'Navoiy k., 1'
    where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  'черновик: район и адрес — сразу');
select lives_ok(
  $$update app.listings set name = 'Зал Лола', description_ru = 'Описание зала', description_uz = 'Zal tavsifi',
                            attributes = '{"parking": true}'::jsonb
    where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  'черновик: название, описания и поля витрины — сразу');
select throws_ok(
  $$update app.listings set cap_min = 400 where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  '23514', null, 'вместимость «до» не меньше «от» (ограничение таблицы)');
select throws_ok(
  $$update app.listings set slug = 'moy-zal' where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  'BR006', 'immutable_column', 'адрес страницы партнёр не меняет — даже у черновика');
select throws_ok(
  $$update app.listings set slug = 'moy-zal' where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR006', 'immutable_column', 'и у опубликованной');

-- отклонённая — тоже не на сайте
reset role;
select pg_temp.as_actor('system');
update app.listings set status = 'rejected', status_reason = 'нужны фото' where id = 'aaaaaaaa-0000-0000-0000-000000000102';
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select lives_ok(
  $$update app.listings set cap_max = 320, address_ru = 'ул. Навои, 2' where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  'отклонённая: вместимость и адрес — сразу');

-- ════════════════════════════════════════════════════════════════════════════
-- Витрина на сайте: те же поля — только предложением (A1 — опубликована)
-- ════════════════════════════════════════════════════════════════════════════
select throws_ok(
  $$update app.listings set cap_max = 350 where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR005', 'moderated_field_requires_revision', 'опубликованная: вместимость «до» — предложением');
select throws_ok(
  $$update app.listings set cap_min = 60 where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR005', 'moderated_field_requires_revision', 'вместимость «от» — тоже');
select throws_ok(
  $$update app.listings set district_code = 'sergeli' where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR005', 'moderated_field_requires_revision', 'район — предложением');
select throws_ok(
  $$update app.listings set address_uz = 'Navoiy k., 1' where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR005', 'moderated_field_requires_revision', 'адрес — предложением');
select throws_ok(
  $$update app.listings set attributes = '{"parking": false}'::jsonb where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR005', 'moderated_field_requires_revision', 'поля витрины — предложением, как и раньше');
select lives_ok(
  $$update app.listings set parallel_capacity = 2 where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  '«заказов одновременно» — календарь, сразу');

reset role;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
set local role bayramm_api;
select lives_ok(
  $$update app.listings set status = 'suspended', status_reason = 'ремонт' where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'администратор приостанавливает витрину');
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$update app.listings set cap_max = 350 where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR005', 'moderated_field_requires_revision', 'приостановленная: тоже предложением');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select lives_ok(
  $$update app.listings set status = 'active' where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'администратор возвращает витрину на сайт');

-- Сотрудник площадки (member): витрину не меняет совсем (политика строк — только владелец)
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001');
select is_empty(
  $$update app.listings set cap_max = 330 where id = 'aaaaaaaa-0000-0000-0000-000000000102' returning id$$,
  'сотрудник площадки вместимость не меняет: строка ему недоступна');

-- Сотрудник площадки по-прежнему не предлагает правок
select throws_ok(
  $$insert into app.listing_revisions (listing_id, payload, base_version)
    values ('aaaaaaaa-0000-0000-0000-000000000101', '{"cap_max": 330}', 1)$$,
  '42501', null, 'и предложение подаёт только владелец');

-- ════════════════════════════════════════════════════════════════════════════
-- Журнал: правка партнёра, сохранённая сразу, — только имена полей
-- ════════════════════════════════════════════════════════════════════════════
reset role;
select is(
  (select detail -> 'fields' from app.audit_log
    where action = 'listing.vendor_update' and object_id = 'aaaaaaaa-0000-0000-0000-000000000102'
    order by id limit 1),
  '["cap_max", "cap_min"]'::jsonb,
  'listing.vendor_update: вместимость, поля — по алфавиту');
select is(
  (select count(*)::int from app.audit_log
    where action = 'listing.vendor_update' and object_id = 'aaaaaaaa-0000-0000-0000-000000000102'),
  4, 'по записи на каждое сохранение (4 успешных), ошибочные не пишутся');
select is(
  (select count(*)::int from app.audit_log
    where action = 'listing.vendor_update' and detail::text ~ '(Навои|Navoiy|Зал Лола|Описание зала|sergeli)'),
  0, 'значения полей в журнал не попадают');
select is(
  (select count(*)::int from app.audit_log
    where action = 'listing.vendor_update' and object_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  0, 'не-факты (заказов одновременно) партнёрской записи не дают');
select is(
  (select source::text from app.audit_log where action = 'listing.vendor_update' order by id limit 1),
  'vendor_cabinet', 'источник — кабинет');

-- ════════════════════════════════════════════════════════════════════════════
-- Предложение: вместимость и адрес применяются при одобрении; версия основы
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
set local role bayramm_api;
select lives_ok(
  $$insert into app.listing_revisions (listing_id, payload, base_version)
    select id, '{"cap_min": 100, "cap_max": 350, "address_ru": "ул. Навои, 5"}', version
    from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'владелец подаёт предложение с вместимостью и адресом');


-- Правка, которой предложение не касается, версию основы подтягивает
select lives_ok(
  $$update app.listings set parallel_capacity = 3 where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'партнёр отметил «заказов одновременно»');
reset role;
select is(
  (select r.base_version = l.version from app.listing_revisions r join app.listings l on l.id = r.listing_id
    where r.listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and r.status = 'pending'),
  true, 'предложение не «устарело» от того, что к нему не относится');

select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
set local role bayramm_api;
select lives_ok(
  $$update app.listings set district_code = 'chilonzor' where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'администратор поменял район — предложение его не меняет');
reset role;
select is(
  (select r.base_version = l.version from app.listing_revisions r join app.listings l on l.id = r.listing_id
    where r.listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and r.status = 'pending'),
  true, 'и от этого не устарело');
select is(
  (select count(*)::int from app.audit_log
    where action = 'listing_revision.update' and object_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  0, 'подтягивание версии в журнал «решений по предложению» не попадает');

set local role bayramm_api;
select lives_ok(
  $$update app.listings set cap_max = 320 where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'администратор поменял вместимость — её меняет и предложение');
reset role;
select is(
  (select r.base_version = l.version from app.listing_revisions r join app.listings l on l.id = r.listing_id
    where r.listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and r.status = 'pending'),
  false, 'после этого предложение устарело: сравнивать «сейчас» и «предлагают» должен человек');

-- Устаревшее не «оживает» от правки, которой оно не касается
set local role bayramm_api;
update app.listings set parallel_capacity = 4 where id = 'aaaaaaaa-0000-0000-0000-000000000101';
reset role;
select is(
  (select r.base_version = l.version from app.listing_revisions r join app.listings l on l.id = r.listing_id
    where r.listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and r.status = 'pending'),
  false, 'устаревшее предложение остаётся устаревшим');

-- ── одобрение: вместимость и адрес применяются, «до» не меньше «от» ─────────
set local role bayramm_api;
select throws_ok(
  $$update app.listings set cap_min = 500, cap_max = 350 where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  '23514', null, 'одобрение, после которого «до» меньше «от», база не пропустит');
select lives_ok(
  $$update app.listings set cap_min = 100, cap_max = 350, address_ru = 'ул. Навои, 5'
    where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'применить предложение к витрине');
select lives_ok(
  $$update app.listing_revisions set status = 'approved' where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'и одобрить');
reset role;
select is(
  (select array[cap_min, cap_max]::text from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  '{100,350}', 'вместимость применена');
select is(
  (select count(*)::int from app.audit_log
    where action = 'listing_revision.update' and object_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  1, 'решение по предложению — запись в журнале сотрудников, как и раньше');

-- Снятая с публикации витрина: партнёр правит предложением, а отозвать его по-прежнему может
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
set local role bayramm_api;
select lives_ok(
  $$insert into app.listing_revisions (listing_id, payload, base_version)
    select id, '{"district_code": "sergeli"}', version from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'новое предложение — район');
select lives_ok(
  $$update app.listing_revisions set status = 'withdrawn' where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and status = 'pending'$$,
  'партнёр его отзывает');

select * from finish();
rollback;
