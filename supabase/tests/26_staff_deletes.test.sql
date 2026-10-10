-- Удаление в панели оператора (20261011100000_staff_deletes.sql): витрина без заявок и не
-- в каталоге — со всем, что к ней привязано, вендор — со всеми витринами и пользователями
-- кабинета, непринятое приглашение в команду. Кто может, что остаётся (журналы, аккаунты,
-- согласия), что пишется в журнал; последним администратором считается только принятый
begin;
\ir _fixtures.psql
select plan(59);

-- Модератор с аккаунтом — для проверок ролей
insert into app.staff (id, role) values ('00000000-0000-0000-0000-00000000a003', 'moderator');
insert into pii.staff_profiles (staff_id, display_name) values ('00000000-0000-0000-0000-00000000a003', 'Moderator');
insert into app.accounts (id) values ('acacacac-0000-0000-0000-00000000a003');
update app.staff set account_id = 'acacacac-0000-0000-0000-00000000a003'
where id = '00000000-0000-0000-0000-00000000a003';

-- ════════════════════════════════════════════════════════════════════════════
-- Права
-- ════════════════════════════════════════════════════════════════════════════
select ok(has_function_privilege('bayramm_api', 'app.staff_delete_listing(uuid)', 'EXECUTE')
          and has_function_privilege('bayramm_api', 'app.staff_delete_vendor(uuid)', 'EXECUTE')
          and has_function_privilege('bayramm_api', 'app.staff_revoke_invite(uuid)', 'EXECUTE'),
  'удаления — функциями базы');
select ok(has_function_privilege('bayramm_api', 'app.listing_delete_blocker(uuid)', 'EXECUTE')
          and has_function_privilege('bayramm_api', 'app.vendor_delete_blocker(uuid)', 'EXECUTE'),
  'причину «нельзя удалить» панель читает заранее');
select ok(not has_function_privilege('bayramm_api', 'app.listing_purge(uuid)', 'EXECUTE')
          and not has_function_privilege('bayramm_api', 'app.outbox_forget(uuid[])', 'EXECUTE')
          and not has_function_privilege('public', 'app.staff_delete_listing(uuid)', 'EXECUTE'),
  'служебные — не для API, ничего — для public');

-- ════════════════════════════════════════════════════════════════════════════
-- Вендор X со всем, что к нему успели привязать: X1 — зал (черновик), X2 — кортеж
-- (части дня). Контакты, услуги, фото (одно удалено из витрины), правка, занятость
-- (и прошедший день), избранное, «Связаться», оповещения, пользователь кабинета со
-- старой сессией и согласием
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_x1 uuid := 'abababab-0000-0000-0000-000000000101';
  v_x2 uuid := 'abababab-0000-0000-0000-000000000102';
