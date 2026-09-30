-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — метрики запуска, отчёты команде, оповещение об ошибках API и пауза
-- между напоминаниями сотрудника как настройка.
--
-- Метрики. Цель запуска — доказать «клиент отправил заявку, площадка ответила за
-- 12 часов». Определения — одни на всех (панель, отчёты бота) и живут здесь:
-- факты по заявке считает представление app.request_metric_facts, функции
-- app.metrics_* только складывают их. Только числа, без ПДн; вызвать может любой
-- действующий сотрудник и система (отчёты по cron):
--   · ответ площадки — первая запись app.request_status_log от вендора
--     (actor_kind = vendor_user) в статус contacted, deal или declined.
--     Просмотр — не ответ; нажатие на телефон (call_attempt) — не ответ;
--     «связались», отмеченное сотрудником (first_response_by = staff), — не ответ
--     площадки: заявка ждёт её ответа дальше, и её ход после отметки сотрудника
--     (например, contacted → deal) — уже ответ;
--   · ответ в срок — ответ площадки не позже sla_due_at заявки (срок фиксируется
--     при создании: sla_hours, по умолчанию 12 часов);
--   · заявка в расчёте доли ответов в срок (measurable) — исход известен: площадка
--     ответила в срок, или срок уже прошёл. Не в расчёте: срок ещё не прошёл и
--     ответа нет; клиент отозвал заявку (или она истекла) до срока, а площадка не
--     успела ответить — её вины в этом нет;
--   · время ответа — от создания заявки до ответа площадки; медиана и 90-й
--     перцентиль — по заявкам, на которые площадка ответила (без ответа — не в
--     выборке: на них смотрит доля ответов в срок);
--   · договорились — заявка сейчас в статусе deal (его ставит только площадка);
--     доля — от всех заявок периода;
--   · нарушение срока — sla_breached_at: срок вышел без ответа (этап 3 SLA);
--   · недоставленные уведомления — строки outbox в статусе dead, созданные в периоде;
--   · неделя — ISO (с понедельника), день — календарный, оба по Ташкенту; заявка
--     относится к периоду по моменту создания.
--
-- Функции (API вызывает под актором сотрудника или system):
--   app.metrics_period(от, до)             всё сразу за произвольный период;
--   app.metrics_weekly(недель)             по неделям, текущая — первой (неполная);
--   app.metrics_vendors(дней, вендор?)     по вендорам за последние N дней;
--   app.metrics_listings(вендор, дней)     по площадкам вендора;
--   app.metrics_ops_now()                  что ждёт команду сейчас: просрочки без
--                                          ответа, недоставленное, очередь модерации.
--
-- Отчёты команде (бот): app.enqueue_ops_reports() под актором system ставит
-- ежедневную сводку ops.daily_digest (за вчера) и по понедельникам недельный
-- отчёт ops.weekly_report (за прошлую неделю) действующим администраторам с чатом
-- бота (app.enqueue_ops_alert). Ключ дедупликации — день и неделя по Ташкенту:
-- сколько бы раз ни сработал cron, каждый отчёт уходит один раз. В payload — только
-- день или неделя; числа и текст — при отправке.
--
-- Ошибки API: app.record_api_error(маршрут) — каждый ответ 5xx считается в
-- app.api_error_alerts (одна строка: сколько с прошлого оповещения, последний
-- маршрут); оповещение ops.api_error администраторам — не чаще раза в 30 минут, в
-- нём маршрут (шаблон, без id) и число ошибок с прошлого оповещения.
--
-- Настройки: пауза между напоминаниями вендору от сотрудника —
-- ops_reminder_pause_minutes (5–1440, по умолчанию 30), читает её
-- app.ops_reminder_pause() — и база (app.staff_remind_vendor), и API.
--
-- Откат: supabase/rollbacks/20260930220000_launch_metrics.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── индексы для периодов ────────────────────────────────────────────────────
create index requests_created on app.requests (created_at);
create index outbox_dead_created on app.outbox (created_at) where status = 'dead';

-- ════════════════════════════════════════════════════════════════════════════
-- Факты по заявке
-- ════════════════════════════════════════════════════════════════════════════

