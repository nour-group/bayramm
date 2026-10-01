-- Панель оператора v0.1: название вендора, история статусов карточки, журнал
-- действий сотрудников (пишет база, без ПДн)
begin;
\ir _fixtures.psql
select plan(33);

-- ── структура и права ───────────────────────────────────────────────────────
select has_column('app', 'vendor_accounts', 'name', 'у вендора есть название для панели');
select throws_ok(
  $$update app.vendor_accounts set name = ' x ' where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  '23514', null, 'название — от 2 символов без пробелов по краям');
select has_table('app', 'listing_status_log', 'история статусов карточки');
select ok(has_table_privilege('bayramm_api', 'app.listing_status_log', 'SELECT'), 'API читает историю статусов');
select ok(not has_table_privilege('bayramm_api', 'app.listing_status_log', 'INSERT'),
  'историю статусов пишет только триггер');
select ok(not has_table_privilege('bayramm_api', 'app.listing_status_log', 'UPDATE'), 'история: нет UPDATE');
select ok(not has_table_privilege('bayramm_api', 'app.listing_status_log', 'DELETE'), 'история: нет DELETE');
select ok(not has_function_privilege('bayramm_api', 'app.audit_staff_change()', 'EXECUTE'),
  'журнал сотрудников пишет только триггер');
select ok(not has_function_privilege('bayramm_api', 'app.listings_log_status()', 'EXECUTE'),
  'историю статусов пишет только триггер');

-- ── история статусов: сотрудник через роль API ──────────────────────────────
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');

update app.listings set status = 'rejected', status_reason = 'Нет договора'
 where id = 'aaaaaaaa-0000-0000-0000-000000000102';
select results_eq(
  $$select from_status::text, to_status::text, actor_kind::text, actor_id, reason
      from app.listing_status_log where listing_id = 'aaaaaaaa-0000-0000-0000-000000000102'
     order by id desc limit 1$$,
  $$values ('draft', 'rejected', 'staff', '00000000-0000-0000-0000-00000000a001'::uuid, 'Нет договора')$$,
  'отклонение: откуда, куда, кто и причина');

select set_config('app.reason', 'Вернули на доработку', true);
update app.listings set status = 'draft' where id = 'aaaaaaaa-0000-0000-0000-000000000102';
select set_config('app.reason', '', true);
select results_eq(
  $$select from_status::text, to_status::text, reason
      from app.listing_status_log where listing_id = 'aaaaaaaa-0000-0000-0000-000000000102'
     order by id desc limit 1$$,
  $$values ('rejected', 'draft', 'Вернули на доработку')$$,
  'возврат в черновик: комментарий из app.reason');

insert into app.listings (id, vendor_id, slug, category_code, name, status)
values ('aaaaaaaa-0000-0000-0000-000000000103', 'aaaaaaaa-0000-0000-0000-000000000001', 'test-a3', 'hall',
        'Test Hall A3', 'lead');
select results_eq(
  $$select from_status::text, to_status::text, reason
      from app.listing_status_log where listing_id = 'aaaaaaaa-0000-0000-0000-000000000103'$$,
  $$values (null::text, 'lead', null::text)$$,
  'новая карточка: первая запись истории');

update app.listings set name = 'Test Hall A3 renamed' where id = 'aaaaaaaa-0000-0000-0000-000000000103';
select is((select count(*)::int from app.listing_status_log where listing_id = 'aaaaaaaa-0000-0000-0000-000000000103'),
  1, 'правка без смены статуса историю не пополняет');

select throws_ok(
  $$insert into app.listing_status_log (listing_id, to_status, actor_kind)
    values ('aaaaaaaa-0000-0000-0000-000000000102', 'active', 'staff')$$,
  '42501', null, 'API: историю нельзя дописать в обход триггера');

-- ── журнал действий сотрудника ──────────────────────────────────────────────
select results_eq(
  $$select action, object_type, actor_kind::text, actor_id, detail
      from app.audit_log where object_id = 'aaaaaaaa-0000-0000-0000-000000000103' order by id$$,
  $$values
      ('listing.create', 'listing', 'staff', '00000000-0000-0000-0000-00000000a001'::uuid,
       '{"vendor_id": "aaaaaaaa-0000-0000-0000-000000000001"}'::jsonb),
      ('listing.update', 'listing', 'staff', '00000000-0000-0000-0000-00000000a001'::uuid,
       '{"fields": ["name"], "vendor_id": "aaaaaaaa-0000-0000-0000-000000000001"}'::jsonb)$$,
  'создание и правка карточки — в журнале: кто и какие поля, без значений');

select results_eq(
  $$select action, detail - 'vendor_id'
      from app.audit_log where object_id = 'aaaaaaaa-0000-0000-0000-000000000102' and action = 'listing.update'
     order by id$$,
  $$values
      ('listing.update', '{"fields": ["status", "status_reason"], "from": "draft", "to": "rejected"}'::jsonb),
      ('listing.update', '{"fields": ["status", "status_reason"], "from": "rejected", "to": "draft"}'::jsonb)$$,
  'смена статуса — в журнале с from/to; текст причины — только в истории статусов');

select lives_ok(
  $$update app.listings set name = name where id = 'aaaaaaaa-0000-0000-0000-000000000103'$$,
  'правка без изменений проходит');