begin
  perform pg_temp.as_actor(null);
  insert into app.vendor_accounts (id, name, legal_form) values ('abababab-0000-0000-0000-000000000001', 'Vendor X', 'ooo');
  insert into pii.vendor_contacts (vendor_id, legal_name, contact_person, phone)
  values ('abababab-0000-0000-0000-000000000001', 'Test X', 'Person X', '+998000000501');
  insert into app.accounts (id) values ('acacacac-0000-0000-0000-0000000000a1');
  insert into app.vendor_users (id, vendor_id, phone_hash, account_id)
  values ('abababab-0000-0000-0000-000000000011', 'abababab-0000-0000-0000-000000000001', sha256('vendor-x'),
          'acacacac-0000-0000-0000-0000000000a1');
  insert into pii.vendor_user_profiles (vendor_user_id, phone)
  values ('abababab-0000-0000-0000-000000000011', '+998000000511');
  insert into app.sessions (token_hash, account_id, vendor_user_id, via, app, expires_at, proof_at)
  values (sha256('vendor-x-session'), 'acacacac-0000-0000-0000-0000000000a1',
          'abababab-0000-0000-0000-000000000011', 'tg_partner', 'vendor', now() + interval '1 hour', now());
  insert into app.consents (subject_kind, subject_id, purpose, action, text_id, source)
  values ('vendor_user', 'abababab-0000-0000-0000-000000000011', 'vendor_contact', 'grant',
          'dddddddd-0000-0000-0000-000000000002', 'admin');

  insert into app.listings (id, vendor_id, slug, category_code, name) values
    (v_x1, 'abababab-0000-0000-0000-000000000001', 'test-x1', 'hall', 'Test Hall X1'),
    (v_x2, 'abababab-0000-0000-0000-000000000001', 'test-x2', 'car', 'Test Car X2');
  insert into pii.listing_contacts (listing_id, public_phone, public_telegram) values (v_x1, '+998000000599', 'test_x1');
  insert into app.listing_services (id, listing_id, category_code, service_type, status, price_uzs, price_unit, sort)
  values ('abababab-0000-0000-0000-0000000005e1', v_x1, 'hall', 'banquet_weekday', 'draft', 150000, 'per_guest', 1);
  insert into app.photos (id, listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256, sort,
                          no_faces_ack)
  select ('abababab-0000-0000-0000-00000000f00' || n)::uuid, v_x1, 'ready', 'pending',
         'listings/' || v_x1 || '/abababab-0000-0000-0000-00000000f00' || n || '.webp', 'image/webp', 1000, 1600, 1200,
         sha256(convert_to('x1/' || n, 'UTF8')), n, true
  from generate_series(1, 4) n;
  update app.photos set deleted_at = now() where id = 'abababab-0000-0000-0000-00000000f004';
  insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256, sort,
                          no_faces_ack)
  values (v_x2, 'ready', 'pending', 'listings/' || v_x2 || '/abababab-0000-0000-0000-00000000f201.webp', 'image/webp', 1000, 1600, 1200,
          sha256('x2/1'), 1, true);

  -- занятость: отметки сотрудника (в журнал — их создание) и прошедший день
  perform pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
  insert into app.availability (listing_id, day, source) values (v_x1, current_date + 10, 'staff');
  insert into app.availability_parts (listing_id, day, part, source) values (v_x2, current_date + 10, 'morning', 'staff');
  perform pg_temp.as_actor(null);
  alter table app.availability disable trigger availability_guard;
  insert into app.availability (listing_id, day, source) values (v_x1, current_date - 3, 'vendor');
  alter table app.availability enable trigger availability_guard;

  perform pg_temp.as_actor('vendor_user', 'abababab-0000-0000-0000-000000000011', 'abababab-0000-0000-0000-000000000001');
  insert into app.listing_revisions (id, listing_id, payload, base_version)
  select 'abababab-0000-0000-0000-0000000000e1', id, '{"name": "Test Hall X1 Grand"}', version
  from app.listings where id = v_x1;
  perform pg_temp.as_actor(null);

  insert into app.favorites (client_id, listing_id) values ('cccccccc-0000-0000-0000-000000000001', v_x1);
  insert into app.contact_events (listing_id, action, source, signed_in) values
    (v_x1, 'open', 'web', false), (v_x1, 'phone', 'web', false);

  -- оповещения о витрине, правке, услуге, фото; одно не дошло — и о нём оповещение команде
  insert into app.outbox (id, kind, recipient_kind, recipient_id, payload, dedupe_key, status) values
    ('abababab-0000-0000-0000-0000000000b1', 'ops.photos_submitted', 'staff', '00000000-0000-0000-0000-00000000a001',
     jsonb_build_object('listing_id', v_x1), 'x-test:photos', 'pending'),
    ('abababab-0000-0000-0000-0000000000b2', 'ops.revision_submitted', 'staff', '00000000-0000-0000-0000-00000000a001',
     '{"revision_id": "abababab-0000-0000-0000-0000000000e1"}', 'x-test:revision', 'sent'),
    ('abababab-0000-0000-0000-0000000000b3', 'vendor.service_decided', 'vendor_user',
     'bbbbbbbb-0000-0000-0000-000000000011', '{"service_id": "abababab-0000-0000-0000-0000000005e1"}',
     'x-test:service', 'dead'),
    ('abababab-0000-0000-0000-0000000000b4', 'ops.photo_test', 'staff', '00000000-0000-0000-0000-00000000a001',
     '{"photo_id": "abababab-0000-0000-0000-00000000f004"}', 'x-test:photo', 'pending'),
    ('abababab-0000-0000-0000-0000000000b5', 'ops.outbox_dead', 'staff', '00000000-0000-0000-0000-00000000a001',
     '{"outbox_id": "abababab-0000-0000-0000-0000000000b3"}', 'x-test:dead', 'pending'),
    ('abababab-0000-0000-0000-0000000000b6', 'vendor.ops_reminder', 'vendor_user',
     'abababab-0000-0000-0000-000000000011', '{}', 'x-test:user', 'dead'),
    ('abababab-0000-0000-0000-0000000000b7', 'ops.outbox_dead', 'staff', '00000000-0000-0000-0000-00000000a001',
     '{"outbox_id": "abababab-0000-0000-0000-0000000000b6"}', 'x-test:user-dead', 'pending'),
    -- чужое: о витрине A1 — остаётся
    ('abababab-0000-0000-0000-0000000000c1', 'ops.photos_submitted', 'staff', '00000000-0000-0000-0000-00000000a001',
     '{"listing_id": "aaaaaaaa-0000-0000-0000-000000000101"}', 'x-test:other', 'pending');
