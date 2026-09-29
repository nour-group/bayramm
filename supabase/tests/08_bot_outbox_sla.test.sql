-- Бот и уведомления: привязка вендора по контакту, /start, постановка в outbox
-- триггерами, этапы SLA, оповещения о недоставленном; права bayramm_api
begin;
\ir _fixtures.psql
select plan(60);

-- ── права ───────────────────────────────────────────────────────────────────
select has_table('app', 'telegram_updates', 'обработанные update_id вебхука');
select ok(has_function_privilege('bayramm_api', 'app.vendor_user_claim_telegram(bytea, text, bytea, bigint, bigint)',
  'EXECUTE'), 'API привязывает вендора через функцию');
select ok(has_function_privilege('bayramm_api', 'app.telegram_started(bytea, bigint)', 'EXECUTE'),
  'API отмечает /start через функцию');
select ok(has_function_privilege('bayramm_api', 'app.sla_advance(uuid, smallint, timestamptz)', 'EXECUTE'),
  'API двигает этапы SLA через функцию');
select ok(has_function_privilege('bayramm_api', 'app.client_notifiable(uuid)', 'EXECUTE'),
  'API проверяет при отправке, можно ли писать клиенту');
select ok(not has_function_privilege('bayramm_api', 'app.enqueue_vendor_notice(uuid, text, jsonb, text)', 'EXECUTE'),
  'уведомления вендору ставят только триггеры и функции базы');
select ok(not has_function_privilege('bayramm_api', 'app.enqueue_client_notice(uuid, text, jsonb, text, timestamptz)',
  'EXECUTE'), 'уведомления клиенту ставят только триггеры и функции базы');
select ok(not has_function_privilege('bayramm_api', 'app.enqueue_ops_alert(text, jsonb, text, uuid)', 'EXECUTE'),
  'оповещения команды ставят только триггеры и функции базы');
select ok(not has_table_privilege('bayramm_api', 'app.telegram_updates', 'UPDATE'), 'update_id не правятся');

-- ── подготовка ──────────────────────────────────────────────────────────────
--   A: …0011 — владелец (номер sha256('vendor-a')), …0012 — второй пользователь,
--   …0013 — отключённый. Администратор a001 уже вошёл через Telegram (tg-9001)
insert into app.vendor_users (id, vendor_id, phone_hash, role) values
  ('aaaaaaaa-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', sha256('vendor-a2'), 'member');
insert into app.vendor_users (id, vendor_id, phone_hash, disabled_at) values
  ('aaaaaaaa-0000-0000-0000-000000000013', 'aaaaaaaa-0000-0000-0000-000000000001', sha256('vendor-a3'), now());
insert into pii.vendor_user_profiles (vendor_user_id, phone) values
  ('aaaaaaaa-0000-0000-0000-000000000012', '+998000000112');
update app.staff set tg_id_hash = sha256('tg-9001'), tg_linked_at = now()
where id = '00000000-0000-0000-0000-00000000a001';
insert into app.consent_texts (id, purpose, version, locale, body) values
  ('dddddddd-0000-0000-0000-000000000003', 'bot_notifications', 1, 'ru', 'Тестовый текст: уведомления в боте');

set local role bayramm_api;

-- ── привязка вендора по контакту ────────────────────────────────────────────
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$select * from app.vendor_user_claim_telegram(sha256('vendor-a'), '+998000000111', sha256('tg-5001'), 5001, 5001)$$,
  'BR003', 'forbidden_for_actor', 'привязывает только система (вебхук бота)');

select pg_temp.as_actor('system');
select throws_ok(
  $$select * from app.vendor_user_claim_telegram('\x00'::bytea, '+998000000111', sha256('tg-5001'), 5001, 5001)$$,
  '22023', null, 'хэш номера не 32 байта — ошибка вызова');
select throws_ok(
  $$select * from app.vendor_user_claim_telegram(sha256('vendor-a'), '998000000111', sha256('tg-5001'), 5001, 5001)$$,
  '22023', null, 'номер не в виде +998XXXXXXXXX — ошибка вызова');
select results_eq(
  $$select result, vendor_user_id from app.vendor_user_claim_telegram(sha256('nobody'), '+998000000999',
      sha256('tg-5001'), 5001, 5001)$$,
  $$values ('not_found'::text, null::uuid)$$,
  'номера нет среди пользователей вендоров — not_found');
select results_eq(
  $$select result from app.vendor_user_claim_telegram(sha256('vendor-a3'), '+998000000113', sha256('tg-5001'), 5001, 5001)$$,
  $$values ('not_found'::text)$$,
  'отключённый пользователь не привязывается');
select is_empty(
  $$select 1 from app.vendor_users where tg_user_hash = sha256('tg-5001')
    union all select 1 from pii.vendor_user_profiles where telegram_user_id = 5001$$,
  'после отказа ничего не записано');

