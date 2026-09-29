-- Кабинет вендора: сессии кабинета, календарь занятости, отказ «занято»
begin;
\ir _fixtures.psql
select plan(30);

-- ── сессии кабинета ─────────────────────────────────────────────────────────
-- Сессия — аккаунта: пользователь вендора сначала привязан к аккаунту (контакт в боте)
set local role bayramm_api;
select pg_temp.as_actor('system');
select results_eq(
  $$select result from app.vendor_user_claim_telegram(sha256('vendor-a'), '+998000000111', sha256('tg-6001'),
      6001, 6001)$$,
  $$values ('claimed'::text)$$,
  'пользователь вендора привязан к аккаунту');
select pg_temp.as_actor(null);
reset role;

select lives_ok(
  $$insert into app.sessions (token_hash, vendor_user_id, via, expires_at)
    values (sha256('vendor-session-1'), 'aaaaaaaa-0000-0000-0000-000000000011', 'tg_partner', now() + interval '12 hours')$$,
  'сессия кабинета: пользователь вендора, via tg_partner, 12 часов');
select throws_ok(
  $$insert into app.sessions (token_hash, vendor_user_id, via, expires_at)
    values (sha256('vendor-session-2'), 'aaaaaaaa-0000-0000-0000-000000000011', 'tg_partner', now() + interval '13 hours')$$,
  '23514', null, 'сессия кабинета из Telegram не дольше 12 часов');
select throws_ok(
  $$insert into app.sessions (token_hash, vendor_user_id, via, expires_at)
    values (sha256('vendor-session-3'), 'aaaaaaaa-0000-0000-0000-000000000011', 'tg_client', now() + interval '1 hour')$$,
  '23514', null, 'пользователь вендора не входит как клиент');
select throws_ok(
  $$insert into app.sessions (token_hash, client_id, via, expires_at)
    values (sha256('vendor-session-4'), 'cccccccc-0000-0000-0000-000000000001', 'tg_partner', now() + interval '1 hour')$$,
  '23514', null, 'клиент не получает сессию кабинета');

-- ── календарь: вендор A ─────────────────────────────────────────────────────
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');

select lives_ok(
  $$insert into app.availability (listing_id, day, created_by, created_at)
    values ('aaaaaaaa-0000-0000-0000-000000000101', current_date + 10, gen_random_uuid(), now() - interval '1 year')$$,
  'вендор отмечает свой день занятым');
select results_eq(
  $$select source, created_by, created_at = now() from app.availability
     where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and day = current_date + 10$$,
  $$values ('vendor'::text, 'aaaaaaaa-0000-0000-0000-000000000011'::uuid, true)$$,
  'автора и время отметки ставит база, а не запрос');
select throws_ok(
  $$insert into app.availability (listing_id, day) values ('bbbbbbbb-0000-0000-0000-000000000101', current_date + 10)$$,
  '42501', null, 'чужой листинг вендору не отметить');
select throws_ok(
  $$insert into app.availability (listing_id, day, source)
    values ('aaaaaaaa-0000-0000-0000-000000000101', current_date + 11, 'staff')$$,
  'BR003', 'forbidden_for_actor', 'вендор не ставит отметку от имени сотрудника');
select throws_ok(
  $$insert into app.availability (listing_id, day, source)
    values ('aaaaaaaa-0000-0000-0000-000000000101', current_date + 11, 'request_decline')$$,
  '23514', null, '«отказной» день без заявки не бывает');
select throws_ok(
  $$insert into app.availability (listing_id, day, source, request_id)
    values ('aaaaaaaa-0000-0000-0000-000000000101', current_date + 11, 'request_decline',
            'eeeeeeee-0000-0000-0000-0000000000a1')$$,
  '23514', null, '«отказной» день — только по отказу «занято» и только на дату заявки');
select throws_ok(
  $$update app.availability set source = 'vendor'
     where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and day = current_date + 10$$,
  'BR003', 'forbidden_for_actor', 'отметку не правят — снимают и ставят заново');
select lives_ok(
  $$delete from app.availability where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and day = current_date + 10$$,
  'вендор освобождает свой день');
select is(
  (select count(*)::int from app.availability where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  0, 'день свободен');

-- День, закрытый сотрудником
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select lives_ok(
  $$insert into app.availability (listing_id, day, source)
    values ('aaaaaaaa-0000-0000-0000-000000000101', current_date + 12, 'staff')$$,
  'сотрудник закрывает день листинга');
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$delete from app.availability where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and day = current_date + 12$$,
  'BR003', 'forbidden_for_actor', 'день, закрытый сотрудником, вендор не освобождает');

-- ── отказ «занято» занимает дату ────────────────────────────────────────────
-- RA: C1 → A1 на current_date + 60
select lives_ok(
  $$update app.requests set status = 'declined', decline_reason = 'busy'
     where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'вендор отказывает: занято');
select results_eq(
  $$select day - current_date, source, request_id, created_by from app.availability
     where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and source <> 'staff'$$,
  $$values (60, 'request_decline'::text, 'eeeeeeee-0000-0000-0000-0000000000a1'::uuid,
            'aaaaaaaa-0000-0000-0000-000000000011'::uuid)$$,
  'дата события занята, отметка ссылается на заявку');
select lives_ok(
  $$delete from app.availability where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and day = current_date + 60$$,
  '«отказной» день вендор может освободить');
select lives_ok(
  $$insert into app.availability (listing_id, day, source, request_id)
    values ('aaaaaaaa-0000-0000-0000-000000000101', current_date + 60, 'request_decline',
            'eeeeeeee-0000-0000-0000-0000000000a1')$$,
  'и снова занять по той же заявке');
select lives_ok(
  $$update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  '«Вернуть в активные»');
select is(
  (select count(*)::int from app.availability
    where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and day = current_date + 60),
  0, 'возврат освобождает дату, занятую отказом');

select lives_ok(
  $$update app.requests set status = 'declined', decline_reason = 'price'
     where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'отказ по цене');
select is(
  (select count(*)::int from app.availability
    where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and day = current_date + 60),
  0, 'отказ не «занято» дату не занимает');
select lives_ok(
  $$update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'снова в активных');

-- День уже занят вендором: отказ его не перезаписывает, возврат не освобождает
select lives_ok(
  $$insert into app.availability (listing_id, day) values ('aaaaaaaa-0000-0000-0000-000000000101', current_date + 60)$$,
  'вендор сам отмечает дату занятой');
select lives_ok(
  $$update app.requests set status = 'declined', decline_reason = 'busy'
     where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'отказ «занято» на уже занятую дату');
select lives_ok(
  $$update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'и возврат');
select results_eq(
  $$select source, request_id from app.availability
     where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and day = current_date + 60$$,
  $$values ('vendor'::text, null::uuid)$$,
  'отметка вендора осталась как была');

-- ── вендор B ────────────────────────────────────────────────────────────────
select pg_temp.as_actor('vendor_user', 'bbbbbbbb-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001');
delete from app.availability where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101';
select pg_temp.as_actor('system');
select is(
  (select count(*)::int from app.availability where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  2, 'чужой календарь вендор B не освобождает');

select * from finish();
rollback;