end $$;

-- A3: витрина вендора A без заявок — опубликованная, как A1
do $$
declare
  v_a3 uuid := 'aaaaaaaa-0000-0000-0000-000000000103';
begin
  perform pg_temp.as_actor(null);
  insert into app.listings (id, vendor_id, slug, category_code, name, district_code,
                            description_ru, description_uz, cap_min, cap_max)
  values (v_a3, 'aaaaaaaa-0000-0000-0000-000000000001', 'test-a3', 'hall', 'Test Hall A3', 'yunusobod',
          'Описание', 'Tavsif', 50, 300);
  insert into pii.listing_contacts (listing_id, public_phone) values (v_a3, '+998000000998');
  insert into app.listing_services (listing_id, category_code, service_type, status, price_uzs, price_unit, sort) values
    (v_a3, 'hall', 'banquet_weekday', 'active', 150000, 'per_guest', 1),
    (v_a3, 'hall', 'banquet_weekend', 'active', 180000, 'per_guest', 2);
  insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256, sort,
                          no_faces_ack)
  select v_a3, 'ready', 'approved', pg_temp.photo_key(v_a3), 'image/webp', 1000, 1600, 1200,
         sha256(convert_to('a3/' || n, 'UTF8')), n, true
  from generate_series(1, 3) n;
  update app.listings set status = 'review' where id = v_a3;
  update app.listings set status = 'active' where id = v_a3;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Почему нельзя удалить — заранее
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a003');
select is(app.listing_delete_blocker('aaaaaaaa-0000-0000-0000-000000000101'), 'requests',
  'у опубликованной витрины с заявкой причина — заявки (их история останется и после приостановки)');
select is(app.listing_delete_blocker('aaaaaaaa-0000-0000-0000-000000000103'), 'published',
  'опубликованная без заявок — сначала снять с публикации');
select is(app.listing_delete_blocker('abababab-0000-0000-0000-000000000101'), null, 'черновик без заявок — можно');
select is(app.vendor_delete_blocker('aaaaaaaa-0000-0000-0000-000000000001'), 'requests', 'вендор с заявками — нельзя');
select is(app.vendor_delete_blocker('abababab-0000-0000-0000-000000000001'), null, 'вендор без заявок и публикаций — можно');

-- ════════════════════════════════════════════════════════════════════════════
-- Кто удаляет
-- ════════════════════════════════════════════════════════════════════════════
select throws_ok($$select app.staff_delete_listing('abababab-0000-0000-0000-000000000101')$$,
  'BR003', null, 'модератор витрину не удаляет');
select throws_ok($$select app.staff_delete_vendor('abababab-0000-0000-0000-000000000001')$$,
  'BR003', null, 'модератор вендора не удаляет');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok($$select app.staff_delete_vendor('abababab-0000-0000-0000-000000000001')$$,
  'BR003', null, 'менеджер вендора не удаляет');