select results_eq(
  $$select result, vendor_user_id, vendor_id from app.vendor_user_claim_telegram(sha256('vendor-a'), '+998000000111',
      sha256('tg-5001'), 5001, 5001)$$,
  $$values ('claimed'::text, 'aaaaaaaa-0000-0000-0000-000000000011'::uuid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid)$$,
  'свой номер — привязка');
select results_eq(
  $$select u.tg_user_hash = sha256('tg-5001'), u.tg_linked_at is not null, p.telegram_user_id, p.telegram_chat_id
    from app.vendor_users u join pii.vendor_user_profiles p on p.vendor_user_id = u.id
    where u.id = 'aaaaaaaa-0000-0000-0000-000000000011'$$,
  $$values (true, true, 5001::bigint, 5001::bigint)$$,
  'записаны хэш Telegram ID, время привязки, Telegram ID и чат');
select is(
  (select count(*)::int from app.audit_log
   where action = 'vendor_user.telegram_claim' and object_id = 'aaaaaaaa-0000-0000-0000-000000000011'
     and detail = jsonb_build_object('vendor_id', 'aaaaaaaa-0000-0000-0000-000000000001')),
  1, 'привязка — в журнале, без номера и Telegram ID');
select results_eq(
  $$select result from app.vendor_user_claim_telegram(sha256('vendor-a'), '+998000000111', sha256('tg-5001'), 5001, 5001)$$,
  $$values ('linked'::text)$$,
  'повтор тем же аккаунтом — linked, без изменений');
select results_eq(
  $$select result, vendor_user_id from app.vendor_user_claim_telegram(sha256('vendor-a'), '+998000000111',
      sha256('tg-5002'), 5002, 5002)$$,
  $$values ('linked_elsewhere'::text, null::uuid)$$,
  'номер уже привязан к другому аккаунту — отказ');
select results_eq(
  $$select result from app.vendor_user_claim_telegram(sha256('vendor-a2'), '+998000000112', sha256('tg-5001'), 5001, 5001)$$,
  $$values ('telegram_taken'::text)$$,
  'один Telegram — один пользователь вендора');
select is(
  (select tg_user_hash from app.vendor_users where id = 'aaaaaaaa-0000-0000-0000-000000000012'), null,
  'второй пользователь остался непривязанным');
select is(
  (select count(*)::int from app.vendor_users where tg_user_hash = sha256('tg-5002')), 0,
  'чужой аккаунт не привязан');

reset role;
select throws_ok(
  $$update app.vendor_users set tg_user_hash = sha256('tg-5002') where id = 'aaaaaaaa-0000-0000-0000-000000000011'$$,
  'BR006', 'immutable_column', 'привязку нельзя перевесить на другой аккаунт даже в обход функции');
select throws_ok(
  $$update app.vendor_users set tg_user_hash = sha256('tg-5003') where id = 'aaaaaaaa-0000-0000-0000-000000000012'$$,
  '23514', null, 'хэш Telegram без времени привязки не бывает');
set local role bayramm_api;

-- ── /start ──────────────────────────────────────────────────────────────────
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select throws_ok(
  $$select * from app.telegram_started(sha256('client-1'), 1000001)$$,
  'BR003', 'forbidden_for_actor', '/start отмечает только система');

select pg_temp.as_actor('system');
select results_eq(
  $$select staff, vendor from app.telegram_started(sha256('client-1'), 1000001)$$,
  $$values (false, false)$$,
  'клиент — не сотрудник и не вендор');
select ok((select can_message from app.clients where id = 'cccccccc-0000-0000-0000-000000000001'),
  'клиент написал боту — боту можно ему писать');
select results_eq(
  $$select staff, vendor from app.telegram_started(sha256('tg-9001'), 9001)$$,
  $$values (true, false)$$,
  'действующий сотрудник');
select is((select telegram_chat_id from pii.staff_profiles where staff_id = '00000000-0000-0000-0000-00000000a001'),
  9001::bigint, 'чат сотрудника — для оповещений команды');
select results_eq(
  $$select staff, vendor from app.telegram_started(sha256('tg-5001'), 5001)$$,
  $$values (false, true)$$,
  'привязанный пользователь вендора');
select results_eq(
  $$select staff, vendor from app.telegram_started(sha256('stranger'), 42)$$,
  $$values (false, false)$$,
  'незнакомец — никого не создаём');

-- ── новая заявка → вендору ──────────────────────────────────────────────────
-- Клиент C2 отправляет заявку в A1 под своим актором: у него нет доступа к
-- пользователям вендора, уведомление ставит триггер базы
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000002');
insert into app.consents (id, subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source) values
  ('ffffffff-0000-0000-0000-0000000000c2', 'client', 'cccccccc-0000-0000-0000-000000000002', 'request_transfer',
   'grant', 'dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101', 'tma');
