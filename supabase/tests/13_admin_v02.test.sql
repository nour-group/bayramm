-- Панель оператора v0.2: заметки к заявкам, «напомнить вендору», отметка
-- «связались» сотрудником, блокировка клиента, повтор уведомления, настройки,
-- команда (не себя и не последнего администратора), журнал решений по ревизиям
begin;
\ir _fixtures.psql
select plan(86);

-- ── структура и права ───────────────────────────────────────────────────────
select has_table('app', 'request_notes', 'заметки сотрудников к заявкам');
select ok(has_table_privilege('bayramm_api', 'app.request_notes', 'SELECT, INSERT'), 'API читает и добавляет заметки');
select ok(not has_table_privilege('bayramm_api', 'app.request_notes', 'UPDATE'), 'заметки: нет UPDATE');
select ok(not has_table_privilege('bayramm_api', 'app.request_notes', 'DELETE'), 'заметки: нет DELETE');
select ok(has_function_privilege('bayramm_api', 'app.staff_remind_vendor(uuid)', 'EXECUTE'),
  'API напоминает вендору через функцию');
select ok(has_function_privilege('bayramm_api', 'app.staff_set_setting(text, jsonb)', 'EXECUTE'),
  'API меняет настройки через функцию');
select ok(has_function_privilege('bayramm_api', 'app.staff_invite(text, text, app.staff_role)', 'EXECUTE'),
  'API приглашает сотрудников через функцию');
select ok(not has_function_privilege('bayramm_api', 'app.assert_staff_role(app.staff_role[])', 'EXECUTE'),
  'служебная проверка роли API недоступна');
select ok(not has_function_privilege('bayramm_api', 'app.staff_keep_admin()', 'EXECUTE'),
  'триггерная функция API недоступна');
select ok(not has_table_privilege('bayramm_api', 'app.settings', 'UPDATE'),
  'настройки API меняет только через функцию');

-- ── подготовка ──────────────────────────────────────────────────────────────
--   a003 — модератор; вендор A привязал Telegram (пользователь …0011, чат 6001),
--   вендор B — нет; у менеджера a002 есть живая сессия
insert into app.staff (id, role) values ('00000000-0000-0000-0000-00000000a003', 'moderator');
insert into pii.staff_profiles (staff_id, display_name) values ('00000000-0000-0000-0000-00000000a003', 'Moderator');
update app.vendor_users set tg_user_hash = sha256('tg-6001'), tg_linked_at = now()
 where id = 'aaaaaaaa-0000-0000-0000-000000000011';
update pii.vendor_user_profiles set telegram_user_id = 6001, telegram_chat_id = 6001
 where vendor_user_id = 'aaaaaaaa-0000-0000-0000-000000000011';
insert into app.sessions (token_hash, staff_id, via, expires_at)
values (sha256('session-a002'), '00000000-0000-0000-0000-00000000a002', 'tg_staff', now() + interval '1 hour');
insert into app.outbox (id, kind, recipient_kind, status, attempts, last_error)
values ('abababab-0000-0000-0000-000000000001', 'vendor.request_new', 'vendor_user', 'dead', 8, 'api 403: blocked');

set local role bayramm_api;

-- ════════════════════════════════════════════════════════════════════════════
-- Заметки
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select lives_ok(
  $$insert into app.request_notes (request_id, body, author_id)
    values ('eeeeeeee-0000-0000-0000-0000000000a1', 'Вендор обещал перезвонить', '00000000-0000-0000-0000-00000000a001')$$,
  'менеджер добавляет заметку');
select results_eq(
  $$select author_id, body from app.request_notes where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  $$values ('00000000-0000-0000-0000-00000000a002'::uuid, 'Вендор обещал перезвонить')$$,
  'автор — тот, кто пишет, а не тот, кого указали');
select results_eq(
  $$select action, object_type, actor_id from app.audit_log
     where object_id = 'eeeeeeee-0000-0000-0000-0000000000a1' and action = 'request_note.create'$$,
  $$values ('request_note.create', 'request', '00000000-0000-0000-0000-00000000a002'::uuid)$$,
  'заметка — в журнале действий (без текста)');