select pg_temp.as_actor('vendor_user', 'abababab-0000-0000-0000-000000000011', 'abababab-0000-0000-0000-000000000001');
select throws_ok($$select app.staff_delete_listing('abababab-0000-0000-0000-000000000101')$$,
  'BR003', null, 'партнёр витрину не удаляет');
select pg_temp.as_actor(null);
select throws_ok($$select app.staff_delete_listing('abababab-0000-0000-0000-000000000101')$$,
  'BR003', null, 'без актора — нельзя');

-- ════════════════════════════════════════════════════════════════════════════
-- Витрина: нельзя
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok($$select app.staff_delete_listing('aaaaaaaa-0000-0000-0000-000000000101')$$,
  'BR029', 'listing_in_use', 'с заявкой — нельзя');
select is(pg_temp.error_detail($$select app.staff_delete_listing('aaaaaaaa-0000-0000-0000-000000000101')$$),
  'requests', 'причина — заявки');
select is(pg_temp.error_detail($$select app.staff_delete_listing('aaaaaaaa-0000-0000-0000-000000000103')$$),
  'published', 'опубликованную без заявок — сначала приостановить');
select throws_ok($$select app.staff_delete_listing('aaaaaaaa-0000-0000-0000-0000000001ff')$$,
  '42501', null, 'нет такой витрины — 42501 (API: 404)');

-- на проверке — тоже нельзя
reset role;
update app.listings set status = 'suspended', status_reason = 'Пауза' where id = 'aaaaaaaa-0000-0000-0000-000000000103';
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select is(app.listing_delete_blocker('aaaaaaaa-0000-0000-0000-000000000103'), null, 'приостановленная без заявок — можно');

-- ════════════════════════════════════════════════════════════════════════════
-- Витрина X1 целиком
-- ════════════════════════════════════════════════════════════════════════════
create function pg_temp.x1_rows() returns table (what text, n int)
language sql
as $$
  select 'listing', count(*)::int from app.listings where id = 'abababab-0000-0000-0000-000000000101'
  union all select 'contacts', count(*)::int from pii.listing_contacts where listing_id = 'abababab-0000-0000-0000-000000000101'
  union all select 'services', count(*)::int from app.listing_services where listing_id = 'abababab-0000-0000-0000-000000000101'
  union all select 'photos', count(*)::int from app.photos where listing_id = 'abababab-0000-0000-0000-000000000101'
  union all select 'revisions', count(*)::int from app.listing_revisions where listing_id = 'abababab-0000-0000-0000-000000000101'
  union all select 'days', count(*)::int from app.availability where listing_id = 'abababab-0000-0000-0000-000000000101'
  union all select 'versions', count(*)::int from app.availability_versions where listing_id = 'abababab-0000-0000-0000-000000000101'
  union all select 'favorites', count(*)::int from app.favorites where listing_id = 'abababab-0000-0000-0000-000000000101'
  union all select 'contact_events', count(*)::int from app.contact_events where listing_id = 'abababab-0000-0000-0000-000000000101'
  union all select 'outbox', count(*)::int from app.outbox
    where id in ('abababab-0000-0000-0000-0000000000b1', 'abababab-0000-0000-0000-0000000000b2',
                 'abababab-0000-0000-0000-0000000000b3', 'abababab-0000-0000-0000-0000000000b4',
                 'abababab-0000-0000-0000-0000000000b5')
$$;

reset role;
select results_eq($$select n from pg_temp.x1_rows()$$,
  $$values (1), (1), (1), (4), (1), (2), (1), (1), (2), (5)$$,
  'до удаления у X1 есть всё, что проверяем');
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');

select results_eq(
  $$select k from unnest(app.staff_delete_listing('abababab-0000-0000-0000-000000000101')) k order by k$$,
  $$values ('listings/abababab-0000-0000-0000-000000000101/abababab-0000-0000-0000-00000000f001.webp'),
           ('listings/abababab-0000-0000-0000-000000000101/abababab-0000-0000-0000-00000000f002.webp'),
           ('listings/abababab-0000-0000-0000-000000000101/abababab-0000-0000-0000-00000000f003.webp'),
           ('listings/abababab-0000-0000-0000-000000000101/abababab-0000-0000-0000-00000000f004.webp')$$,
  'менеджер удаляет черновик: ключи всех фото (и удалённого из витрины) — API уберёт объекты');

