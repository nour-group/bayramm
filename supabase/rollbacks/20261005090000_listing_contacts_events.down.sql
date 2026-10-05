-- Откат 20261005090000_listing_contacts_events.sql: события «связаться», их метрики и
-- Telegram витрины. Только для локальной разработки и проверки в CI (up → down → up)
drop function if exists app.metrics_contacts(int, text);
drop function if exists app.record_contact_event(uuid, text, text, boolean);
drop function if exists pii.reveal_listing_contacts(uuid, text, boolean);
drop table if exists app.contact_events;
drop function if exists pii.read_listing_contacts(uuid, text);
drop function if exists pii.listing_contact_kinds(uuid);
alter table pii.listing_contacts drop column if exists public_telegram;
