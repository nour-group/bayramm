-- Метрики запуска: ответ площадки (не сотрудника) за 12 часов, доли, медиана, по
-- неделям и по вендорам; кто может их читать; отчёты команде раз в день и неделю;
-- оповещение об ошибках API не чаще раза в 30 минут; пауза между напоминаниями
-- сотрудника — настройка
begin;
\ir _fixtures.psql
select plan(62);

-- ── структура и права ───────────────────────────────────────────────────────
select has_view('app', 'request_metric_facts', 'факты заявки для метрик');
select ok(not has_table_privilege('bayramm_api', 'app.request_metric_facts', 'SELECT'),
  'факты API не читает: только функции метрик');
select has_table('app', 'api_error_alerts', 'счётчик ошибок API');
select ok(not has_table_privilege('bayramm_api', 'app.api_error_alerts', 'SELECT, INSERT, UPDATE, DELETE'),
  'счётчик ошибок API напрямую недоступен');
select ok(has_function_privilege('bayramm_api', 'app.metrics_period(timestamptz, timestamptz)', 'EXECUTE'),
  'API: метрики за период');
select ok(has_function_privilege('bayramm_api', 'app.metrics_weekly(int)', 'EXECUTE'), 'API: метрики по неделям');
select ok(has_function_privilege('bayramm_api', 'app.metrics_vendors(int, uuid)', 'EXECUTE'),
  'API: метрики по вендорам');
select ok(has_function_privilege('bayramm_api', 'app.metrics_listings(uuid, int)', 'EXECUTE'),
  'API: метрики по площадкам');
select ok(has_function_privilege('bayramm_api', 'app.metrics_ops_now()', 'EXECUTE'), 'API: очереди команды');
select ok(has_function_privilege('bayramm_api', 'app.enqueue_ops_reports()', 'EXECUTE'), 'API: отчёты команде');
select ok(has_function_privilege('bayramm_api', 'app.record_api_error(text)', 'EXECUTE'), 'API: ошибка 5xx');
select ok(has_function_privilege('bayramm_api', 'app.ops_reminder_pause()', 'EXECUTE'),
  'API читает паузу между напоминаниями');
select ok(not has_function_privilege('bayramm_api', 'app.assert_metrics_reader()', 'EXECUTE'),
  'служебная проверка API недоступна');

-- ── данные ──────────────────────────────────────────────────────────────────
-- t0 — вторник прошлой недели, 10:00 по Ташкенту: срок всех этих заявок уже вышел.
--   R1  C1 → A1  площадка «связались» через 2 ч                   в срок
--   R2  C2 → A1  площадка отказала через 14 ч (после нарушения)   не в срок
--   R3  C1 → A1  «связались» отметил сотрудник, площадка молчит   не в срок
--   R4  C2 → A1  клиент отозвал через 1 ч, площадка не успела      не в расчёте
--   R5  C1 → B1  тишина, срок нарушен                              не в срок
--   R6  C2 → B1  площадка ответила через 6 ч, договорились         в срок
--   R7  C1 → A1  сначала сотрудник (1 ч), потом площадка — deal (5 ч)  в срок
-- Текущая неделя: R9 C2 → A1 — площадка ответила сразу; RA, RB из фикстур — ждут, срок впереди
select (date_trunc('week', now() at time zone 'Asia/Tashkent') - interval '6 days' + interval '10 hours')
       at time zone 'Asia/Tashkent' as t0 \gset

alter table app.requests disable trigger user;
alter table app.request_status_log disable trigger user;

insert into app.requests (id, client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests,
                          source, status, decline_reason, sla_due_at, sla_stage, sla_breached_at,
                          first_response_at, first_response_by, created_at, updated_at)
select v.id::uuid, v.client::uuid, v.listing::uuid, v.vendor::uuid, 'ffffffff-0000-0000-0000-0000000000a1', 'toy',
       current_date + 100 + v.n, 100, 'tma', v.status::app.request_status, v.reason::app.decline_reason,
       v.created + interval '12 hours',
       case when v.breached then 3 else 0 end,
       case when v.breached then v.created + interval '12 hours 1 minute' end,
       v.created + v.first_after, v.first_by::app.actor_kind, v.created, v.created