reset role;
select results_eq($$select what, n from pg_temp.x1_rows()$$,
  $$values ('listing', 0), ('contacts', 0), ('services', 0), ('photos', 0), ('revisions', 0), ('days', 0),
           ('versions', 0), ('favorites', 0), ('contact_events', 0), ('outbox', 0)$$,
  'у X1 не осталось ничего: ни строк, ни оповещений о ней (и о недоставленном про неё)');
select is((select count(*)::int from app.listing_status_log where listing_id = 'abababab-0000-0000-0000-000000000101') > 0,
  true, 'история статусов — журнал только на добавление — остаётся');
select is((select count(*)::int from app.outbox where id = 'abababab-0000-0000-0000-0000000000c1'), 1,
  'оповещение о чужой витрине на месте');
select is((select count(*)::int from app.listings where id = 'abababab-0000-0000-0000-000000000102'), 1,
  'вторая витрина вендора на месте');
select results_eq(
  $$select actor_kind::text, actor_id, object_type, source::text, detail from app.audit_log
     where action = 'listing.delete' and object_id = 'abababab-0000-0000-0000-000000000101'$$,
  $$values ('staff', '00000000-0000-0000-0000-00000000a002'::uuid, 'listing', 'admin',
            '{"vendor_id": "abababab-0000-0000-0000-000000000001", "category": "hall", "status": "draft",
              "photos": 4, "services": 1, "revisions": 1, "busy_days": 2}'::jsonb)$$,
  'в журнале — одна запись: кто, вендор, категория, статус и сколько чего, без названий');
select is(
  (select count(*)::int from app.audit_log
    where object_id = 'abababab-0000-0000-0000-000000000101'
      and action in ('listing_contact.delete', 'listing_service.delete', 'availability.delete', 'photo.delete')),
  0, 'каскад строк витрины в журнал не пишется');
select is(
  (select count(*)::int from app.audit_log
    where object_id = 'abababab-0000-0000-0000-000000000101' and action = 'availability.create'),
  1, 'прежние записи журнала о витрине остаются');

-- Удаление строк живой витрины по-прежнему в журнале
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
delete from app.availability_parts where listing_id = 'abababab-0000-0000-0000-000000000102';
reset role;
select is(
  (select count(*)::int from app.audit_log
    where object_id = 'abababab-0000-0000-0000-000000000102' and action = 'availability_part.delete'),
  1, 'снятая отметка живой витрины — в журнале, как раньше');

-- Приостановленную без заявок — администратор
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select is(cardinality(app.staff_delete_listing('aaaaaaaa-0000-0000-0000-000000000103')), 3,
  'приостановленную без заявок удаляет администратор');