insert into app.requests (id, client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
values ('eeeeeeee-0000-0000-0000-0000000000c2', 'cccccccc-0000-0000-0000-000000000002',
        'aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001',
        'ffffffff-0000-0000-0000-0000000000c2', 'toy', current_date + 90, 150, 'tma');
select is_empty('select 1 from app.outbox', 'клиент очередь уведомлений не видит');

select pg_temp.as_actor('system');
select results_eq(
  $$select kind, recipient_kind::text, recipient_id, status::text, payload, dedupe_key
    from app.outbox where request_id = 'eeeeeeee-0000-0000-0000-0000000000c2'$$,
  $$values ('vendor.request_new'::text, 'vendor_user'::text, 'aaaaaaaa-0000-0000-0000-000000000011'::uuid,
            'pending'::text, '{"request_id": "eeeeeeee-0000-0000-0000-0000000000c2"}'::jsonb,
            'vendor.request_new:eeeeeeee-0000-0000-0000-0000000000c2:aaaaaaaa-0000-0000-0000-000000000011'::text)$$,
  'новая заявка — привязанному пользователю вендора (непривязанному и отключённому — нет); в payload только id');

-- ── статусы → клиенту, только с согласием ───────────────────────────────────
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000c2';
select pg_temp.as_actor('system');
select is_empty(
  $$select 1 from app.outbox where request_id = 'eeeeeeee-0000-0000-0000-0000000000c2' and kind like 'client.%'$$,
  'без согласия на уведомления в боте клиенту не пишем');

select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000002');
insert into app.consents (subject_kind, subject_id, purpose, action, text_id, source) values
  ('client', 'cccccccc-0000-0000-0000-000000000002', 'bot_notifications', 'grant',
   'dddddddd-0000-0000-0000-000000000003', 'tma');
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
update app.requests set status = 'deal' where id = 'eeeeeeee-0000-0000-0000-0000000000c2';
select pg_temp.as_actor('system');
select is_empty(
  $$select 1 from app.outbox where request_id = 'eeeeeeee-0000-0000-0000-0000000000c2' and kind like 'client.%'$$,
  'согласие есть, но боту писать нельзя (клиент не открывал бота) — не пишем');

select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000002');
update app.clients set can_message = true where id = 'cccccccc-0000-0000-0000-000000000002';
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
-- deal → contacted («вернуть в активные») → deal → contacted → declined
update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000c2';
update app.requests set status = 'deal' where id = 'eeeeeeee-0000-0000-0000-0000000000c2';
update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000c2';
update app.requests set status = 'declined', decline_reason = 'busy' where id = 'eeeeeeee-0000-0000-0000-0000000000c2';
select pg_temp.as_actor('system');
select results_eq(
  $$select recipient_kind::text, recipient_id, payload->>'status'
    from app.outbox where request_id = 'eeeeeeee-0000-0000-0000-0000000000c2' and kind = 'client.request_status'
    order by split_part(dedupe_key, ':', 2)::bigint$$,
  $$values ('client'::text, 'cccccccc-0000-0000-0000-000000000002'::uuid, 'deal'::text),
           ('client', 'cccccccc-0000-0000-0000-000000000002'::uuid, 'declined')$$,
  'клиенту — «договорились» и отказ; «вернуть в активные» — не ответ, не пишем');

select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000002');
insert into app.consents (subject_kind, subject_id, purpose, action, text_id, source) values
  ('client', 'cccccccc-0000-0000-0000-000000000002', 'bot_notifications', 'withdraw',
   'dddddddd-0000-0000-0000-000000000003', 'tma');
select pg_temp.as_actor('system');
select ok(not app.client_notifiable('cccccccc-0000-0000-0000-000000000002'),
  'отозвал согласие — писать нельзя (проверяется и при отправке)');

-- ── SLA ─────────────────────────────────────────────────────────────────────
-- RA: C1 → A1, без ответа. C1 разрешил уведомления
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
insert into app.consents (subject_kind, subject_id, purpose, action, text_id, source) values
  ('client', 'cccccccc-0000-0000-0000-000000000001', 'bot_notifications', 'grant',
   'dddddddd-0000-0000-0000-000000000003', 'tma');

select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$select app.sla_advance('eeeeeeee-0000-0000-0000-0000000000a1', 1::smallint)$$,
  'BR003', 'forbidden_for_actor', 'этапы SLA двигает только система');

select pg_temp.as_actor('system');
select throws_ok(
  $$select app.sla_advance('eeeeeeee-0000-0000-0000-0000000000a1', 4::smallint)$$,
  '22023', null, 'этапов только три');