from (values
  (1, '17000000-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001', 'contacted', null,
   :'t0'::timestamptz, interval '2 hours', 'vendor_user', false),
  (2, '17000000-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001', 'declined', 'busy',
   :'t0'::timestamptz, interval '14 hours', 'vendor_user', true),
  (3, '17000000-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001', 'contacted', null,
   :'t0'::timestamptz, interval '1 hour', 'staff', false),
  (4, '17000000-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001', 'withdrawn', null,
   :'t0'::timestamptz, null, null, false),
  (5, '17000000-0000-0000-0000-000000000005', 'cccccccc-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000101', 'bbbbbbbb-0000-0000-0000-000000000001', 'new', null,
   :'t0'::timestamptz, null, null, true),
  (6, '17000000-0000-0000-0000-000000000006', 'cccccccc-0000-0000-0000-000000000002',
   'bbbbbbbb-0000-0000-0000-000000000101', 'bbbbbbbb-0000-0000-0000-000000000001', 'deal', null,
   :'t0'::timestamptz, interval '6 hours', 'vendor_user', false),
  (7, '17000000-0000-0000-0000-000000000007', 'cccccccc-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001', 'deal', null,
   :'t0'::timestamptz, interval '1 hour', 'staff', false),
  (9, '17000000-0000-0000-0000-000000000009', 'cccccccc-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001', 'contacted', null,
   now(), interval '0', 'vendor_user', false)
) v(n, id, client, listing, vendor, status, reason, created, first_after, first_by, breached);

insert into app.request_status_log (request_id, from_status, to_status, actor_kind, source, at)
select v.id::uuid, v.from_status::app.request_status, v.to_status::app.request_status, v.actor::app.actor_kind,
       v.source::app.source, v.at
from (values
  ('17000000-0000-0000-0000-000000000001', 'new', 'contacted', 'vendor_user', 'vendor_cabinet',
   :'t0'::timestamptz + interval '2 hours'),
  ('17000000-0000-0000-0000-000000000002', 'new', 'declined', 'vendor_user', 'vendor_cabinet',
   :'t0'::timestamptz + interval '14 hours'),
  ('17000000-0000-0000-0000-000000000003', 'new', 'contacted', 'staff', 'admin',
   :'t0'::timestamptz + interval '1 hour'),
  ('17000000-0000-0000-0000-000000000004', 'new', 'withdrawn', 'client', 'tma',
   :'t0'::timestamptz + interval '1 hour'),
  ('17000000-0000-0000-0000-000000000006', 'new', 'contacted', 'vendor_user', 'vendor_cabinet',
   :'t0'::timestamptz + interval '6 hours'),
  ('17000000-0000-0000-0000-000000000006', 'contacted', 'deal', 'vendor_user', 'vendor_cabinet',
   :'t0'::timestamptz + interval '1 day'),
  ('17000000-0000-0000-0000-000000000007', 'new', 'contacted', 'staff', 'admin',
   :'t0'::timestamptz + interval '1 hour'),
  ('17000000-0000-0000-0000-000000000007', 'contacted', 'deal', 'vendor_user', 'vendor_cabinet',
   :'t0'::timestamptz + interval '5 hours'),
  ('17000000-0000-0000-0000-000000000009', 'new', 'contacted', 'vendor_user', 'vendor_cabinet', now())
) v(id, from_status, to_status, actor, source, at);

alter table app.requests enable trigger user;
alter table app.request_status_log enable trigger user;

-- недоставленные: два за прошлую неделю, одно — сейчас
insert into app.outbox (kind, recipient_kind, status, attempts, created_at) values
  ('vendor.request_new', 'vendor_user', 'dead', 8, :'t0'::timestamptz),
  ('client.request_status', 'client', 'dead', 1, :'t0'::timestamptz + interval '1 day'),
  ('vendor.request_new', 'vendor_user', 'dead', 8, now());
-- новое фото опубликованной карточки ждёт решения
insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256, sort,
                        no_faces_ack)
values ('aaaaaaaa-0000-0000-0000-000000000101', 'ready', 'pending',
        pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000101'), 'image/webp', 1000, 1600, 1200,
        sha256('metrics-photo'), 9, true);
