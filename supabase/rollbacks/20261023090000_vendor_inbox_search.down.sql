-- Откат 20261023090000_vendor_inbox_search.sql: без поиска входящих по концу номера клиента.
--
-- Только для локальной разработки и проверки в CI (up → down → up).

drop function if exists pii.vendor_requests_by_phone_tail(text);
