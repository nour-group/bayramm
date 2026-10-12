-- Откат 20261012100000_vendor_photos_contacts.sql: запросов на смену контактов и защиты обложки
-- партнёра больше нет; прямая запись партнёра в pii.listing_contacts снова только по RLS.
-- Неотправленные оповещения нового вида прежний отправитель не знает. Только для локальной
-- разработки и проверки в CI (up → down → up)

delete from app.outbox
 where kind in ('ops.contact_change_submitted', 'vendor.contact_change_decided')
   and status in ('pending', 'sending', 'failed');

drop function if exists app.staff_contact_changes(int, int);
drop function if exists app.contact_change_state(uuid);
drop function if exists pii.read_listing_contact_change(uuid, text);
drop function if exists app.staff_decline_contact_change(uuid, text);
drop function if exists app.staff_approve_contact_change(uuid);
drop function if exists app.vendor_withdraw_contact_change(uuid);
drop function if exists app.vendor_submit_contact_change(uuid, text, text);

drop trigger if exists listing_contacts_vendor_audit on pii.listing_contacts;
drop function if exists app.listing_contacts_vendor_audit();
drop trigger if exists listing_contacts_vendor_guard on pii.listing_contacts;
drop function if exists app.listing_contacts_vendor_guard();

drop table if exists pii.listing_contact_changes;

drop trigger if exists photos_vendor_guard on app.photos;
drop function if exists app.photos_vendor_guard();
