-- RLS: изоляция вендоров и клиентов, поведение без актора, чтение телефонов
begin;
\ir _fixtures.psql
select plan(49);

set local role bayramm_api;

-- ── без актора: только публичное ────────────────────────────────────────────
select pg_temp.as_actor(null);

select is_empty('select id from app.requests', 'без актора заявки не видны');
select is_empty('select id from app.clients', 'без актора клиенты не видны');
select is_empty('select client_id from pii.client_profiles', 'без актора профили клиентов не видны');
select is_empty('select request_id from pii.request_contacts', 'без актора контакты из заявок не видны');
select is_empty('select id from app.request_status_log', 'без актора история статусов не видна');
select is_empty('select id from app.vendor_accounts', 'без актора аккаунты вендоров не видны');
select is_empty('select id from app.vendor_users', 'без актора пользователи вендоров не видны');
select is_empty('select id from app.consents', 'без актора согласия не видны');
select is_empty('select id from app.sessions', 'без актора сессии не видны');
select is_empty('select id from app.staff', 'без актора сотрудники не видны');
select is_empty('select id from app.audit_log', 'без актора журнал не виден');
select set_eq(
  'select id from app.listings',
  array['aaaaaaaa-0000-0000-0000-000000000101', 'bbbbbbbb-0000-0000-0000-000000000101']::uuid[],
  'без актора видны только опубликованные листинги');
select is((select count(*)::int from app.photos), 6, 'без актора видны только фото опубликованных листингов');
select is(
  (select count(*)::int from app.categories), 14, 'справочники публичны');
select is(
  (select count(*)::int from app.requests), 0,
  'select count(*) тоже возвращает ноль заявок');
select throws_ok(
  $$insert into app.audit_log (action, object_type, object_id) values ('test.anon', 'test', 'x')$$,
  '42501', null, 'без актора в журнал не пишется');
select is_empty(
  $$update app.requests set status = 'viewed' returning id$$,
  'без актора заявки не обновляются');

-- ── вендор A ────────────────────────────────────────────────────────────────
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');

select results_eq(
  'select id from app.requests',
  array['eeeeeeee-0000-0000-0000-0000000000a1']::uuid[],
  'вендор A видит только свою заявку');
select is_empty(
  $$select id from app.requests where id = 'eeeeeeee-0000-0000-0000-0000000000b1'$$,
  'заявку вендора B по id вендор A не видит');
select is_empty(
  $$update app.requests set status = 'viewed' where id = 'eeeeeeee-0000-0000-0000-0000000000b1' returning id$$,
  'заявку вендора B вендор A не изменит');
select is_empty(
  $$select request_id from pii.request_contacts where request_id = 'eeeeeeee-0000-0000-0000-0000000000b1'$$,
  'контакты клиента вендора B вендору A не видны');
select results_eq(
  'select id from app.vendor_accounts',
  array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[],
  'вендор видит только свой аккаунт');
select set_eq(
  $$select id from app.listings where vendor_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  array['aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000102']::uuid[],
  'вендор видит и свои черновики');
select is_empty('select id from app.clients', 'вендор не видит таблицу клиентов');
select is_empty('select id from app.otp_codes', 'коды входа видит только система');

-- телефон клиента из своей заявки — через функцию и с записью в журнал
select is(pii.read_request_phone('eeeeeeee-0000-0000-0000-0000000000a1'), '+998000000301',
  'вендор читает телефон клиента своей заявки');
select is(pii.read_request_phone('eeeeeeee-0000-0000-0000-0000000000b1'), null,
  'телефон из чужой заявки — null');
select throws_ok(
  $$select contact_phone from pii.request_contacts$$,
  '42501', null, 'телефон нельзя прочитать SELECT-ом');

-- клиент отзывает согласие — вендор больше не видит контакты
reset role;
select pg_temp.as_actor(null);
insert into app.consents (subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source)
values ('client', 'cccccccc-0000-0000-0000-000000000001', 'request_transfer', 'withdraw',
        'dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101', 'tma');
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select is(pii.read_request_phone('eeeeeeee-0000-0000-0000-0000000000a1'), null,
  'после отзыва согласия телефон вендору не отдаётся');
select is_empty(
  $$select request_id from pii.request_contacts$$,
  'после отзыва согласия имя и комментарий тоже скрыты');

-- ── клиент C2 (заблокирован сотрудником) ────────────────────────────────────
reset role;
select pg_temp.as_actor(null);
update app.clients set blocked_at = now(), blocked_reason = 'тест' where id = 'cccccccc-0000-0000-0000-000000000002';
set local role bayramm_api;
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000002');
select results_eq(
  'select id from app.requests',
  array['eeeeeeee-0000-0000-0000-0000000000b1']::uuid[],
  'клиент видит только свои заявки');
