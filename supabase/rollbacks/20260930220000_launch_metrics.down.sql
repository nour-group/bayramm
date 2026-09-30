-- Откат 20260930220000_launch_metrics.sql: метрики запуска, отчёты команде,
-- оповещение об ошибках API и пауза между напоминаниями как настройка. Функции
-- настроек и напоминания возвращаются к виду из 20260930180000_admin_v02.sql
-- (пауза снова 30 минут в коде). Уже поставленные строки outbox остаются.

drop function if exists app.record_api_error(text);
drop table if exists app.api_error_alerts;
drop function if exists app.enqueue_ops_reports();
drop function if exists app.metrics_ops_now();
drop function if exists app.metrics_listings(uuid, int);
drop function if exists app.metrics_vendors(int, uuid);
drop function if exists app.metrics_weekly(int);
drop function if exists app.metrics_period(timestamptz, timestamptz);
drop function if exists app.assert_metrics_reader();
drop view if exists app.request_metric_facts;
drop index if exists app.outbox_dead_created;
drop index if exists app.requests_created;

-- staff_remind_vendor — как в 20260930180000_admin_v02.sql (пауза 30 минут)
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
               and o.created_at > now() - interval '30 minutes') then
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
  'Напоминание вендору от сотрудника: заявка ждёт первого ответа, не чаще раза в 30 минут';

drop function if exists app.ops_reminder_pause();

-- staff_set_setting — как в 20260930180000_admin_v02.sql
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
       'request_contact_retention_days', 'otp_retention_hours', 'session_retention_days']) then
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

delete from app.settings where key = 'ops_reminder_pause_minutes';

-- setting_value_ok — как в 20260930180000_admin_v02.sql
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
    else return true;
  end case;
  if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}') !~ '^[0-9]+$' then
    return false;
  end if;
  return (p_value #>> '{}')::int between v_min and v_max;
end $$;
