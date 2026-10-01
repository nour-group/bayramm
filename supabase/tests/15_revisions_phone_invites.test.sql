-- Правка карточки от партнёра — оповещение команде (кто решает по правкам);
-- приглашение сотрудника по телефону: только HMAC номера, один номер — один
-- действующий сотрудник, подтверждённый у аккаунта номер — приглашение принято сразу
begin;
\ir _fixtures.psql
select plan(22);

-- ════════════════════════════════════════════════════════════════════════════
-- Права
-- ════════════════════════════════════════════════════════════════════════════
select ok(has_function_privilege('bayramm_api', 'app.staff_invite_phone(bytea, text, app.staff_role)', 'EXECUTE'),
  'API приглашает по телефону функцией базы');
select is_empty(
  $$select f from unnest(array['app.enqueue_staff_alert(text, app.staff_role[], jsonb, text)',
                               'app.listing_revisions_notify()']) f
    where has_function_privilege('bayramm_api', f, 'EXECUTE')$$,
  'служебные функции оповещения API недоступны');

-- ════════════════════════════════════════════════════════════════════════════
-- Правка карточки от партнёра — команде
-- ════════════════════════════════════════════════════════════════════════════
-- У каждого сотрудника — чат с ботом; модератор …a003 и отключённый модератор …a005
insert into app.staff (id, role) values
  ('00000000-0000-0000-0000-00000000a003', 'moderator'),
  ('00000000-0000-0000-0000-00000000a005', 'moderator');
insert into pii.staff_profiles (staff_id, display_name) values
  ('00000000-0000-0000-0000-00000000a003', 'Moderator'),
  ('00000000-0000-0000-0000-00000000a005', 'Moderator Off');
update pii.staff_profiles set telegram_chat_id = 9000 + right(staff_id::text, 1)::int
where staff_id in ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a002',
                   '00000000-0000-0000-0000-00000000a003', '00000000-0000-0000-0000-00000000a005');
update app.staff set active = false where id = '00000000-0000-0000-0000-00000000a005';

set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select lives_ok(
  $$insert into app.listing_revisions (listing_id, payload, base_version)
    select id, '{"description_ru": "Новое описание"}', version from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'партнёр предлагает правку своей карточки');
select throws_ok(
  $$insert into app.listing_revisions (listing_id, payload, base_version)
    select id, '{"name": "Другое"}', version from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  '23505', null, 'вторая открытая правка той же площадки — нельзя');
select throws_ok(
  $$insert into app.listing_revisions (listing_id, payload, base_version)
    values ('bbbbbbbb-0000-0000-0000-000000000101', '{"name": "Чужое"}', 1)$$,
  '42501', null, 'правку чужой карточки не подать');

reset role;
select results_eq(
  $$select o.recipient_id, o.payload = jsonb_build_object('revision_id', r.id), o.request_id is null
      from app.outbox o join app.listing_revisions r on o.payload ->> 'revision_id' = r.id::text
     where o.kind = 'ops.revision_submitted' order by o.recipient_id$$,
  $$values ('00000000-0000-0000-0000-00000000a001'::uuid, true, true),
           ('00000000-0000-0000-0000-00000000a003'::uuid, true, true)$$,
  'оповещение — администратору и действующему модератору, в payload только id правки');

set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select lives_ok(
  $$update app.listing_revisions set status = 'withdrawn'
     where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and status = 'pending'$$,
  'партнёр отзывает свою открытую правку');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
insert into app.listing_revisions (listing_id, payload, base_version)
select id, '{"name": "Test Hall A1 Staff"}', version from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000101';
reset role;
select is((select count(*)::int from app.outbox where kind = 'ops.revision_submitted'), 2,
  'правка, которую завёл не партнёр, команду не оповещает');

-- ════════════════════════════════════════════════════════════════════════════
-- Приглашение по телефону
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok($$select app.staff_invite_phone(sha256('staff-phone-1'), 'Phone Person', 'manager')$$,
  'BR003', 'forbidden_for_actor', 'по телефону приглашает только администратор');

