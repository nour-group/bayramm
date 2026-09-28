-- Заявки: уникальность, машина состояний, журнал статусов, SLA, согласие
begin;
\ir _fixtures.psql
select plan(30);

-- RA: C1 → A1 (new), создана фикстурой
select is(
  (select sla_due_at - created_at from app.requests where id = 'eeeeeeee-0000-0000-0000-0000000000a1'),
  interval '12 hours', 'срок ответа — 12 часов от создания');
select results_eq(
  $$select from_status::text, to_status::text, actor_kind::text, source::text
      from app.request_status_log where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  $$values (null::text, 'new'::text, 'system'::text, 'tma'::text)$$,
  'создание заявки записано в журнал статусов');

-- ── создание (роль API, актор — клиент C1) ──────────────────────────────────
set local role bayramm_api;
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');

select throws_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101',
            'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1',
            'toy', current_date + 60, 150, 'tma')$$,
  '23505', null, 'повторная заявка (клиент, листинг, дата) отклоняется');
select lives_ok(
  $$insert into app.requests (id, client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('eeeeeeee-0000-0000-0000-0000000000a2', 'cccccccc-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001',
            'ffffffff-0000-0000-0000-0000000000a1', 'toy', current_date + 61, 150, 'tma')$$,
  'на другую дату — можно');
select throws_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000101',
            'bbbbbbbb-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1',
            'toy', current_date + 60, 150, 'tma')$$,
  'BR009', 'consent_required', 'согласие на передачу контактов действует только для своего листинга');
select throws_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('cccccccc-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000101',
            'bbbbbbbb-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000b1',
            'toy', current_date + 90, 150, 'tma')$$,
  '42501', null, 'клиент не создаёт заявку от имени другого клиента');
select throws_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source, status)
    values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101',
            'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1',
            'toy', current_date + 62, 150, 'tma', 'deal')$$,
  'BR002', 'illegal_transition', 'заявка создаётся только в статусе new');

-- ── переходы: клиент ────────────────────────────────────────────────────────
select throws_ok(
  $$update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'BR002', 'illegal_transition', 'клиент не может отметить «связался»');
select lives_ok(
  $$update app.requests set status = 'withdrawn' where id = 'eeeeeeee-0000-0000-0000-0000000000a2'$$,
  'клиент отзывает свою заявку');
select lives_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101',
            'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1',
            'toy', current_date + 61, 150, 'tma')$$,
  'после отзыва можно подать заявку на ту же дату заново');

-- ── переходы: вендор A ──────────────────────────────────────────────────────
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');

select throws_ok(
  $$update app.requests set status = 'deal' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'BR002', 'illegal_transition', 'new → deal запрещён');
select throws_ok(
  $$update app.requests set status = 'withdrawn' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'BR002', 'illegal_transition', 'вендор не отзывает заявку за клиента');
select throws_ok(
  $$update app.requests set status = 'expired' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'BR002', 'illegal_transition', 'истечение ставит только система');
select throws_ok(
  $$update app.requests set sla_stage = 3 where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'BR003', 'forbidden_for_actor', 'этапы SLA двигает только система');
select throws_ok(
  $$update app.requests set event_date = current_date + 5 where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  '42501', null, 'данные заявки API не меняет');

select lives_ok(
  $$update app.requests set status = 'viewed' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'new → viewed');
select throws_ok(
  $$update app.requests set status = 'declined' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  '23514', null, 'отказ без причины запрещён');
select lives_ok(
  $$update app.requests set status = 'declined', decline_reason = 'busy', decline_note = 'дата занята'
     where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'viewed → declined с причиной');
select lives_ok(
  $$update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  '«Вернуть в активные»: declined → contacted');
select lives_ok(
  $$update app.requests set status = 'deal' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'contacted → deal');

reset role;
select pg_temp.as_actor(null);

select is(
  (select decline_reason from app.requests where id = 'eeeeeeee-0000-0000-0000-0000000000a1'), null,
  'причина отказа очищается при возврате');
select isnt(
  (select first_response_at from app.requests where id = 'eeeeeeee-0000-0000-0000-0000000000a1'),
  null, 'отказ считается ответом: first_response_at проставлен');
select is(
  (select first_response_by::text from app.requests where id = 'eeeeeeee-0000-0000-0000-0000000000a1'),
  'vendor_user', 'первый ответ засчитан вендору и не сбрасывается «возвратом»');
select results_eq(
  $$select from_status::text, to_status::text, actor_kind::text, actor_id, source::text, reason
      from app.request_status_log where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1' order by id$$,
  $$values (null::text, 'new'::text, 'system'::text, null::uuid, 'tma'::text, null::text),
           ('new', 'viewed', 'vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011'::uuid, 'vendor_cabinet', null),
           ('viewed', 'declined', 'vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011'::uuid, 'vendor_cabinet', 'дата занята'),
           ('declined', 'contacted', 'vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011'::uuid, 'vendor_cabinet', null),
           ('contacted', 'deal', 'vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011'::uuid, 'vendor_cabinet', null)$$,
  'каждый переход записан с актором и источником');

-- ── оператор и система ──────────────────────────────────────────────────────
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok(
  $$update app.requests set status = 'declined', decline_reason = 'other' where id = 'eeeeeeee-0000-0000-0000-0000000000b1'$$,
  'BR002', 'illegal_transition', 'оператор не отказывает за вендора');
select lives_ok(
  $$update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000b1'$$,
  'оператор может отметить «связался» (ручной режим)');
select is(
  (select first_response_by::text from app.requests where id = 'eeeeeeee-0000-0000-0000-0000000000b1'),
  'staff', 'отметка оператора не засчитывается вендору');
select pg_temp.as_actor('system');
select lives_ok(
  $$update app.requests set status = 'expired' where id = 'eeeeeeee-0000-0000-0000-0000000000b1'$$,
  'система переводит просроченную заявку в expired');

-- ── ограничения на создание ─────────────────────────────────────────────────
select pg_temp.as_actor(null);
select throws_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000102',
            'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1',
            'toy', current_date + 60, 150, 'tma')$$,
  'BR007', 'listing_not_active', 'на неопубликованный листинг заявку не подать');
update app.clients set blocked_at = now(), blocked_reason = 'тест' where id = 'cccccccc-0000-0000-0000-000000000001';
select throws_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101',
            'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1',
            'toy', current_date + 70, 150, 'tma')$$,
  'BR008', 'client_blocked', 'заблокированный клиент не подаёт заявки');

select * from finish();
rollback;
