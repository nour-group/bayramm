-- Контакт команды для партнёров и отмена «Я связался с клиентом».
--
--   · Настройки team_telegram и team_phone — контакт команды Bayramm (контакт компании, не ПДн):
--     имя в Telegram без «@» и телефон +998XXXXXXXXX, '' — не указан. Меняет администратор в
--     панели (app.staff_set_setting), читает GET /auth/methods; кабинет показывает его будущему
--     партнёру и в «Аккаунте». Функции — как в 20260930220000_launch_metrics.sql, плюс эти ключи.
--
--   · Отмена отметки «связались», нажатой партнёром по ошибке:
--     app.vendor_request_undo_contacted(заявка) — только тот же пользователь кабинета, только в
--     первые 30 секунд после отметки и только если отметка — последний шаг заявки. Заявка
--     возвращается в прежний статус (new или viewed), первый ответ снова пуст — срок ответа идёт.
--     Переход contacted → new/viewed есть в app.request_transitions, но триггер
--     requests_undo_guard пускает его только из этой функции.
--     Сообщение клиенту об отметке партнёра (client.request_status) ждёт 45 секунд — дольше окна
--     отмены: отменили — оно не уходит (строка outbox удаляется, пока она pending).
--     В метриках отменённая отметка ответом не считается: в app.request_metric_facts — переход
--     площадки, за которым сразу не идёт отмена (contacted → new/viewed).
--
-- Коды ошибок (продолжение списка из 20261012100000_vendor_photos_contacts.sql):
--   BR044 undo_expired   отменить «связались» нельзя: окно в 30 секунд прошло, последний шаг
--                        заявки не эта отметка, она не того же пользователя или сообщение ушло
--

-- ════════════════════════════════════════════════════════════════════════════
-- Контакт команды
-- ════════════════════════════════════════════════════════════════════════════

-- Та же функция, что в 20260930220000_launch_metrics.sql, плюс team_telegram и team_phone
create or replace function app.setting_value_ok(p_key text, p_value jsonb) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  v_min int;
  v_max int;