select results_eq(
  'select id from app.clients',
  array['cccccccc-0000-0000-0000-000000000002']::uuid[],
  'клиент видит только себя');
select throws_ok(
  $$update app.clients set blocked_at = null, blocked_reason = null where id = 'cccccccc-0000-0000-0000-000000000002'$$,
  'BR003', 'forbidden_for_actor', 'клиент не снимает с себя блокировку');

-- ── сотрудники: телефоны клиентов — только admin и с причиной ───────────────
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok(
  $$select pii.read_request_phone('eeeeeeee-0000-0000-0000-0000000000b1', 'проверка')$$,
  '42501', null, 'manager не видит телефоны клиентов');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok(
  $$select pii.read_request_phone('eeeeeeee-0000-0000-0000-0000000000b1')$$,
  'BR010', 'reason_required', 'admin раскрывает телефон только с причиной');
select is(pii.read_request_phone('eeeeeeee-0000-0000-0000-0000000000b1', 'жалоба клиента'), '+998000000302',
  'admin с причиной видит телефон');

-- ── журнал доступа ──────────────────────────────────────────────────────────
select results_eq(
  $$select actor_kind::text, subject_kind, subject_id, purpose, reason from app.pii_access_log order by id$$,
  $$values ('vendor_user'::text, 'request_contact'::text, 'eeeeeeee-0000-0000-0000-0000000000a1'::uuid,
            'request_inbox'::text, null::text),
           ('staff', 'request_contact', 'eeeeeeee-0000-0000-0000-0000000000b1'::uuid, 'staff_reveal', 'жалоба клиента')$$,
  'каждое чтение телефона записано; отказы и null не пишутся');

select throws_ok(
  $$insert into app.audit_log (actor_kind, actor_id, action, object_type, object_id)
    values ('system', null, 'test.forged', 'test', 'x')$$,
  '42501', null, 'в журнал нельзя записать действие от чужого имени');
select lives_ok(
  $$insert into app.audit_log (action, object_type, object_id) values ('client.reveal_phone', 'request', 'x')$$,
  'актор журнала берётся из контекста');

-- телефон листинга: опубликованного — всем без журнала; черновика — владельцу с журналом
select pg_temp.as_actor(null);
select is(pii.read_listing_phone('aaaaaaaa-0000-0000-0000-000000000101'), '+998000000999',
  'телефон опубликованного листинга виден гостю до заявки');

reset role;
insert into pii.listing_contacts (listing_id, public_phone) values ('aaaaaaaa-0000-0000-0000-000000000102', '+998000000998');
set local role bayramm_api;
select is(pii.read_listing_phone('aaaaaaaa-0000-0000-0000-000000000102'), null,
  'телефон неопубликованного листинга гостю не отдаётся');
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select is(pii.read_listing_phone('aaaaaaaa-0000-0000-0000-000000000102'), '+998000000998',
  'владелец видит телефон своего черновика');
select results_eq(
  $$select phone from pii.read_vendor_contact_phones('aaaaaaaa-0000-0000-0000-000000000001')$$,
  $$values ('+998000000101'::text)$$,
  'вендор видит свой контактный телефон');
select is_empty(
  $$select phone from pii.read_vendor_contact_phones('bbbbbbbb-0000-0000-0000-000000000001')$$,
  'контактный телефон другого вендора не отдаётся');

-- ── staff без записи в app.staff — не сотрудник ────────────────────────────
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000dead');
select is_empty('select id from app.requests', 'неизвестный staff id не видит заявки');
select is_empty('select id from app.vendor_accounts', 'неизвестный staff id не видит вендоров');

-- ── журнал доступа пополнился чтениями вендора ─────────────────────────────
select pg_temp.as_actor('system');
select set_eq(
  $$select subject_kind || ':' || purpose from app.pii_access_log where actor_kind = 'vendor_user'$$,
  array['request_contact:request_inbox', 'listing_contact:self', 'vendor_contact:self'],
  'чтения вендора записаны в журнал, публичный телефон — нет');

-- ── «удалить аккаунт»: клиент удаляет профиль с ПДн ────────────────────────
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select lives_ok(
  $$delete from pii.client_profiles where client_id = 'cccccccc-0000-0000-0000-000000000001'$$,
  'клиент удаляет свой профиль');
select is_empty(
  $$delete from pii.client_profiles where client_id = 'cccccccc-0000-0000-0000-000000000002' returning client_id$$,
  'чужой профиль клиент не удалит');

select * from finish();
rollback;
