-- Откат миграции 20260930130000_admin_v01.sql.
--
-- Только для локальной разработки и проверки в CI (up → down → up): удаляет
-- историю статусов карточек и название вендора. На staging/production откат —
-- новая миграция «вперёд»; после ручного отката:
-- supabase migration repair --status reverted <версия>.
-- Записи, которые триггер положил в app.audit_log, остаются: журнал только на добавление.

drop trigger if exists audit_staff on app.availability;
drop trigger if exists audit_staff on app.photos;
drop trigger if exists audit_staff on pii.listing_contacts;
drop trigger if exists audit_staff on app.listing_packages;
drop trigger if exists audit_staff on app.listings;
drop trigger if exists audit_staff on app.vendor_users;
drop trigger if exists audit_staff on pii.vendor_contacts;
drop trigger if exists audit_staff on app.vendor_accounts;
drop function if exists app.audit_staff_change();

drop trigger if exists listings_log_status on app.listings;
drop function if exists app.listings_log_status();
-- Журнал защищён от TRUNCATE и DELETE триггерами — таблица удаляется целиком
drop table if exists app.listing_status_log;

alter table app.vendor_accounts drop column if exists name;