-- модератор; у администратора a001 есть чат с ботом
insert into app.staff (id, role) values ('00000000-0000-0000-0000-00000000a003', 'moderator');
insert into pii.staff_profiles (staff_id, display_name) values ('00000000-0000-0000-0000-00000000a003', 'Moderator');
update pii.staff_profiles set telegram_chat_id = 7001 where staff_id = '00000000-0000-0000-0000-00000000a001';

-- ════════════════════════════════════════════════════════════════════════════
-- Факты: определения
-- ════════════════════════════════════════════════════════════════════════════
select results_eq(
  $$select request_id::text, answered_in_time, measurable, round(response_minutes)::int, agreed, breached
      from app.request_metric_facts where request_id::text like '17000000-%' order by 1$$,
  $$values ('17000000-0000-0000-0000-000000000001', true,  true,  120,       false, false),
           ('17000000-0000-0000-0000-000000000002', false, true,  840,       false, true),
           ('17000000-0000-0000-0000-000000000003', false, true,  null::int, false, false),
           ('17000000-0000-0000-0000-000000000004', false, false, null::int, false, false),
           ('17000000-0000-0000-0000-000000000005', false, true,  null::int, false, true),
           ('17000000-0000-0000-0000-000000000006', true,  true,  360,       true,  false),
           ('17000000-0000-0000-0000-000000000007', true,  true,  300,       true,  false),
           ('17000000-0000-0000-0000-000000000009', true,  true,  0,         false, false)$$,
  'ответ — только площадки: «связались» сотрудника не в счёт, её ход после него — в счёт; отзыв до срока — не в расчёте');
select results_eq(
  $$select measurable, answered_in_time from app.request_metric_facts
     where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  $$values (false, false)$$,
  'срок впереди и ответа нет — исход неизвестен, в долю не идёт');

-- ════════════════════════════════════════════════════════════════════════════
-- Кто читает
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select throws_ok($$select * from app.metrics_weekly(2)$$, 'BR003', 'forbidden_for_actor', 'клиент метрик не видит');
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok($$select * from app.metrics_vendors(30)$$, 'BR003', 'forbidden_for_actor',
  'партнёр метрик вендоров не видит');
select throws_ok($$select * from app.request_metric_facts$$, '42501', null, 'факты напрямую — нет прав');
select pg_temp.as_actor(null);
select throws_ok($$select * from app.metrics_ops_now()$$, 'BR003', 'forbidden_for_actor', 'без актора — нет');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a003');
select lives_ok($$select * from app.metrics_weekly(2)$$, 'модератор видит метрики');
select throws_ok($$select * from app.metrics_weekly(0)$$, '22023', null, 'недель — от 1');
select throws_ok($$select * from app.metrics_vendors(400)$$, '22023', null, 'дней — не больше 366');
select throws_ok($$select * from app.metrics_period(now(), now() - interval '1 day')$$, '22023', null,
  'период — от раньше к позже');

-- ════════════════════════════════════════════════════════════════════════════
-- По неделям
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select results_eq(
  $$select requests, clients, measurable, answered_in_time, answered_rate, responded, median_response_minutes,
           p90_response_minutes, agreed, agreed_rate, sla_breaches, dead_notifications
      from app.metrics_weekly(2) where not partial$$,
  $$values (7, 2, 6, 3, 50.0, 4, 330, 696, 2, 28.6, 2, 2)$$,
  'прошлая неделя: 7 заявок, в срок 3 из 6, медиана 5 ч 30 мин, договорились 2, нарушений 2');
select results_eq(
  $$select requests, clients, measurable, answered_in_time, answered_rate, median_response_minutes, dead_notifications
      from app.metrics_weekly(2) where partial$$,
  $$values (3, 2, 1, 1, 100.0, 0, 1)$$,
  'текущая неделя — неполная: ждущие ответа в срок не в расчёте');
select results_eq(
  $$select week_start = date_trunc('week', now() at time zone 'Asia/Tashkent')::date,
           week_label = to_char(now() at time zone 'Asia/Tashkent', 'IYYY-"W"IW')
      from app.metrics_weekly(1)$$,
  $$values (true, true)$$,
  'неделя — ISO, с понедельника по Ташкенту');
select is((select count(*)::int from app.metrics_weekly(8)), 8, 'недели без заявок — тоже строками');
select results_eq(
  $$select requests, answered_rate, median_response_minutes from app.metrics_weekly(8) order by week_start limit 1$$,
  $$values (0, null::numeric, null::int)$$,
  'пустая неделя — нули и прочерки, а не деление на ноль');