select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok($$select app.staff_invite_phone('\x00'::bytea, 'Phone Person', 'manager')$$,
  '22023', null, 'не HMAC номера — нет');
select throws_ok($$select app.staff_invite_phone(sha256('staff-phone-1'), '  ', 'manager')$$,
  '22023', null, 'без имени для панели — нет');
select lives_ok($$select app.staff_invite_phone(sha256('staff-phone-1'), ' Phone Person ', 'manager')$$,
  'администратор приглашает по номеру');
select results_eq(
  $$select s.role::text, s.active, s.account_id is null, p.display_name, p.telegram_username is null
      from app.staff s join pii.staff_profiles p on p.staff_id = s.id where s.phone_hash = sha256('staff-phone-1')$$,
  $$values ('manager', true, true, 'Phone Person', true)$$,
  'приглашение: роль, имя без пробелов по краям, Telegram не задан, ещё не принято');
select results_eq(
  $$select a.detail from app.audit_log a join app.staff s on s.id::text = a.object_id
     where a.action = 'staff.invite' and s.phone_hash = sha256('staff-phone-1')$$,
  $$values ('{"role": "manager", "via": "phone"}'::jsonb)$$,
  'приглашение — в журнале: роль и способ, без имени и номера');
select throws_ok($$select app.staff_invite_phone(sha256('staff-phone-1'), 'Twin', 'moderator')$$,
  '23505', null, 'номер уже у действующего сотрудника');

-- Отключённый сотрудник номер не держит
reset role;
update app.staff set active = false where phone_hash = sha256('staff-phone-1');
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select lives_ok($$select app.staff_invite_phone(sha256('staff-phone-1'), 'Second Try', 'moderator')$$,
  'после отключения номер можно пригласить снова');

-- Номер уже подтверждён у аккаунта — приглашение принято сразу
reset role;
insert into app.accounts (id) values ('acacacac-0000-0000-0000-0000000000f1'), ('acacacac-0000-0000-0000-0000000000f2');
insert into app.account_identities (account_id, kind, value_hash) values
  ('acacacac-0000-0000-0000-0000000000f1', 'phone', sha256('staff-phone-2')),
  ('acacacac-0000-0000-0000-00000000a002', 'phone', sha256('staff-phone-3'));
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select lives_ok($$select app.staff_invite_phone(sha256('staff-phone-2'), 'Known Phone', 'moderator')$$,
  'приглашение по номеру, который аккаунт уже подтвердил');
reset role;
select results_eq(
  $$select s.account_id from app.staff s where s.phone_hash = sha256('staff-phone-2')$$,
  $$values ('acacacac-0000-0000-0000-0000000000f1'::uuid)$$,
  'роль сотрудника — сразу у аккаунта этого номера');
select results_eq(
  $$select a.action from app.audit_log a join app.staff s on s.id::text = a.object_id
     where s.phone_hash = sha256('staff-phone-2') order by a.id$$,
  $$values ('staff.invite'), ('staff.phone_claim')$$,
  'принятие приглашения — в журнале');

set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok($$select app.staff_invite_phone(sha256('staff-phone-3'), 'Manager Again', 'manager')$$,
  '23505', null, 'у аккаунта с этим номером уже есть роль сотрудника — не приглашаем второй раз');

-- Принимает приглашение вход кодом на этот номер (как в 14_accounts: account_bind_phone)
reset role;
select app.account_bind_phone('acacacac-0000-0000-0000-0000000000f2', sha256('staff-phone-1'), 'web');
select results_eq(
  $$select s.account_id, p.display_name from app.staff s join pii.staff_profiles p on p.staff_id = s.id
     where s.phone_hash = sha256('staff-phone-1') and s.active$$,
  $$values ('acacacac-0000-0000-0000-0000000000f2'::uuid, 'Second Try'::text)$$,
  'вход аккаунта этим номером принимает действующее приглашение');
select is((select count(*)::int from app.staff where phone_hash = sha256('staff-phone-1') and account_id is not null), 1,
  'отключённое приглашение этим входом не принимается');

select * from finish();
rollback;