select is_empty(
  $$select id from app.audit_log where detail::text like '%перезвонить%'$$,
  'текст заметки в журнал не попадает');
select throws_ok(
  $$update app.request_notes set body = 'подмена'$$,
  '42501', null, 'API: заметку не изменить');

select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a003');
select throws_ok(
  $$insert into app.request_notes (request_id, body) values ('eeeeeeee-0000-0000-0000-0000000000a1', 'x')$$,
  'BR003', 'forbidden_for_actor', 'модератор с заявками не работает — заметок не пишет');

select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select is_empty($$select id from app.request_notes$$, 'вендор заметок не видит — даже к своим заявкам');
select throws_ok(
  $$insert into app.request_notes (request_id, body) values ('eeeeeeee-0000-0000-0000-0000000000a1', 'x')$$,
  'BR003', 'forbidden_for_actor', 'вендор заметок не пишет');
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select is_empty($$select id from app.request_notes$$, 'клиент заметок не видит');
select pg_temp.as_actor(null);
select is_empty($$select id from app.request_notes$$, 'без актора — ничего');

reset role;
select throws_ok($$update app.request_notes set body = 'подмена'$$,
  'BR001', 'append_only', 'заметку не изменить даже владельцу');
select throws_ok($$delete from app.request_notes$$,
  'BR001', 'append_only', 'заметку не удалить даже владельцу');
set local role bayramm_api;

-- ════════════════════════════════════════════════════════════════════════════
-- Напомнить вендору
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a003');
select throws_ok(
  $$select app.staff_remind_vendor('eeeeeeee-0000-0000-0000-0000000000a1')$$,
  'BR003', 'forbidden_for_actor', 'модератор не напоминает');

select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select is(app.staff_remind_vendor('eeeeeeee-0000-0000-0000-0000000000a1'), 1,
  'напоминание — одному привязанному пользователю вендора');
select results_eq(
  $$select kind, recipient_kind::text, recipient_id, payload ->> 'staff_id', status::text
      from app.outbox where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1' and kind = 'vendor.ops_reminder'$$,
  $$values ('vendor.ops_reminder', 'vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011'::uuid,
            '00000000-0000-0000-0000-00000000a002', 'pending')$$,
  'в outbox: вид, получатель, кто напомнил — только id');
select results_eq(
  $$select action, actor_id, detail from app.audit_log
     where object_id = 'eeeeeeee-0000-0000-0000-0000000000a1' and action = 'request.remind'$$,
  $$values ('request.remind', '00000000-0000-0000-0000-00000000a002'::uuid, '{"recipients": 1}'::jsonb)$$,
  'напоминание — в журнале');
select throws_ok(
  $$select app.staff_remind_vendor('eeeeeeee-0000-0000-0000-0000000000a1')$$,
  'BR016', 'reminder_too_soon', 'второе напоминание подряд — нельзя');
select throws_ok(
  $$select app.staff_remind_vendor('eeeeeeee-0000-0000-0000-0000000000b1')$$,
  'BR020', 'vendor_unreachable', 'у вендора B никто не привязал Telegram — напомнить нечем');
select is_empty(
  $$select id from app.outbox where request_id = 'eeeeeeee-0000-0000-0000-0000000000b1' and kind = 'vendor.ops_reminder'$$,
  'неудачное напоминание ничего не оставляет');

reset role;
update app.outbox set created_at = now() - interval '31 minutes'
 where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1' and kind = 'vendor.ops_reminder';
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select is(app.staff_remind_vendor('eeeeeeee-0000-0000-0000-0000000000a1'), 1,
  'через 30 минут — можно снова');

-- ════════════════════════════════════════════════════════════════════════════
-- «Связались» — отметка сотрудника, не ответ вендора
-- ════════════════════════════════════════════════════════════════════════════
select lives_ok(
  $$update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'менеджер отмечает «связались»');
select results_eq(
  $$select first_response_by::text, first_response_at is not null from app.requests
     where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  $$values ('staff', true)$$,
  'первый ответ — от сотрудника: в метрику вендора не идёт');