-- Роль API его не читает (прав нет): только функции app.metrics_* ниже
create view app.request_metric_facts with (security_invoker = true) as
select r.id as request_id,
       r.vendor_id,
       r.listing_id,
       r.client_id,
       r.status,
       r.created_at,
       r.sla_due_at,
       v.vendor_response_at,
       c.closed_at,
       (extract(epoch from (v.vendor_response_at - r.created_at)) / 60)::float8 as response_minutes,
       coalesce(v.vendor_response_at <= r.sla_due_at, false) as answered_in_time,
       coalesce(v.vendor_response_at <= r.sla_due_at, false)
         or (r.sla_due_at <= now()
             and not (v.vendor_response_at is null and c.closed_at is not null and c.closed_at < r.sla_due_at))
         as measurable,
       r.status = 'deal' as agreed,
       r.sla_breached_at is not null as breached
from app.requests r
-- первый ответ площадки: её переход в contacted, deal или declined
left join lateral (
  select min(l.at) as vendor_response_at
  from app.request_status_log l
  where l.request_id = r.id and l.actor_kind = 'vendor_user' and l.to_status in ('contacted', 'deal', 'declined')
) v on true
-- заявку закрыли без площадки: клиент отозвал или истекла дата события
left join lateral (
  select min(l.at) as closed_at
  from app.request_status_log l
  where l.request_id = r.id and l.to_status in ('withdrawn', 'expired')
) c on true;

comment on view app.request_metric_facts is
  'Факты заявки для метрик: ответ площадки (не сотрудника), в срок ли, известен ли исход, договорились, нарушение срока. Без ПДн';

-- Метрики читает любой действующий сотрудник и система (отчёты)
create function app.assert_metrics_reader() returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if app.actor_kind() is distinct from 'system' and app.current_staff_role() is null then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Метрики
-- ════════════════════════════════════════════════════════════════════════════

-- Всё за период [p_from, p_to): заявки — по моменту создания, недоставленные
-- уведомления — по моменту постановки в очередь. Период — не длиннее года.
-- Доли — проценты с одним знаком после запятой; null — не из чего считать
create function app.metrics_period(p_from timestamptz, p_to timestamptz)
returns table (requests int, clients int, measurable int, answered_in_time int, answered_rate numeric,
               responded int, median_response_minutes int, p90_response_minutes int,
               agreed int, agreed_rate numeric, sla_breaches int, dead_notifications int)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_metrics_reader();
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '366 days' then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  return query
  select count(*)::int,
         count(distinct f.client_id)::int,
         (count(*) filter (where f.measurable))::int,
         (count(*) filter (where f.answered_in_time))::int,
         round(100.0 * count(*) filter (where f.answered_in_time)
               / nullif(count(*) filter (where f.measurable), 0), 1),
         count(f.response_minutes)::int,
         round(percentile_cont(0.5) within group (order by f.response_minutes))::int,
         round(percentile_cont(0.9) within group (order by f.response_minutes))::int,
         (count(*) filter (where f.agreed))::int,
         round(100.0 * count(*) filter (where f.agreed) / nullif(count(*), 0), 1),
         (count(*) filter (where f.breached))::int,
         (select count(*) from app.outbox o
          where o.status = 'dead' and o.created_at >= p_from and o.created_at < p_to)::int
  from app.request_metric_facts f
  where f.created_at >= p_from and f.created_at < p_to;
end $$;

comment on function app.metrics_period(timestamptz, timestamptz) is
  'Метрики заявок и уведомлений за период. Сотрудник или система';

-- По ISO-неделям по Ташкенту: p_weeks последних, текущая (неполная) — первой.
-- Недели без заявок — нулями
create function app.metrics_weekly(p_weeks int default 8)
returns table (week_start date, week_label text, partial boolean, requests int, clients int, measurable int,
               answered_in_time int, answered_rate numeric, responded int, median_response_minutes int,
               p90_response_minutes int, agreed int, agreed_rate numeric, sla_breaches int,
               dead_notifications int)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_current date := date_trunc('week', now() at time zone 'Asia/Tashkent')::date;