select is((select count(*)::int from app.audit_log where object_id = 'aaaaaaaa-0000-0000-0000-000000000103'),
  2, '…и журнал не засоряет');

insert into pii.listing_contacts (listing_id, public_phone)
values ('aaaaaaaa-0000-0000-0000-000000000103', '+998000000777');
insert into app.listing_services (listing_id, category_code, service_type, status, price_uzs, price_unit)
values ('aaaaaaaa-0000-0000-0000-000000000103', 'hall', 'banquet_weekday', 'active', 100000, 'per_guest');
delete from app.listing_services where listing_id = 'aaaaaaaa-0000-0000-0000-000000000103';
-- день — в будущем: прошедший день календаря не меняется (availability_guard)
insert into app.availability (listing_id, day, source)
values ('aaaaaaaa-0000-0000-0000-000000000103', current_date + 90, 'staff');
select results_eq(
  $$select action, detail
      from app.audit_log where object_id = 'aaaaaaaa-0000-0000-0000-000000000103'
       and action not like 'listing.%' and action not like 'listing\_service.%' order by id$$,
  $$values
      ('listing_contact.create', '{}'::jsonb),
      ('availability.create', jsonb_build_object('day', current_date + 90))$$,
  'телефон и занятость — в журнале объекта «листинг»');
select is(
  (select array_agg(action order by id) from app.audit_log
    where object_id = 'aaaaaaaa-0000-0000-0000-000000000103' and action like 'listing\_service.%'),
  array['listing_service.create', 'listing_service.delete'],
  'услуги — тоже в журнале объекта «листинг»');
select is_empty(
  $$select id from app.audit_log where detail::text like '%777%'$$,
  'телефон в журнал не попадает');

update pii.vendor_contacts set phone = '+998000000555', contact_person = 'Person A2'
 where vendor_id = 'aaaaaaaa-0000-0000-0000-000000000001';
select results_eq(
  $$select action, object_type, detail from app.audit_log
     where object_id = 'aaaaaaaa-0000-0000-0000-000000000001' order by id desc limit 1$$,
  $$values ('vendor_contact.update', 'vendor', '{"fields": ["contact_person", "phone"]}'::jsonb)$$,
  'правка контактов вендора: имена полей без значений');
select is_empty(
  $$select id from app.audit_log where detail::text like '%555%' or detail::text like '%Person A2%'$$,
  'ни телефона, ни имени контактного лица в журнале');

update app.vendor_accounts set stir_verified_at = now() - interval '1 day', stir_verified_by = '00000000-0000-0000-0000-00000000a001',
                               name = 'Test Vendor A'
 where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select results_eq(
  $$select action, detail from app.audit_log
     where object_type = 'vendor' and object_id = 'aaaaaaaa-0000-0000-0000-000000000001' order by id desc limit 1$$,
  $$values ('vendor.update', '{"fields": ["name", "stir_verified_at", "stir_verified_by"]}'::jsonb)$$,
  'отметка чек-листа — в журнале');

insert into app.vendor_users (id, vendor_id, phone_hash)
values ('aaaaaaaa-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', sha256('vendor-a-2'));
update app.vendor_users set disabled_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000012';
select results_eq(
  $$select action, detail from app.audit_log where object_id = 'aaaaaaaa-0000-0000-0000-000000000012' order by id$$,
  $$values
      ('vendor_user.create', '{"vendor_id": "aaaaaaaa-0000-0000-0000-000000000001"}'::jsonb),
      ('vendor_user.update', '{"fields": ["disabled_at"], "vendor_id": "aaaaaaaa-0000-0000-0000-000000000001"}'::jsonb)$$,
  'пользователь кабинета: создание и отключение — в журнале');

-- ── вендор и система в журнал сотрудников не пишут ──────────────────────────
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
update app.listings set name = 'Vendor rename' where id = 'aaaaaaaa-0000-0000-0000-000000000103';
select pg_temp.as_actor('system');
update app.listings set name = 'System rename' where id = 'aaaaaaaa-0000-0000-0000-000000000103';
select is((select count(*)::int from app.audit_log where object_id = 'aaaaaaaa-0000-0000-0000-000000000103'
             and action = 'listing.update' and detail -> 'fields' ? 'name'),
  1, 'правки вендора и системы в журнал сотрудников не попадают (одна — переименование сотрудником выше)');

-- ── кто видит историю статусов ──────────────────────────────────────────────
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select isnt_empty(
  $$select id from app.listing_status_log where listing_id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  'вендор видит историю своей карточки');
select pg_temp.as_actor('vendor_user', 'bbbbbbbb-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001');
select is_empty(
  $$select id from app.listing_status_log where listing_id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  'чужую историю вендор не видит');
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select is_empty($$select id from app.listing_status_log$$, 'клиент историю статусов не видит');
select pg_temp.as_actor(null);
select is_empty($$select id from app.listing_status_log$$, 'без актора — ничего');

-- ── только на добавление, даже для владельца ────────────────────────────────
reset role;
select throws_ok($$update app.listing_status_log set reason = 'подмена'$$,
  'BR001', 'append_only', 'историю статусов не изменить даже владельцу');
select throws_ok($$delete from app.listing_status_log$$,
  'BR001', 'append_only', 'историю статусов не удалить даже владельцу');
select throws_ok($$truncate app.listing_status_log$$,
  'BR001', 'append_only', 'историю статусов не очистить даже владельцу');

select * from finish();
rollback;