select results_eq(
  $$select actor_kind::text, actor_id, source::text from app.request_status_log
     where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1' order by id desc limit 1$$,
  $$values ('staff', '00000000-0000-0000-0000-00000000a002'::uuid, 'admin')$$,
  'история статусов: сотрудник, из панели');
select results_eq(
  $$select detail -> 'fields', detail ->> 'from', detail ->> 'to' from app.audit_log
     where object_id = 'eeeeeeee-0000-0000-0000-0000000000a1' and action = 'request.update'$$,
  $$values ('["first_response_at", "first_response_by", "status"]'::jsonb, 'new', 'contacted')$$,
  'отметка — в журнале действий: поля и смена статуса');
select throws_ok(
  $$select app.staff_remind_vendor('eeeeeeee-0000-0000-0000-0000000000a1')$$,
  'BR019', 'request_not_awaiting', 'на заявку уже ответили — напоминать незачем');
select throws_ok(
  $$update app.requests set status = 'deal' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'BR002', null, 'итог (договорились) ставит вендор, не сотрудник');

-- ════════════════════════════════════════════════════════════════════════════
-- Блокировка клиента
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a003');
select throws_ok(
  $$select app.staff_block_client('cccccccc-0000-0000-0000-000000000001', 'Спам')$$,
  'BR003', 'forbidden_for_actor', 'модератор клиентов не блокирует');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok(
  $$select app.staff_block_client('cccccccc-0000-0000-0000-000000000001', '   ')$$,
  'BR010', 'reason_required', 'без причины не блокируется');
select lives_ok(
  $$select app.staff_block_client('cccccccc-0000-0000-0000-000000000001', 'Спам заявками')$$,
  'менеджер блокирует с причиной');
select results_eq(
  $$select blocked_at is not null, blocked_reason, blocked_by from app.clients
     where id = 'cccccccc-0000-0000-0000-000000000001'$$,
  $$values (true, 'Спам заявками', '00000000-0000-0000-0000-00000000a002'::uuid)$$,
  'кто, когда и почему заблокировал');
select results_eq(
  $$select action, detail from app.audit_log
     where object_id = 'cccccccc-0000-0000-0000-000000000001' and object_type = 'client'$$,
  $$values ('client.block', '{}'::jsonb)$$,
  'блокировка — в журнале, причина — нет');

select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select throws_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
    values ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000101',
            'bbbbbbbb-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000a1', 'toy',
            current_date + 10, 10, 'tma')$$,
  'BR008', 'client_blocked', 'заблокированный клиент заявку не создаёт');
select throws_ok(
  $$update app.clients set blocked_at = null, blocked_reason = null, blocked_by = null
     where id = 'cccccccc-0000-0000-0000-000000000001'$$,
  'BR003', 'forbidden_for_actor', 'клиент сам блокировку не снимает');

select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select lives_ok($$select app.staff_unblock_client('cccccccc-0000-0000-0000-000000000001')$$, 'снять блокировку');
select lives_ok($$select app.staff_unblock_client('cccccccc-0000-0000-0000-000000000001')$$,
  'снять ещё раз — ничего не меняет');
select results_eq(
  $$select blocked_at, blocked_reason, blocked_by from app.clients where id = 'cccccccc-0000-0000-0000-000000000001'$$,
  $$values (null::timestamptz, null::text, null::uuid)$$,
  'блокировка снята целиком');
select is(
  (select count(*)::int from app.audit_log where object_id = 'cccccccc-0000-0000-0000-000000000001'
     and action = 'client.unblock'),
  1, 'снятие — одна запись в журнале');

-- ════════════════════════════════════════════════════════════════════════════
-- Повтор недоставленного уведомления
-- ════════════════════════════════════════════════════════════════════════════
select throws_ok(
  $$select app.staff_retry_outbox('abababab-0000-0000-0000-000000000001')$$,
  'BR003', 'forbidden_for_actor', 'менеджер недоставленное не повторяет');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select lives_ok($$select app.staff_retry_outbox('abababab-0000-0000-0000-000000000001')$$,
  'администратор ставит недоставленное в очередь заново');