begin
  perform app.assert_metrics_reader();
  if p_weeks is null or p_weeks not between 1 and 52 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  return query
  select w.day,
         to_char(w.day, 'IYYY-"W"IW'),
         w.day = v_current,
         m.requests, m.clients, m.measurable, m.answered_in_time, m.answered_rate, m.responded,
         m.median_response_minutes, m.p90_response_minutes, m.agreed, m.agreed_rate, m.sla_breaches,
         m.dead_notifications
  from (select v_current - 7 * g as day from generate_series(0, p_weeks - 1) g) w
  cross join lateral app.metrics_period(w.day::timestamp at time zone 'Asia/Tashkent',
                                        (w.day + 7)::timestamp at time zone 'Asia/Tashkent') m
  order by w.day desc;
end $$;

comment on function app.metrics_weekly(int) is
  'Метрики по ISO-неделям (по Ташкенту), текущая — первой. Сотрудник или система';

-- По вендорам за последние p_days дней: вендоры с заявками за период или с
-- опубликованной площадкой (у кого заявок нет — тоже видно). p_vendor — только
-- этот вендор (строка есть, даже если заявок нет)
create function app.metrics_vendors(p_days int default 30, p_vendor uuid default null)
returns table (vendor_id uuid, vendor_code text, vendor_name text, active_listings int, requests int,
               measurable int, answered_in_time int, answered_rate numeric, responded int,
               median_response_minutes int, sla_breaches int, agreed int, last_request_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_metrics_reader();
  if p_days is null or p_days not between 1 and 366 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  return query
  select v.id, v.public_code, v.name,
         (select count(*) from app.listings l where l.vendor_id = v.id and l.status = 'active')::int,
         m.requests, m.measurable, m.answered_in_time,
         round(100.0 * m.answered_in_time / nullif(m.measurable, 0), 1),
         m.responded, m.median_response_minutes, m.sla_breaches, m.agreed, m.last_request_at
  from app.vendor_accounts v
  cross join lateral (
    select count(*)::int as requests,
           (count(*) filter (where f.measurable))::int as measurable,
           (count(*) filter (where f.answered_in_time))::int as answered_in_time,
           count(f.response_minutes)::int as responded,
           round(percentile_cont(0.5) within group (order by f.response_minutes))::int as median_response_minutes,
           (count(*) filter (where f.breached))::int as sla_breaches,
           (count(*) filter (where f.agreed))::int as agreed,
           max(f.created_at) as last_request_at
    from app.request_metric_facts f
    where f.vendor_id = v.id and f.created_at >= now() - make_interval(days => p_days)
  ) m
  where (p_vendor is null or v.id = p_vendor)
    and (p_vendor is not null or m.requests > 0
         or exists (select 1 from app.listings l where l.vendor_id = v.id and l.status = 'active'))
  order by v.public_code;
end $$;

comment on function app.metrics_vendors(int, uuid) is
  'Ответы вендоров за последние N дней: заявки, доля ответов в срок, медиана ответа. Сотрудник или система';

-- По площадкам вендора за последние p_days дней: с заявками за период или
-- опубликованные и приостановленные
create function app.metrics_listings(p_vendor uuid, p_days int default 30)
returns table (listing_id uuid, listing_name text, listing_status app.listing_status, requests int,
               measurable int, answered_in_time int, answered_rate numeric, responded int,
               median_response_minutes int, sla_breaches int, agreed int, last_request_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_metrics_reader();
  if p_vendor is null or p_days is null or p_days not between 1 and 366 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  return query
  select l.id, l.name, l.status,
         m.requests, m.measurable, m.answered_in_time,
         round(100.0 * m.answered_in_time / nullif(m.measurable, 0), 1),
         m.responded, m.median_response_minutes, m.sla_breaches, m.agreed, m.last_request_at
  from app.listings l
  cross join lateral (
    select count(*)::int as requests,
           (count(*) filter (where f.measurable))::int as measurable,
           (count(*) filter (where f.answered_in_time))::int as answered_in_time,
           count(f.response_minutes)::int as responded,
           round(percentile_cont(0.5) within group (order by f.response_minutes))::int as median_response_minutes,
           (count(*) filter (where f.breached))::int as sla_breaches,
           (count(*) filter (where f.agreed))::int as agreed,
           max(f.created_at) as last_request_at
    from app.request_metric_facts f
    where f.listing_id = l.id and f.created_at >= now() - make_interval(days => p_days)
  ) m
  where l.vendor_id = p_vendor and (m.requests > 0 or l.status in ('active', 'suspended'))
  order by l.created_at, l.id;
end $$;

comment on function app.metrics_listings(uuid, int) is
  'Ответы по площадкам вендора за последние N дней. Сотрудник или система';

-- Что ждёт команду сейчас:
--   awaiting          — заявки ждут первого ответа (new, viewed; ответа ещё не было);
--   overdue           — из них срок уже вышел (открытые нарушения срока);
--   dead_total        — недоставленные уведомления (их можно повторить в панели);
--   listings_review   — карточки на проверке;
--   revisions_pending — правки опубликованных карточек ждут решения;
--   photos_pending    — готовые фото опубликованных и приостановленных карточек
--                       ждут решения (фото карточки на проверке решаются вместе с ней)
create function app.metrics_ops_now()
returns table (awaiting int, overdue int, dead_total int, listings_review int, revisions_pending int,
               photos_pending int)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_metrics_reader();
  return query
  select (select count(*) from app.requests r
          where r.status in ('new', 'viewed') and r.first_response_at is null)::int,
         (select count(*) from app.requests r
          where r.status in ('new', 'viewed') and r.first_response_at is null and r.sla_due_at <= now())::int,
         (select count(*) from app.outbox o where o.status = 'dead')::int,
         (select count(*) from app.listings l where l.status = 'review')::int,
         (select count(*) from app.listing_revisions rv where rv.status = 'pending')::int,
         (select count(*) from app.photos p
          join app.listings l on l.id = p.listing_id
          where p.status = 'ready' and p.moderation = 'pending' and p.deleted_at is null
            and l.status in ('active', 'suspended'))::int;
end $$;

comment on function app.metrics_ops_now() is
  'Очереди команды сейчас: заявки без ответа, просрочки, недоставленное, модерация. Сотрудник или система';

-- ════════════════════════════════════════════════════════════════════════════
-- Отчёты команде
-- ════════════════════════════════════════════════════════════════════════════

-- Ежедневная сводка за вчера и (по понедельникам) недельный отчёт за прошлую
-- неделю — действующим администраторам с чатом бота. Время вызова выбирает API
-- (утро по Ташкенту); повтор в тот же день ничего не ставит (ключ — день и неделя).
-- Возвращает, скольким получателям поставлено сейчас
create function app.enqueue_ops_reports()
returns table (daily int, weekly int)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_today  date := app.tashkent_today();
  v_daily  int;
  v_weekly int := 0;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  v_daily := app.enqueue_ops_alert('ops.daily_digest',
    jsonb_build_object('day', to_char(v_today - 1, 'YYYY-MM-DD')), to_char(v_today, 'YYYY-MM-DD'));
  if extract(isodow from v_today) = 1 then
    v_weekly := app.enqueue_ops_alert('ops.weekly_report',
      jsonb_build_object('week', to_char(v_today - 7, 'YYYY-MM-DD')), to_char(v_today - 7, 'IYYY-"W"IW'));
  end if;
  return query select v_daily, v_weekly;
end $$;

comment on function app.enqueue_ops_reports() is
  'Отчёты команде: сводка за вчера, по понедельникам — за прошлую неделю. Раз в день и неделю. Только актор system';

-- ════════════════════════════════════════════════════════════════════════════
-- Ошибки API
-- ════════════════════════════════════════════════════════════════════════════

-- Одна строка: сколько ответов 5xx с прошлого оповещения и когда оно было.
-- Маршрут — шаблон (GET /staff/requests/:id), без id и значений
create table app.api_error_alerts (
  id            smallint primary key default 1 check (id = 1),
  errors        int not null default 0 check (errors >= 0),
  last_route    text check (length(last_route) <= 200),
  last_error_at timestamptz,
  last_alert_at timestamptz
);
comment on table app.api_error_alerts is
  'Ошибки API (5xx) с прошлого оповещения команды и время оповещения: одна строка, без ПДн';

-- Роль API таблицу не видит: только app.record_api_error
alter table app.api_error_alerts enable row level security;

-- Ответ 5xx: посчитать; с прошлого оповещения прошло 30 минут (или его не было) —
-- оповестить администраторов (маршрут и сколько ошибок с прошлого оповещения) и
-- начать счёт заново. Параллельные вызовы идут по очереди (строка блокируется).
-- true — оповещение поставлено
create function app.record_api_error(p_route text) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_state app.api_error_alerts;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if p_route is null or p_route !~ '^[A-Z]{3,7} [!-~]{1,190}$' then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  insert into app.api_error_alerts as s (id, errors, last_route, last_error_at)
  values (1, 1, p_route, now())
  on conflict (id) do update
    set errors = s.errors + 1, last_route = excluded.last_route, last_error_at = excluded.last_error_at
  returning s.* into v_state;

  if v_state.last_alert_at is not null and v_state.last_alert_at > now() - interval '30 minutes' then
    return false;
  end if;

  perform app.enqueue_ops_alert('ops.api_error',
    jsonb_build_object('route', p_route, 'errors', v_state.errors, 'since', v_state.last_alert_at),
    to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDD"T"HH24MISS.US'));
  update app.api_error_alerts s set errors = 0, last_alert_at = now() where s.id = 1;
  return true;
end $$;

comment on function app.record_api_error(text) is
  'Ответ API 5xx: счётчик и оповещение администраторам не чаще раза в 30 минут. Только актор system';

-- ════════════════════════════════════════════════════════════════════════════
-- Настройки: пауза между напоминаниями сотрудника
-- ════════════════════════════════════════════════════════════════════════════

insert into app.settings (key, value) values
  ('ops_reminder_pause_minutes', '30')   -- минут между напоминаниями вендору от сотрудника
on conflict (key) do nothing;

-- Та же функция, что в 20260930180000_admin_v02.sql, плюс ops_reminder_pause_minutes
create or replace function app.setting_value_ok(p_key text, p_value jsonb) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  v_min int;
  v_max int;
begin
  case p_key
    when 'sla_reminder_hours' then
      if jsonb_typeof(p_value) is distinct from 'array' or jsonb_array_length(p_value) > 2 then
        return false;
      end if;
      if exists (select 1 from jsonb_array_elements(p_value) e
                 where jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^[0-9]{1,2}$') then
        return false;
      end if;
      return not exists (select 1 from jsonb_array_elements(p_value) e
                         where (e #>> '{}')::int not between 1 and 72)
         and (jsonb_array_length(p_value) < 2 or (p_value ->> 0)::int < (p_value ->> 1)::int);
    when 'quiet_hours' then
      if jsonb_typeof(p_value) is distinct from 'object' then
        return false;
      end if;
      return (select array_agg(k order by k) from jsonb_object_keys(p_value) k) = array['from', 'to']
         and coalesce(p_value ->> 'from', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         and coalesce(p_value ->> 'to', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
    when 'sla_hours'  then v_min := 1; v_max := 72;
    when 'min_photos' then v_min := 3; v_max := 10;
    when 'max_photos' then v_min := 3; v_max := 30;
    when 'client_requests_per_day' then v_min := 1; v_max := 100;
    when 'request_contact_retention_days' then v_min := 1; v_max := 3650;
    when 'otp_retention_hours' then v_min := 1; v_max := 720;
    when 'session_retention_days' then v_min := 1; v_max := 365;
    when 'ops_reminder_pause_minutes' then v_min := 5; v_max := 1440;
    else return true;
  end case;
  if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}') !~ '^[0-9]+$' then
    return false;
  end if;
  return (p_value #>> '{}')::int between v_min and v_max;
end $$;

-- Пауза между напоминаниями вендору от сотрудника — одна на базу и API
create function app.ops_reminder_pause() returns interval
language sql stable set search_path = ''
as $$ select make_interval(mins => coalesce(app.setting_int('ops_reminder_pause_minutes'), 30)) $$;

comment on function app.ops_reminder_pause() is
  'Пауза между напоминаниями вендору от сотрудника (настройка ops_reminder_pause_minutes)';

-- Та же функция, что в 20260930180000_admin_v02.sql, плюс ops_reminder_pause_minutes
create or replace function app.staff_set_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_old       jsonb;
  v_sla       int;
  v_reminders jsonb;
  v_min       int;
  v_max       int;
begin
  perform app.assert_staff_role(array['admin']::app.staff_role[]);
  if p_key is null or p_key <> all (array[
       'sla_hours', 'sla_reminder_hours', 'quiet_hours', 'min_photos', 'max_photos', 'client_requests_per_day',
       'request_contact_retention_days', 'otp_retention_hours', 'session_retention_days',
       'ops_reminder_pause_minutes']) then
    raise exception 'invalid_argument' using errcode = '22023', detail = 'эта настройка меняется только миграцией';
  end if;
  if p_value is null or not app.setting_value_ok(p_key, p_value) then
    raise exception 'invalid_setting' using errcode = '23514', detail = p_key;
  end if;

  -- согласованность ключей проверяется под одной блокировкой: две правки разных
  -- ключей не разойдутся
  perform pg_advisory_xact_lock(hashtextextended('bayramm.settings', 0));
  select s.value into v_old from app.settings s where s.key = p_key for update;
  if not found then
    raise exception 'invalid_argument' using errcode = '22023', detail = 'нет такой настройки';
  end if;

  v_sla := case when p_key = 'sla_hours' then (p_value #>> '{}')::int else app.setting_int('sla_hours') end;
  v_reminders := case when p_key = 'sla_reminder_hours' then p_value
                      else (select s.value from app.settings s where s.key = 'sla_reminder_hours') end;
  if jsonb_typeof(v_reminders) = 'array' and exists (
       select 1 from jsonb_array_elements(v_reminders) e
       where jsonb_typeof(e) = 'number' and (e #>> '{}')::numeric >= v_sla) then
    raise exception 'invalid_setting' using errcode = '23514', detail = p_key;
  end if;

  v_min := case when p_key = 'min_photos' then (p_value #>> '{}')::int else app.setting_int('min_photos') end;
  v_max := case when p_key = 'max_photos' then (p_value #>> '{}')::int else app.setting_int('max_photos') end;
  if v_min > v_max then
    raise exception 'invalid_setting' using errcode = '23514', detail = p_key;
  end if;

  if v_old = p_value then
    return;
  end if;
  update app.settings s set value = p_value, updated_at = now(), updated_by = app.actor_id()
  where s.key = p_key;
  -- значения настроек — не ПДн: в журнал идут было/стало
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('settings.update', 'setting', p_key, jsonb_build_object('from', v_old, 'to', p_value), 'admin');
end $$;

-- Та же функция, что в 20260930180000_admin_v02.sql; пауза — app.ops_reminder_pause()
create or replace function app.staff_remind_vendor(p_request uuid) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_request app.requests;
  v_count   int;
begin
  perform app.assert_staff_role(array['admin', 'manager']::app.staff_role[]);
  -- строка заявки блокируется: два нажатия подряд проверяются по очереди
  select r.* into v_request from app.requests r where r.id = p_request for update;
  if not found then
    raise exception 'invalid_argument' using errcode = '22023', detail = 'нет такой заявки';
  end if;
  if v_request.status not in ('new', 'viewed') or v_request.first_response_at is not null then
    raise exception 'request_not_awaiting' using errcode = 'BR019';
  end if;
  if exists (select 1 from app.outbox o
             where o.request_id = p_request and o.kind = 'vendor.ops_reminder'
               and o.created_at > now() - app.ops_reminder_pause()) then
    raise exception 'reminder_too_soon' using errcode = 'BR016';
  end if;

  v_count := app.enqueue_vendor_notice(p_request, 'vendor.ops_reminder',
    jsonb_build_object('request_id', p_request, 'staff_id', app.actor_id()),
    p_request || ':ops:' || (extract(epoch from clock_timestamp()) * 1000)::bigint);
  if v_count = 0 then
    raise exception 'vendor_unreachable' using errcode = 'BR020',
      detail = 'у вендора нет пользователя с привязанным Telegram';
  end if;

  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('request.remind', 'request', p_request::text, jsonb_build_object('recipients', v_count), 'admin');
  return v_count;
end $$;

comment on function app.staff_remind_vendor(uuid) is
  'Напоминание вендору от сотрудника: заявка ждёт первого ответа, не чаще паузы ops_reminder_pause_minutes';

-- ── права ───────────────────────────────────────────────────────────────────
-- Представление фактов и служебная проверка API недоступны — только функции ниже
revoke execute on all functions in schema app, pii from public;
grant execute on function
  app.metrics_period(timestamptz, timestamptz),
  app.metrics_weekly(int),
  app.metrics_vendors(int, uuid),
  app.metrics_listings(uuid, int),
  app.metrics_ops_now(),
  app.enqueue_ops_reports(),
  app.record_api_error(text),
  app.ops_reminder_pause()
  to bayramm_api;
