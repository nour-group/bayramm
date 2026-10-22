-- Откат 20261023090000_vendor_inbox_search.sql: без поиска входящих по концу номера клиента и без
-- строк журнала доступа к ПДн о таком поиске.
--
-- Только для локальной разработки и проверки в CI (up → down → up).

drop function if exists pii.vendor_requests_by_phone_tail(text);

-- Журнал — только на добавление: строки поиска убираем при выключенном запрете (только в откате)
alter table app.pii_access_log disable trigger pii_access_log_append_only;
delete from app.pii_access_log where subject_kind = 'vendor_inbox';
alter table app.pii_access_log enable trigger pii_access_log_append_only;
alter table app.pii_access_log drop constraint pii_access_log_subject_kind_check;
alter table app.pii_access_log add constraint pii_access_log_subject_kind_check check (subject_kind in
  ('client', 'request_contact', 'vendor_contact', 'vendor_user', 'listing_contact'));