select results_eq(
  $$select status::text, attempts::int, last_error, next_attempt_at <= now() from app.outbox
     where id = 'abababab-0000-0000-0000-000000000001'$$,
  $$values ('pending', 0, null::text, true)$$,
  'снова в очереди: с нуля попыток, сразу');
select throws_ok(
  $$select app.staff_retry_outbox('abababab-0000-0000-0000-000000000001')$$,
  'BR002', null, 'повторить можно только недоставленное');
select results_eq(
  $$select action, detail from app.audit_log where object_id = 'abababab-0000-0000-0000-000000000001'$$,
  $$values ('outbox.retry', '{"kind": "vendor.request_new"}'::jsonb)$$,
  'повтор — в журнале');

-- ════════════════════════════════════════════════════════════════════════════
-- Настройки
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok($$select app.staff_set_setting('sla_hours', '24')$$,
  'BR003', 'forbidden_for_actor', 'настройки меняет только администратор');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok($$select app.staff_set_setting('site_mode', '"on"')$$,
  '22023', null, 'неизвестный ключ — нельзя');
select throws_ok($$select app.staff_set_setting('min_photos', '2')$$,
  '23514', null, 'меньше 3 фото — нельзя: это правило продукта');
select throws_ok($$select app.staff_set_setting('sla_hours', '8')$$,
  '23514', null, 'срок ответа не короче напоминаний (4 и 8 часов)');
select lives_ok($$select app.staff_set_setting('sla_hours', '24')$$, 'срок ответа — 24 часа');
select is(app.setting_int('sla_hours'), 24, 'новое значение действует');
select throws_ok($$select app.staff_set_setting('sla_reminder_hours', '[8, 4]')$$,
  '23514', null, 'напоминания — по возрастанию');
select throws_ok($$select app.staff_set_setting('sla_reminder_hours', '[4, 30]')$$,
  '23514', null, 'напоминание позже срока ответа — нельзя');
select lives_ok($$select app.staff_set_setting('sla_reminder_hours', '[2, 6]')$$, 'напоминания через 2 и 6 часов');
select throws_ok($$select app.staff_set_setting('quiet_hours', '{"from": "25:00", "to": "08:00"}')$$,
  '23514', null, 'тихие часы — время ЧЧ:ММ');
select lives_ok($$select app.staff_set_setting('quiet_hours', '{"from": "23:00", "to": "07:30"}')$$,
  'тихие часы 23:00–07:30');
select lives_ok($$select app.staff_set_setting('min_photos', '5')$$, 'минимум 5 фото');
select throws_ok($$select app.staff_set_setting('max_photos', '4')$$,
  '23514', null, 'максимум не меньше минимума');
select results_eq(
  $$select actor_id, detail from app.audit_log where object_type = 'setting' and object_id = 'sla_hours'$$,
  $$values ('00000000-0000-0000-0000-00000000a001'::uuid, '{"from": 12, "to": 24}'::jsonb)$$,
  'изменение настройки — в журнале: было и стало');
select results_eq(
  $$select updated_by from app.settings where key = 'sla_hours'$$,
  $$values ('00000000-0000-0000-0000-00000000a001'::uuid)$$,
  'кто изменил — в самой настройке');

-- ════════════════════════════════════════════════════════════════════════════
-- Команда
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok($$select app.staff_invite('new_person', 'New Person', 'moderator')$$,
  'BR003', 'forbidden_for_actor', 'приглашает только администратор');

select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select lives_ok($$select app.staff_invite('  @New_Person ', 'New Person', 'moderator')$$,
  'администратор приглашает по имени пользователя Telegram');
select results_eq(
  $$select p.display_name, s.role::text, s.active, s.tg_id_hash is null
      from pii.staff_profiles p join app.staff s on s.id = p.staff_id where p.telegram_username = 'new_person'$$,
  $$values ('New Person', 'moderator', true, true)$$,
  'приглашение: имя без «@» в нижнем регистре, роль, ещё не привязано');
select results_eq(
  $$select a.detail from app.audit_log a join pii.staff_profiles p on p.staff_id::text = a.object_id
     where a.action = 'staff.invite' and p.telegram_username = 'new_person'$$,
  $$values ('{"role": "moderator"}'::jsonb)$$,
  'приглашение — в журнале: роль, без имени');
