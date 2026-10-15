-- Контакт команды в настройках и отмена «связались» партнёром
-- (20261015120000_team_contact_undo_contacted.sql)
begin;
\ir _fixtures.psql
select plan(22);

-- ── контакт команды ─────────────────────────────────────────────────────────

select results_eq(
  $$select key, value from app.settings where key in ('team_phone', 'team_telegram') order by key$$,
  $$values ('team_phone'::text, '""'::jsonb), ('team_telegram', '""'::jsonb)$$,
  'контакт команды заведён пустым');
select ok(app.setting_value_ok('team_telegram', '"bayramm_team"') and app.setting_value_ok('team_telegram', '""'),
  'Telegram: имя или пусто');
select ok(not app.setting_value_ok('team_telegram', '"@bayramm"') and not app.setting_value_ok('team_telegram', '"ab"')
          and not app.setting_value_ok('team_telegram', '5'),
  'Telegram: без «@», от 5 знаков, только строкой');
select ok(app.setting_value_ok('team_phone', '"+998901112233"') and not app.setting_value_ok('team_phone', '"901112233"'),
  'телефон: +998 и девять цифр');

select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select lives_ok($$select app.staff_set_setting('team_telegram', '"bayramm_team"')$$, 'администратор задаёт Telegram');
select lives_ok($$select app.staff_set_setting('team_phone', '"+998901112233"')$$, 'и телефон');
select is((select value #>> '{}' from app.settings where key = 'team_telegram'), 'bayramm_team', 'сохранено');
select throws_ok($$select app.staff_set_setting('team_phone', '"12345"')$$, '23514', null, 'кривой номер — отказ');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok($$select app.staff_set_setting('team_phone', '""')$$, 'BR003', null, 'менеджер не меняет');

-- ── отмена «связались» ──────────────────────────────────────────────────────

select ok(has_function_privilege('bayramm_api', 'app.vendor_request_undo_contacted(uuid)', 'EXECUTE'),
  'API: отмена отметки');

-- C1 разрешил уведомления в боте: сообщение об отметке партнёра встаёт в очередь
insert into app.consent_texts (id, purpose, version, locale, body) values
  ('dddddddd-0000-0000-0000-000000000034', 'bot_notifications', 99, 'ru', 'Тест: уведомления');
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
update app.clients set can_message = true where id = 'cccccccc-0000-0000-0000-000000000001';
insert into app.consents (subject_kind, subject_id, purpose, action, text_id, source) values
  ('client', 'cccccccc-0000-0000-0000-000000000001', 'bot_notifications', 'grant',
   'dddddddd-0000-0000-0000-000000000034', 'tma');

-- RA: партнёр A открыл заявку и отметил «связались»
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
update app.requests set status = 'viewed' where id = 'eeeeeeee-0000-0000-0000-0000000000a1';
update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000a1';

select ok(
  (select next_attempt_at >= now() + interval '44 seconds' from app.outbox
   where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1' and kind = 'client.request_status'),
  'сообщение клиенту об отметке ждёт дольше окна отмены');

select throws_ok(
  $$update app.requests set status = 'viewed' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'BR002', null, 'обратно прямым UPDATE — нельзя, только отменой');

-- Чужой вендор отменить не может
select pg_temp.as_actor('vendor_user', 'bbbbbbbb-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001');
select throws_ok($$select app.vendor_request_undo_contacted('eeeeeeee-0000-0000-0000-0000000000a1')$$,
  'BR044', null, 'чужая заявка — нечего отменять');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok($$select app.vendor_request_undo_contacted('eeeeeeee-0000-0000-0000-0000000000a1')$$,
  'BR003', null, 'сотрудник — не партнёр');

select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select lives_ok($$select app.vendor_request_undo_contacted('eeeeeeee-0000-0000-0000-0000000000a1')$$,
  'тот же партнёр сразу после отметки — отменяет');
select results_eq(
  $$select status::text, first_response_at is null, first_response_by is null from app.requests
    where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  $$values ('viewed'::text, true, true)$$,
  'заявка снова просмотрена, первого ответа нет — срок ответа идёт');
select is_empty(
  $$select 1 from app.outbox where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1' and kind = 'client.request_status'$$,
  'сообщение клиенту не уйдёт');
select results_eq(
  $$select from_status::text, to_status::text from app.request_status_log
    where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1' order by id desc limit 1$$,
  $$values ('contacted'::text, 'viewed'::text)$$,
  'в истории — шаг отмены');

select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select is((select vendor_response_at from app.request_metric_facts where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1'),
  null, 'в метриках отменённая отметка — не ответ');

select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok($$select app.vendor_request_undo_contacted('eeeeeeee-0000-0000-0000-0000000000a1')$$,
  'BR044', null, 'второй раз — отменять нечего');

-- Ответили снова и договорились: последний шаг — не отметка, отмены нет
update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000a1';
update app.requests set status = 'deal' where id = 'eeeeeeee-0000-0000-0000-0000000000a1';
select throws_ok($$select app.vendor_request_undo_contacted('eeeeeeee-0000-0000-0000-0000000000a1')$$,
  'BR044', null, 'после «договорились» — нет');

-- RB: отметка партнёра B старше 30 секунд (последняя строка журнала с прошлым временем)
select pg_temp.as_actor('vendor_user', 'bbbbbbbb-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001');
update app.requests set status = 'viewed' where id = 'eeeeeeee-0000-0000-0000-0000000000b1';
update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000b1';
insert into app.request_status_log (request_id, from_status, to_status, actor_kind, actor_id, source, at) values
  ('eeeeeeee-0000-0000-0000-0000000000b1', 'viewed', 'contacted', 'vendor_user',
   'bbbbbbbb-0000-0000-0000-000000000011', 'vendor_cabinet', clock_timestamp() - interval '1 minute');
select throws_ok($$select app.vendor_request_undo_contacted('eeeeeeee-0000-0000-0000-0000000000b1')$$,
  'BR044', null, 'окно отмены прошло — нет');

select * from finish();
rollback;