reset role;
select is((select count(*)::int from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000103'), 0, 'A3 удалена');
select is(
  (select detail ->> 'status' from app.audit_log where action = 'listing.delete'
     and object_id = 'aaaaaaaa-0000-0000-0000-000000000103'),
  'suspended', 'в журнале — статус, из которого удалили');
select is((select count(*)::int from app.listings where vendor_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 2,
  'остальные витрины вендора A на месте');

-- ════════════════════════════════════════════════════════════════════════════
-- Вендор
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok($$select app.staff_delete_vendor('aaaaaaaa-0000-0000-0000-000000000001')$$,
  'BR030', 'vendor_in_use', 'вендор с заявками — нельзя');
select is(pg_temp.error_detail($$select app.staff_delete_vendor('aaaaaaaa-0000-0000-0000-000000000001')$$),
  'requests', 'причина — заявки');
select throws_ok($$select app.staff_delete_vendor('abababab-0000-0000-0000-0000000000ff')$$,
  '42501', null, 'нет такого вендора — 42501 (API: 404)');

-- X2 на проверке — вендора не удалить, пока не вернут в черновик
reset role;
alter table app.listings disable trigger listings_before_update;
update app.listings set status = 'review' where id = 'abababab-0000-0000-0000-000000000102';
alter table app.listings enable trigger listings_before_update;
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select is(app.vendor_delete_blocker('abababab-0000-0000-0000-000000000001'), 'published',
  'витрина на проверке — сначала вернуть в черновик');
select is(pg_temp.error_detail($$select app.staff_delete_vendor('abababab-0000-0000-0000-000000000001')$$),
  'published', 'удаление вендора — та же причина');
reset role;
alter table app.listings disable trigger listings_before_update;
update app.listings set status = 'draft' where id = 'abababab-0000-0000-0000-000000000102';
alter table app.listings enable trigger listings_before_update;

create function pg_temp.x_rows() returns table (what text, n int)
language sql
as $$
  select 'vendor', count(*)::int from app.vendor_accounts where id = 'abababab-0000-0000-0000-000000000001'
  union all select 'contacts', count(*)::int from pii.vendor_contacts where vendor_id = 'abababab-0000-0000-0000-000000000001'
  union all select 'listings', count(*)::int from app.listings where vendor_id = 'abababab-0000-0000-0000-000000000001'
  union all select 'photos', count(*)::int from app.photos where listing_id = 'abababab-0000-0000-0000-000000000102'
  union all select 'parts', count(*)::int from app.availability_parts where listing_id = 'abababab-0000-0000-0000-000000000102'
  union all select 'users', count(*)::int from app.vendor_users where vendor_id = 'abababab-0000-0000-0000-000000000001'
  union all select 'user_profiles', count(*)::int from pii.vendor_user_profiles
    where vendor_user_id = 'abababab-0000-0000-0000-000000000011'
  union all select 'sessions', count(*)::int from app.sessions where token_hash = sha256('vendor-x-session')
  union all select 'outbox', count(*)::int from app.outbox
    where id in ('abababab-0000-0000-0000-0000000000b6', 'abababab-0000-0000-0000-0000000000b7')
$$;

-- снова отметка части дня у X2: удалится каскадом
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
insert into app.availability_parts (listing_id, day, part, source)
values ('abababab-0000-0000-0000-000000000102', current_date + 11, 'evening', 'staff');
reset role;
select results_eq($$select n from pg_temp.x_rows()$$,
  $$values (1), (1), (1), (1), (1), (1), (1), (1), (2)$$, 'до удаления у вендора X есть всё, что проверяем');
create temp table x_code on commit drop as
select public_code from app.vendor_accounts where id = 'abababab-0000-0000-0000-000000000001';
grant select on x_code to bayramm_api;

set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select is(app.staff_delete_vendor('abababab-0000-0000-0000-000000000001'),
  array['listings/abababab-0000-0000-0000-000000000102/abababab-0000-0000-0000-00000000f201.webp'],
  'администратор удаляет вендора: ключи фото всех его витрин');
reset role;
select results_eq($$select what, n from pg_temp.x_rows()$$,
  $$values ('vendor', 0), ('contacts', 0), ('listings', 0), ('photos', 0), ('parts', 0), ('users', 0),
           ('user_profiles', 0), ('sessions', 0), ('outbox', 0)$$,
  'у вендора X не осталось ничего: реквизиты, витрины, пользователи кабинета, их сессии и оповещения');
select is((select count(*)::int from app.accounts where id = 'acacacac-0000-0000-0000-0000000000a1'), 1,
  'аккаунт человека остаётся: у него бывают другие роли');
select is((select count(*)::int from app.consents where subject_id = 'abababab-0000-0000-0000-000000000011'), 1,
  'согласие пользователя кабинета — в журнале согласий');
select results_eq(
  $$select actor_id, object_type, source::text, detail from app.audit_log
     where action = 'vendor.delete' and object_id = 'abababab-0000-0000-0000-000000000001'$$,
  $$select '00000000-0000-0000-0000-00000000a001'::uuid, 'vendor', 'admin',
           jsonb_build_object('code', public_code, 'listings', 1, 'photos', 1, 'users', 1) from x_code$$,
  'в журнале — одна запись: код вендора и сколько чего, без названий и телефонов');
select is(
  (select count(*)::int from app.audit_log
    where object_id = 'abababab-0000-0000-0000-000000000102' and action = 'listing.delete'),
  1, 'витрина вендора — отдельной записью listing.delete');

-- ════════════════════════════════════════════════════════════════════════════
-- Команда: отозвать приглашение
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
create temp table invites on commit drop as
select app.staff_invite('pending_person', 'Pending', 'manager') as by_tg,
       app.staff_invite_phone(sha256('+998000000777'), 'By phone', 'admin') as by_phone,
       app.staff_invite('acted_person', 'Acted', 'moderator') as acted;
reset role;
grant select on invites to bayramm_api;
-- Непринятого успели назначить менеджером вендора; другой «непринятый» уже действовал
update app.vendor_accounts set manager_id = (select by_tg from invites) where id = 'aaaaaaaa-0000-0000-0000-000000000001';
insert into app.audit_log (actor_kind, actor_id, action, object_type, object_id)
select 'staff', acted, 'request.remind', 'request', 'eeeeeeee-0000-0000-0000-0000000000a1' from invites;

set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok($$select app.staff_revoke_invite((select by_tg from invites))$$,
  'BR003', null, 'менеджер приглашений не отзывает');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok($$select app.staff_revoke_invite('00000000-0000-0000-0000-00000000a001')$$,
  'BR018', 'staff_self', 'себя — нельзя');
select throws_ok($$select app.staff_revoke_invite('00000000-0000-0000-0000-00000000a002')$$,
  'BR033', 'staff_invite_accepted', 'принятое (есть аккаунт) — нельзя: отключить');
select throws_ok($$select app.staff_revoke_invite((select acted from invites))$$,
  'BR033', 'staff_invite_accepted', 'кто уже действовал (есть в журнале) — нельзя');
select throws_ok($$select app.staff_revoke_invite('00000000-0000-0000-0000-0000000000ff')$$,
  '22023', null, 'нет такого сотрудника');

select lives_ok($$select app.staff_revoke_invite((select by_tg from invites))$$, 'непринятое — отзывается');
select lives_ok($$select app.staff_revoke_invite((select by_phone from invites))$$, 'приглашение по телефону — тоже');
reset role;
select is(
  (select count(*)::int from app.staff s, invites i where s.id in (i.by_tg, i.by_phone))
  + (select count(*)::int from pii.staff_profiles p, invites i where p.staff_id in (i.by_tg, i.by_phone)),
  0, 'ни строки сотрудника, ни профиля');
select is((select manager_id from app.vendor_accounts where id = 'aaaaaaaa-0000-0000-0000-000000000001'), null,
  'вендор остался без менеджера-приглашения');
select results_eq(
  $$select a.detail from app.audit_log a, invites i
     where a.action = 'staff.invite_revoke' and a.object_id in (i.by_tg::text, i.by_phone::text) order by a.id$$,
  $$values ('{"role": "manager", "via": "telegram"}'::jsonb), ('{"role": "admin", "via": "phone"}'::jsonb)$$,
  'в журнале — роль и способ, без имени и номера');
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select lives_ok($$select app.staff_invite('pending_person', 'Pending again', 'manager')$$,
  'то же имя можно пригласить снова');

-- ════════════════════════════════════════════════════════════════════════════
-- Последний действующий администратор — только из принятых
-- ════════════════════════════════════════════════════════════════════════════
select ok(app.staff_invite('pending_admin', 'Pending admin', 'admin') is not null, 'ещё одно приглашение администратора');
reset role;
select throws_ok($$update app.staff set active = false where id = '00000000-0000-0000-0000-00000000a001'$$,
  'BR017', 'staff_last_admin', 'непринятое приглашение администратора — не замена последнему');
select lives_ok(
  $$update app.staff s set active = false from pii.staff_profiles p
     where p.staff_id = s.id and p.telegram_username = 'pending_admin'$$,
  'непринятое приглашение администратора отключается всегда');
insert into app.accounts (id) values ('acacacac-0000-0000-0000-00000000a005');
insert into app.staff (id, role, account_id)
values ('00000000-0000-0000-0000-00000000a005', 'admin', 'acacacac-0000-0000-0000-00000000a005');
select lives_ok($$update app.staff set role = 'manager' where id = '00000000-0000-0000-0000-00000000a001'$$,
  'есть другой принятый администратор — можно');

select * from finish();
rollback;
