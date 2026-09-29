-- Откат миграции 20260930140000_platform_hardening.sql.
--
-- Только для локальной разработки и проверки в CI (up → down → up). Уже
-- стёртые контакты, отозванные согласия, удалённые аккаунты и истёкшие заявки
-- не возвращаются: это данные, а не схема. Отметки maintenance.daily и
-- client.delete_account в app.audit_log остаются — журнал только на добавление.
-- На staging/production откат — новая миграция «вперёд»; после ручного отката:
-- supabase migration repair --status reverted <версия>.

drop function if exists
  app.client_export(),
  app.client_delete_account(app.source, bytea),
  app.client_withdraw_consent(app.consent_purpose, uuid, app.source, bytea),
  app.run_daily_maintenance(),
  app.purge_sessions(),
  app.purge_otp_codes(),
  app.purge_request_contacts(),
  app.expire_past_requests(),
  app.tashkent_today();

delete from app.settings where key = 'session_retention_days';

-- вернуть проверку настроек из миграции 1 (без session_retention_days)
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
    else return true;
  end case;
  if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}') !~ '^[0-9]+$' then
    return false;
  end if;
  return (p_value #>> '{}')::int between v_min and v_max;
end $$;

revoke execute on function app.setting_value_ok(text, jsonb) from public;