-- ════════════════════════════════════════════════════════════════════════════
-- По вендорам и площадкам
-- ════════════════════════════════════════════════════════════════════════════
select results_eq(
  $$select vendor_id::text, active_listings, requests, measurable, answered_in_time, answered_rate, responded,
           median_response_minutes, sla_breaches, agreed
      from app.metrics_vendors(30)
     where vendor_id in ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001')
     order by 1$$,
  $$values ('aaaaaaaa-0000-0000-0000-000000000001', 1, 7, 5, 3, 60.0, 4, 210, 1, 1),
           ('bbbbbbbb-0000-0000-0000-000000000001', 1, 3, 2, 1, 50.0, 1, 360, 1, 1)$$,
  'вендоры за 30 дней: заявки, доля ответов в срок, медиана ответа');
select results_eq(
  $$select requests, answered_rate from app.metrics_vendors(1, 'bbbbbbbb-0000-0000-0000-000000000001')$$,
  $$values (1, null::numeric)$$,
  'за последние сутки у вендора B — одна заявка, срок впереди');
select results_eq(
  $$select listing_id::text, listing_status::text, requests, answered_in_time, measurable
      from app.metrics_listings('aaaaaaaa-0000-0000-0000-000000000001', 30)$$,
  $$values ('aaaaaaaa-0000-0000-0000-000000000101', 'active', 7, 3, 5)$$,
  'по площадкам вендора: черновик без заявок не показывается');

-- ════════════════════════════════════════════════════════════════════════════
-- Что ждёт команду
-- ════════════════════════════════════════════════════════════════════════════
select results_eq(
  $$select awaiting, overdue, dead_total, listings_review, revisions_pending, photos_pending from app.metrics_ops_now()$$,
  $$values (3, 1, 3, 0, 0, 1)$$,
  'ждут ответа 3, из них срок вышел у 1; недоставленных 3; новое фото ждёт решения');

-- ════════════════════════════════════════════════════════════════════════════
-- Отчёты команде
-- ════════════════════════════════════════════════════════════════════════════
select throws_ok($$select * from app.enqueue_ops_reports()$$, 'BR003', 'forbidden_for_actor',
  'отчёты ставит только система');
select pg_temp.as_actor('system');
select results_eq(
  $$select daily, weekly from app.enqueue_ops_reports()$$,
  $$select 1, case when extract(isodow from app.tashkent_today()) = 1 then 1 else 0 end$$,
  'сводка — администратору с чатом бота; недельный — по понедельникам');
select results_eq(
  $$select daily, weekly from app.enqueue_ops_reports()$$,
  $$values (0, 0)$$,
  'повтор в тот же день ничего не ставит');
reset role;
select results_eq(
  $$select recipient_id, payload ->> 'day', dedupe_key from app.outbox where kind = 'ops.daily_digest'$$,
  $$select '00000000-0000-0000-0000-00000000a001'::uuid, to_char(app.tashkent_today() - 1, 'YYYY-MM-DD'),
           'ops.daily_digest:' || to_char(app.tashkent_today(), 'YYYY-MM-DD') || ':00000000-0000-0000-0000-00000000a001'$$,
  'сводка за вчера; ключ — сегодняшний день по Ташкенту');
select is_empty(
  $$select id from app.outbox where kind like 'ops.%' and recipient_id = '00000000-0000-0000-0000-00000000a002'$$,
  'менеджеру отчёты не ставятся');
set local role bayramm_api;

-- ════════════════════════════════════════════════════════════════════════════
-- Ошибки API
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok($$select app.record_api_error('GET /health')$$, 'BR003', 'forbidden_for_actor',
  'ошибку API пишет только система');
select pg_temp.as_actor('system');
select throws_ok($$select app.record_api_error('GET /requests/Иван')$$, '22023', null,
  'маршрут — только шаблон печатными ASCII');