select ok(app.sla_advance('eeeeeeee-0000-0000-0000-0000000000a1', 1::smallint), 'этап 1');
select ok(not app.sla_advance('eeeeeeee-0000-0000-0000-0000000000a1', 1::smallint), 'повтор этапа ничего не делает');
select results_eq(
  $$select kind, recipient_id, payload from app.outbox where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  $$values ('vendor.sla_reminder'::text, 'aaaaaaaa-0000-0000-0000-000000000011'::uuid,
            '{"request_id": "eeeeeeee-0000-0000-0000-0000000000a1", "stage": 1}'::jsonb)$$,
  'напоминание — привязанному пользователю вендора, одно');
select ok(not app.sla_advance('eeeeeeee-0000-0000-0000-0000000000a1', 3::smallint), 'до срока просрочки нет');
select ok(app.sla_advance('eeeeeeee-0000-0000-0000-0000000000a1', 2::smallint), 'этап 2');
select ok(not app.sla_advance('eeeeeeee-0000-0000-0000-0000000000a1', 1::smallint), 'этап назад не сдвигается');

-- срок вышел (sla_due_at неизменяем — сдвигаем в обход триггера, только в тесте)
reset role;
alter table app.requests disable trigger requests_before_update;
update app.requests set sla_due_at = now() - interval '1 minute' where id = 'eeeeeeee-0000-0000-0000-0000000000a1';
alter table app.requests enable trigger requests_before_update;
set local role bayramm_api;
select pg_temp.as_actor('system');

select ok(app.sla_advance('eeeeeeee-0000-0000-0000-0000000000a1', 3::smallint, now() + interval '5 hours'),
  'этап 3: просрочка');
select results_eq(
  $$select sla_stage::int, sla_breached_at is not null, status::text from app.requests
    where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  $$values (3, true, 'new'::text)$$,
  'просрочка отмечена, статус заявки не меняется — клиенту только предлагаем похожие');
select results_eq(
  $$select kind, recipient_kind::text, recipient_id from app.outbox
    where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1' and kind in ('client.sla_breach', 'ops.sla_breach')
    order by kind$$,
  $$values ('client.sla_breach'::text, 'client'::text, 'cccccccc-0000-0000-0000-000000000001'::uuid),
           ('ops.sla_breach', 'staff', '00000000-0000-0000-0000-00000000a001'::uuid)$$,
  'клиенту — предложение, администратору с чатом — оповещение (менеджеру — нет)');
select ok(
  (select next_attempt_at > now() + interval '4 hours' from app.outbox
   where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1' and kind = 'client.sla_breach'),
  'клиенту — не раньше, чем решил API (конец тихих часов)');
select ok(not app.sla_advance('eeeeeeee-0000-0000-0000-0000000000a1', 3::smallint), 'повтор просрочки ничего не ставит');
select ok(not app.sla_advance('eeeeeeee-0000-0000-0000-0000000000c2', 1::smallint), 'у заявки с ответом этапов нет');

-- ── недоставленное → администраторам ────────────────────────────────────────
update app.outbox set status = 'dead', last_error = 'api 403: Forbidden'
where request_id = 'eeeeeeee-0000-0000-0000-0000000000c2' and kind = 'vendor.request_new';
select results_eq(
  $$select recipient_id, payload->>'kind' from app.outbox where kind = 'ops.outbox_dead'$$,
  $$values ('00000000-0000-0000-0000-00000000a001'::uuid, 'vendor.request_new'::text)$$,
  'уведомление не доставлено — оповещение администратору');
update app.outbox set status = 'dead' where kind like 'ops.%';
select is((select count(*)::int from app.outbox where kind = 'ops.outbox_dead'), 1,
  'недоставленное оповещение команды новых оповещений не порождает');

-- ── без ПДн ─────────────────────────────────────────────────────────────────
select is_empty(
  $$select id from app.outbox
    where exists (select 1 from jsonb_object_keys(payload) k
                  where k not in ('request_id', 'status', 'stage', 'outbox_id', 'kind'))$$,
  'в payload только id и коды');
select is_empty(
  $$select id from app.outbox where payload::text ~ '998[0-9]{9}|Client|Person|Test'$$,
  'в payload нет телефонов, имён и названий');

-- ── RLS ─────────────────────────────────────────────────────────────────────
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select is_empty('select 1 from app.outbox', 'вендор очередь уведомлений не видит');
select throws_ok($$insert into app.telegram_updates (update_id) values (1)$$, '42501', null,
  'update_id пишет только система');
select pg_temp.as_actor('system');
select lives_ok($$insert into app.telegram_updates (update_id) values (1)$$, 'система отмечает обработанное обновление');
select is((select count(*)::int from app.telegram_updates where update_id = 1), 1, 'и видит его');

select * from finish();
rollback;
