-- Откат 20261015120000_team_contact_undo_contacted.sql: без контакта команды в настройках и без
-- отмены отметки «связались». Функции — как в 20260930220000_launch_metrics.sql,
-- 20260930110500_bot_outbox_sla.sql и 20261002090000_services_only_category_metrics.sql.
--
-- Только для локальной разработки и проверки в CI (up → down → up).

-- ── отмена «связались» ──────────────────────────────────────────────────────

drop function if exists app.vendor_request_undo_contacted(uuid);
drop trigger if exists requests_undo_guard on app.requests;
drop function if exists app.requests_undo_guard();
delete from app.request_transitions
where from_status = 'contacted' and to_status in ('new', 'viewed') and actor = 'vendor_user';

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
      jsonb_build_object('request_id', new.request_id, 'status', new.to_status), new.id::text);
  end if;
  return null;
end $$;

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
-- первый ответ площадки: её переход в contacted, deal или declined
left join lateral (
  select min(sl.at) as vendor_response_at
  from app.request_status_log sl
  where sl.request_id = r.id and sl.actor_kind = 'vendor_user' and sl.to_status in ('contacted', 'deal', 'declined')
) v on true
-- заявку закрыли без площадки: клиент отозвал или истекла дата события
left join lateral (
  select min(sl.at) as closed_at
  from app.request_status_log sl
  where sl.request_id = r.id and sl.to_status in ('withdrawn', 'expired')
) c on true;

comment on view app.request_metric_facts is
  'Факты заявки для метрик: ответ площадки (не сотрудника), в срок ли, известен ли исход, договорились, нарушение срока, категория витрины. Без ПДн';

-- ── контакт команды ─────────────────────────────────────────────────────────

delete from app.settings where key in ('team_telegram', 'team_phone');

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