select throws_ok($$select app.record_api_error('/requests')$$, '22023', null, 'маршрут — с методом');
select ok(app.record_api_error('GET /staff/requests/:id'), 'первая ошибка — оповещение');
select ok(not app.record_api_error('POST /requests'), 'вторая за полчаса — только счётчик');
select ok(not app.record_api_error('POST /requests'), 'третья — тоже');
reset role;
select results_eq(
  $$select errors, last_route from app.api_error_alerts$$,
  $$values (2, 'POST /requests')$$,
  'с прошлого оповещения — две ошибки, последняя — на POST /requests');
update app.api_error_alerts set last_alert_at = now() - interval '31 minutes';
set local role bayramm_api;
select pg_temp.as_actor('system');
select ok(app.record_api_error('GET /catalog'), 'через 30 минут — снова оповещение');
reset role;
select results_eq(
  $$select recipient_id, payload ->> 'route', (payload ->> 'errors')::int, payload ? 'since'
      from app.outbox where kind = 'ops.api_error' order by created_at, (payload ->> 'errors')::int$$,
  $$values ('00000000-0000-0000-0000-00000000a001'::uuid, 'GET /staff/requests/:id', 1, true),
           ('00000000-0000-0000-0000-00000000a001'::uuid, 'GET /catalog', 3, true)$$,
  'в оповещении — маршрут и сколько ошибок с прошлого оповещения');
select results_eq(
  $$select errors from app.api_error_alerts$$,
  $$values (0)$$,
  'после оповещения счёт начинается заново');

-- ════════════════════════════════════════════════════════════════════════════
-- Пауза между напоминаниями — настройка
-- ════════════════════════════════════════════════════════════════════════════
select ok(not app.setting_value_ok('ops_reminder_pause_minutes', '4'), 'пауза: меньше 5 минут — нет');
select ok(app.setting_value_ok('ops_reminder_pause_minutes', '5'), 'пауза: 5 минут — можно');
select ok(app.setting_value_ok('ops_reminder_pause_minutes', '1440'), 'пауза: сутки — можно');
select ok(not app.setting_value_ok('ops_reminder_pause_minutes', '1441'), 'пауза: больше суток — нет');
select ok(not app.setting_value_ok('ops_reminder_pause_minutes', '"30"'), 'пауза: только число');
select ok(app.setting_value_ok('sla_hours', '12') and not app.setting_value_ok('sla_hours', '73'),
  'прежние границы на месте');
select is(app.ops_reminder_pause(), interval '30 minutes', 'по умолчанию — 30 минут');

-- вендор A привязал Telegram: напоминание дойдёт
update app.vendor_users set tg_user_hash = sha256('tg-7101'), tg_linked_at = now()
 where id = 'aaaaaaaa-0000-0000-0000-000000000011';
update pii.vendor_user_profiles set telegram_user_id = 7101, telegram_chat_id = 7101
 where vendor_user_id = 'aaaaaaaa-0000-0000-0000-000000000011';

set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok($$select app.staff_set_setting('ops_reminder_pause_minutes', '60')$$, 'BR003',
  'forbidden_for_actor', 'настройки меняет только администратор');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok($$select app.staff_set_setting('ops_reminder_pause_minutes', '2')$$, '23514', null,
  'вне границ — нет');
select lives_ok($$select app.staff_set_setting('ops_reminder_pause_minutes', '60')$$, 'администратор ставит час');
select is(app.ops_reminder_pause(), interval '60 minutes', 'пауза — из настройки');
select results_eq(
  $$select detail from app.audit_log where action = 'settings.update' and object_id = 'ops_reminder_pause_minutes'$$,
  $$values ('{"from": 30, "to": 60}'::jsonb)$$,
  'изменение — в журнале');

select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select is(app.staff_remind_vendor('eeeeeeee-0000-0000-0000-0000000000a1'), 1, 'менеджер напоминает вендору');
reset role;
update app.outbox set created_at = now() - interval '31 minutes'
 where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1' and kind = 'vendor.ops_reminder';
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok($$select app.staff_remind_vendor('eeeeeeee-0000-0000-0000-0000000000a1')$$,
  'BR016', 'reminder_too_soon', 'пауза час — через 31 минуту ещё рано');
reset role;
update app.outbox set created_at = now() - interval '61 minutes'
 where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1' and kind = 'vendor.ops_reminder';
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select is(app.staff_remind_vendor('eeeeeeee-0000-0000-0000-0000000000a1'), 1, 'через час — можно снова');

select * from finish();
rollback;
