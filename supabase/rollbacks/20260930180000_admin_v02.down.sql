-- Откат 20260930180000_admin_v02.sql: заметки к заявкам, действия сотрудников
-- (напоминание, блокировка клиента, повтор уведомления, настройки, команда),
-- расширенный журнал действий. Записи журнала действий остаются (он только на
-- добавление); настройки остаются с текущими значениями.

drop function if exists app.staff_set_role(uuid, app.staff_role);
drop function if exists app.staff_set_active(uuid, boolean);
drop function if exists app.staff_invite(text, text, app.staff_role);
drop trigger if exists staff_keep_admin on app.staff;
drop function if exists app.staff_keep_admin();

drop function if exists app.staff_set_setting(text, jsonb);
drop function if exists app.staff_retry_outbox(uuid);
drop function if exists app.staff_unblock_client(uuid);
drop function if exists app.staff_block_client(uuid, text);
drop function if exists app.staff_remind_vendor(uuid);

drop trigger if exists audit_staff on app.listing_revisions;
drop trigger if exists audit_staff on app.requests;
drop table if exists app.request_notes;
drop function if exists app.request_notes_before_insert();
drop function if exists app.assert_staff_role(app.staff_role[]);

-- setting_value_ok — как в 20260930140000_platform_hardening.sql
create or replace function app.setting_value_ok(p_key text, p_value jsonb) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  v_min int;
  v_max int;
begin
  case p_key
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