begin
  case p_key
    when 'team_telegram' then
      return jsonb_typeof(p_value) = 'string'
         and ((p_value #>> '{}') = '' or (p_value #>> '{}') ~ '^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$');
    when 'team_phone' then
      return jsonb_typeof(p_value) = 'string'
         and ((p_value #>> '{}') = '' or (p_value #>> '{}') ~ '^\+998[0-9]{9}$');
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

insert into app.settings (key, value) values
  ('team_telegram', '""'),   -- имя команды в Telegram без «@»; '' — не указано
  ('team_phone', '""')       -- телефон команды +998XXXXXXXXX; '' — не указан
on conflict (key) do nothing;

-- Та же функция, что в 20260930220000_launch_metrics.sql, плюс team_telegram и team_phone
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
       'ops_reminder_pause_minutes', 'team_telegram', 'team_phone']) then
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
  -- значения настроек — не ПДн (контакт команды — контакт компании): в журнал идут было/стало
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('settings.update', 'setting', p_key, jsonb_build_object('from', v_old, 'to', p_value), 'admin');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Отмена «связались»
-- ════════════════════════════════════════════════════════════════════════════

insert into app.request_transitions (from_status, to_status, actor) values
  ('contacted', 'viewed', 'vendor_user'),   -- только отмена (app.vendor_request_undo_contacted)
  ('contacted', 'new',    'vendor_user')
on conflict do nothing;

-- Обратный переход — только из функции отмены: она ставит app.request_undo = id заявки на
-- время своего UPDATE. Прямой UPDATE (API, ручной SQL) получает illegal_transition
create function app.requests_undo_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if current_setting('app.request_undo', true) is distinct from new.id::text then
    raise exception 'illegal_transition' using errcode = 'BR002',
      detail = format('%s -> %s: только отменой отметки (app.vendor_request_undo_contacted)', old.status, new.status);
  end if;
  return new;
end $$;
create trigger requests_undo_guard before update of status on app.requests
  for each row when (old.status = 'contacted' and new.status in ('new', 'viewed'))
  execute function app.requests_undo_guard();
-- Триггерную функцию API не вызывает
revoke execute on function app.requests_undo_guard() from public;

-- Как в 20260930110500_bot_outbox_sla.sql; отметка «связались» самой площадкой (из new/viewed)
-- уходит клиенту через 45 секунд: окно её отмены — 30 секунд, отменённая не уходит вовсе
create or replace function app.request_status_log_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.from_status is null then
    perform app.enqueue_vendor_notice(new.request_id, 'vendor.request_new',
      jsonb_build_object('request_id', new.request_id), new.request_id::text);
  elsif new.to_status in ('contacted', 'deal', 'declined')
        and not (new.to_status = 'contacted' and new.from_status in ('deal', 'declined')) then
    perform app.enqueue_client_notice(new.request_id, 'client.request_status',
      jsonb_build_object('request_id', new.request_id, 'status', new.to_status), new.id::text,
      case when new.to_status = 'contacted' and new.actor_kind = 'vendor_user'
                and new.from_status in ('new', 'viewed')
           then now() + interval '45 seconds' end);
  end if;
  return null;
end $$;

-- Отменить «Я связался с клиентом»: тот же пользователь кабинета, в первые 30 секунд, если
-- отметка — последний шаг заявки и сообщение клиенту ещё не ушло. Иначе — BR044 undo_expired
create function app.vendor_request_undo_contacted(p_request uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_request app.requests;
  v_last    app.request_status_log;
begin
  if app.actor_kind() is distinct from 'vendor_user' or app.actor_vendor_id() is null then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  -- строка заявки блокируется: отмена и новый шаг не пройдут одновременно
  select r.* into v_request from app.requests r
  where r.id = p_request and r.vendor_id = app.actor_vendor_id()
  for update;
  if not found then
    raise exception 'undo_expired' using errcode = 'BR044', detail = 'нет такой заявки у вендора';
  end if;
  select l.* into v_last from app.request_status_log l
  where l.request_id = p_request
  order by l.id desc
  limit 1;
  if v_request.status <> 'contacted'
     or v_last.to_status is distinct from 'contacted'
     or v_last.from_status is null or v_last.from_status not in ('new', 'viewed')
     or v_last.actor_kind is distinct from 'vendor_user'
     or v_last.actor_id is distinct from app.actor_id()
     or v_last.at < clock_timestamp() - interval '30 seconds' then
    raise exception 'undo_expired' using errcode = 'BR044';
  end if;
  -- сообщение клиенту ждёт конца окна: не ушло — не уйдёт; ушло — отмена была бы нечестной
  delete from app.outbox o
  where o.dedupe_key = 'client.request_status:' || v_last.id and o.status = 'pending';
  if exists (select 1 from app.outbox o where o.dedupe_key = 'client.request_status:' || v_last.id) then
    raise exception 'undo_expired' using errcode = 'BR044', detail = 'сообщение клиенту уже ушло';
  end if;
  perform set_config('app.request_undo', p_request::text, true);
  update app.requests r
  set status = v_last.from_status, first_response_at = null, first_response_by = null
  where r.id = p_request;
  perform set_config('app.request_undo', '', true);
end $$;

comment on function app.vendor_request_undo_contacted(uuid) is
  'Отмена отметки «связались» партнёром: тот же пользователь, 30 секунд, сообщение клиенту не уходит';

revoke execute on function app.vendor_request_undo_contacted(uuid) from public;
grant execute on function app.vendor_request_undo_contacted(uuid) to bayramm_api;

-- Как в 20261002090000_services_only_category_metrics.sql; первый ответ площадки — её переход,
-- за которым сразу не идёт отмена (contacted → new/viewed: так меняет только отмена)
create or replace view app.request_metric_facts with (security_invoker = true) as
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
       r.sla_breached_at is not null as breached,
       l.category_code
from app.requests r
join app.listings l on l.id = r.listing_id
-- первый ответ площадки: её переход в contacted, deal или declined, кроме отменённых
left join lateral (
  select min(sl.at) as vendor_response_at
  from app.request_status_log sl
  where sl.request_id = r.id and sl.actor_kind = 'vendor_user' and sl.to_status in ('contacted', 'deal', 'declined')
    and not exists (
      select 1 from app.request_status_log u
      where u.request_id = sl.request_id
        and u.id = (select min(n.id) from app.request_status_log n where n.request_id = sl.request_id and n.id > sl.id)
        and u.from_status = 'contacted' and u.to_status in ('new', 'viewed'))
) v on true
-- заявку закрыли без площадки: клиент отозвал или истекла дата события
left join lateral (
  select min(sl.at) as closed_at
  from app.request_status_log sl
  where sl.request_id = r.id and sl.to_status in ('withdrawn', 'expired')
) c on true;

comment on view app.request_metric_facts is
  'Факты заявки для метрик: ответ площадки (не сотрудника, не отменённый), в срок ли, известен ли исход, договорились, нарушение срока, категория витрины. Без ПДн';
