-- Откат 20261022090000_partner_decision_notices.sql: партнёру снова не пишут о решениях команды
-- по витрине, предложениям изменений и фото. Неотправленные уведомления этих видов уходят вместе
-- с ними (их уже некому собрать).
--
-- Только для локальной разработки и проверки в CI (up → down → up).

drop trigger if exists photos_partner_notify on app.photos;
drop function if exists app.photos_partner_notify();
drop function if exists app.enqueue_vendor_photos_notice(uuid, uuid, timestamptz);

drop trigger if exists listing_revisions_partner_notify on app.listing_revisions;
drop function if exists app.listing_revisions_partner_notify();

drop trigger if exists listing_status_log_partner_notify on app.listing_status_log;
drop function if exists app.listing_status_log_partner_notify();

delete from app.outbox
where kind in ('vendor.listing_decided', 'vendor.revision_decided', 'vendor.photos_decided')
  and status in ('pending', 'failed');
