-- Листинги: защита публикации, переходы статусов, модерация, фото
begin;
\ir _fixtures.psql
select plan(31);

-- ── защита публикации (A2 — пустой черновик вендора A) ──────────────────────
select throws_ok(
  $$update app.listings set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  'BR004', 'publish_blocked', 'черновик без цены и фото не уходит на проверку');
select is(
  pg_temp.error_detail($$update app.listings set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$),
  'price,capacity,district,descriptions,phone,packages,photos',
  'блокеры перечислены кодами');

-- всё, кроме цены, и три фото
update app.listings
   set district_code = 'sergeli', description_ru = 'Описание', description_uz = 'Tavsif', cap_min = 20, cap_max = 120
 where id = 'aaaaaaaa-0000-0000-0000-000000000102';
insert into pii.listing_contacts (listing_id, public_phone) values ('aaaaaaaa-0000-0000-0000-000000000102', '+998000000998');
insert into app.listing_packages (listing_id, kind, name_ru, name_uz, price_uzs) values
  ('aaaaaaaa-0000-0000-0000-000000000102', 'weekday', 'Будни', 'Ish kuni', 90000),
  ('aaaaaaaa-0000-0000-0000-000000000102', 'weekend', 'Выходные', 'Dam olish', 110000);
insert into app.photos (id, listing_id, status, storage_key, public_prefix, no_faces_ack)
select ('aaaaaaaa-0000-0000-0000-00000000f00' || n)::uuid, 'aaaaaaaa-0000-0000-0000-000000000102',
       'ready', 'test/a2/' || n, 'p/a2/' || n, true
from generate_series(1, 3) n;

select is(
  pg_temp.error_detail($$update app.listings set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$),
  'price', 'без цены — не на проверку');
select throws_ok(
  $$update app.listings set cap_max = 10 where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  '23514', null, 'cap_max не меньше cap_min');

-- цена есть, но фото только два
update app.photos set deleted_at = now() where id = 'aaaaaaaa-0000-0000-0000-00000000f003';
select is(
  pg_temp.error_detail($$update app.listings set status = 'review', price_from_uzs = 90000
                          where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$),
  'photos', 'с двумя фото — не на проверку');

-- три обработанных фото: на проверку можно, в каталог — нет, пока фото не одобрены
insert into app.photos (listing_id, status, storage_key, public_prefix, no_faces_ack)
values ('aaaaaaaa-0000-0000-0000-000000000102', 'ready', 'test/a2/4', 'p/a2/4', true);
select lives_ok(
  $$update app.listings set status = 'review', price_from_uzs = 90000 where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  'цена и 3 фото — можно на проверку');
select is(
  pg_temp.error_detail($$update app.listings set status = 'active' where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$),
  'photos', 'в каталог — только с 3 одобренными фото');
update app.photos set moderation = 'approved'
 where listing_id = 'aaaaaaaa-0000-0000-0000-000000000102' and deleted_at is null;
select lives_ok(
  $$update app.listings set status = 'active' where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  'все условия выполнены — листинг опубликован');
select isnt(
  (select published_at from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000102'), null,
  'published_at проставлен');

-- ── опубликованный листинг не теряет обязательное ───────────────────────────
select throws_ok(
  $$update app.photos set deleted_at = now()
     where id = (select id from app.photos where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' limit 1)$$,
  'BR004', 'publish_blocked', 'нельзя удалить фото, если их станет меньше 3');
select throws_ok(
  $$update app.listings set price_from_uzs = null where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR004', 'publish_blocked', 'у опубликованного листинга нельзя убрать цену');
select throws_ok(
  $$delete from app.listing_packages where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and kind = 'weekend'$$,
  'BR004', 'publish_blocked', 'у опубликованного зала нельзя убрать цену выходных');
select throws_ok(
  $$delete from pii.listing_contacts where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR004', 'publish_blocked', 'у опубликованного листинга нельзя убрать телефон');
select throws_ok(
  $$update app.vendor_accounts set contract_signed_at = null where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  'BR012', 'checklist_locked', 'отметку проверки не снять, пока листинги опубликованы');
select lives_ok(
  $$update app.photos set sort = 10
     where id = (select id from app.photos where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' limit 1)$$,
  'переставлять фото можно');

-- ── переходы статусов ───────────────────────────────────────────────────────
select throws_ok(
  $$insert into app.listings (vendor_id, slug, category_code, name, status)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'test-born-active', 'hall', 'Born Active', 'active')$$,
  'BR002', 'illegal_transition', 'листинг не создаётся сразу опубликованным');
select throws_ok(
  $$update app.listings set status = 'draft' where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR002', 'illegal_transition', 'active → draft запрещён');
select throws_ok(
  $$update app.listings set status = 'suspended' where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  '23514', null, 'приостановка без причины запрещена');
select lives_ok(
  $$update app.listings set status = 'suspended', status_reason = 'ремонт' where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'приостановка с причиной');
select lives_ok(
  $$update app.listings set status = 'active' where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'возврат из suspended проходит ту же проверку');
select is(
  (select status_reason from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000101'), null,
  'причина очищается при возврате');

-- ── действия вендора (роль API, актор vendor_user A) ────────────────────────
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');

select throws_ok(
  $$update app.listings set price_from_uzs = 1000 where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR005', 'moderated_field_requires_revision', 'цену опубликованного листинга вендор меняет только через ревизию');
select lives_ok(
  $$update app.listings set cap_min = 60 where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'немодерируемое поле вендор меняет сам');
select throws_ok(
  $$update app.listing_packages set price_uzs = 1000 where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR005', 'moderated_field_requires_revision', 'пакеты опубликованного листинга — через ревизию');
select lives_ok(
  $$insert into app.listing_revisions (listing_id, payload, base_version)
    values ('aaaaaaaa-0000-0000-0000-000000000101', '{"price_from_uzs": 160000}', 1)$$,
  'вендор подаёт ревизию');
select throws_ok(
  $$update app.listing_revisions set status = 'approved' where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR003', 'forbidden_for_actor', 'вендор не одобряет свою ревизию');
select lives_ok(
  $$insert into app.photos (id, listing_id, storage_key, no_faces_ack)
    values ('aaaaaaaa-0000-0000-0000-00000000f101', 'aaaaaaaa-0000-0000-0000-000000000101', 'test/a1/new', true)$$,
  'вендор загружает фото в свой листинг');
select throws_ok(
  $$update app.photos set moderation = 'approved' where id = 'aaaaaaaa-0000-0000-0000-00000000f101'$$,
  'BR003', 'forbidden_for_actor', 'вендор не одобряет свои фото');
select throws_ok(
  $$update app.listings set status = 'suspended', status_reason = 'x' where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR003', 'forbidden_for_actor', 'вендор не меняет статус опубликованного листинга');
select throws_ok(
  $$insert into app.listings (vendor_id, slug, category_code, name)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'test-foreign', 'hall', 'Foreign')$$,
  '42501', null, 'вендор не создаёт листинг от имени другого вендора');

-- лимит фото: у A1 уже 4, добавляем до 10, одиннадцатое — ошибка
reset role;
select pg_temp.as_actor(null);
insert into app.photos (listing_id, storage_key, no_faces_ack)
select 'aaaaaaaa-0000-0000-0000-000000000101', 'test/a1/extra/' || n, true from generate_series(1, 6) n;
select throws_ok(
  $$insert into app.photos (listing_id, storage_key, no_faces_ack)
    values ('aaaaaaaa-0000-0000-0000-000000000101', 'test/a1/extra/11', true)$$,
  'BR011', 'too_many_photos', 'не больше 10 фото на листинг');

select * from finish();
rollback;