select throws_ok($$select app.staff_invite('NEW_PERSON', 'Twin', 'manager')$$,
  '23505', null, 'имя пользователя уже у действующего сотрудника');
select throws_ok($$select app.staff_invite('ab', 'Short', 'manager')$$,
  '23514', null, 'имя пользователя Telegram — от 5 символов');

select throws_ok($$select app.staff_set_active('00000000-0000-0000-0000-00000000a001', false)$$,
  'BR018', 'staff_self', 'себя не отключить');
select throws_ok($$select app.staff_set_role('00000000-0000-0000-0000-00000000a001', 'manager')$$,
  'BR018', 'staff_self', 'свою роль не сменить');

select lives_ok($$select app.staff_set_role('00000000-0000-0000-0000-00000000a002', 'moderator')$$,
  'смена роли другого сотрудника');
select results_eq(
  $$select detail from app.audit_log where action = 'staff.role' and object_id = '00000000-0000-0000-0000-00000000a002'$$,
  $$values ('{"from": "manager", "to": "moderator"}'::jsonb)$$,
  'смена роли — в журнале');
select lives_ok($$select app.staff_set_active('00000000-0000-0000-0000-00000000a002', false)$$,
  'отключить другого сотрудника');
select results_eq(
  $$select s.active, (select count(*)::int from app.sessions ss
                       where ss.staff_id = s.id and ss.revoked_at is null)
      from app.staff s where s.id = '00000000-0000-0000-0000-00000000a002'$$,
  $$values (false, 0)$$,
  'отключён, его сессии отозваны');
select lives_ok($$select app.staff_set_active('00000000-0000-0000-0000-00000000a002', true)$$,
  'включить снова');
select results_eq(
  $$select action from app.audit_log where object_id = '00000000-0000-0000-0000-00000000a002'
      and action in ('staff.deactivate', 'staff.activate') order by id$$,
  $$values ('staff.deactivate'), ('staff.activate')$$,
  'отключение и включение — в журнале');

-- Последний действующий администратор — никаким путём, даже ручным SQL
reset role;
select throws_ok($$update app.staff set active = false where id = '00000000-0000-0000-0000-00000000a001'$$,
  'BR017', 'staff_last_admin', 'последнего администратора не отключить');
select throws_ok($$update app.staff set role = 'manager' where id = '00000000-0000-0000-0000-00000000a001'$$,
  'BR017', 'staff_last_admin', 'последнего администратора не понизить');
-- другой администратор принял приглашение (роль на аккаунте): непринятое замену не даёт
insert into app.accounts (id) values ('acacacac-0000-0000-0000-00000000a004');
insert into app.staff (id, role, account_id)
values ('00000000-0000-0000-0000-00000000a004', 'admin', 'acacacac-0000-0000-0000-00000000a004');
select lives_ok($$update app.staff set active = false where id = '00000000-0000-0000-0000-00000000a001'$$,
  'есть другой администратор — можно');

-- ════════════════════════════════════════════════════════════════════════════
-- Ревизии карточек: решение — в журнале
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
insert into app.listing_revisions (listing_id, payload, base_version)
select id, '{"name": "Test Hall A1 New"}', version from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000101';
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a004');
select lives_ok(
  $$update app.listing_revisions set status = 'declined', decision_reason = 'Название не совпадает с вывеской'
     where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and status = 'pending'$$,
  'сотрудник отклоняет ревизию с причиной');
select results_eq(
  $$select action, actor_id, detail ->> 'from', detail ->> 'to', detail -> 'fields' from app.audit_log
     where object_id = 'aaaaaaaa-0000-0000-0000-000000000101' and action = 'listing_revision.update'$$,
  $$values ('listing_revision.update', '00000000-0000-0000-0000-00000000a004'::uuid, 'pending', 'declined',
            '["decided_at", "decided_by", "decision_reason", "status"]'::jsonb)$$,
  'решение по ревизии — в журнале: кто, какие поля, без текста причины');

select * from finish();
rollback;
