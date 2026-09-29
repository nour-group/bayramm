-- Откат миграции 20260930120000_vendor_cabinet.sql.
--
-- Только для локальной разработки и проверки в CI (up → down → up). Сессии
-- кабинета и отметки занятости остаются: снимаются только проверки и триггеры.
-- На staging/production откат — новая миграция «вперёд»; после ручного отката:
-- supabase migration repair --status reverted <версия>.

drop trigger if exists requests_decline_busy_day on app.requests;
drop trigger if exists availability_guard on app.availability;
drop function if exists app.requests_decline_busy_day(), app.availability_guard();

comment on column app.availability.source is null;
alter table app.availability drop constraint if exists availability_decline_request;

alter table app.sessions
  drop constraint if exists sessions_vendor_ttl,
  drop constraint if exists sessions_vendor_via;
