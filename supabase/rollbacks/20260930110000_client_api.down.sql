-- Откат миграции 20260930110000_client_api.sql.
--
-- Только для локальной разработки и проверки в CI (up → down → up). На
-- staging/production откат — новая миграция «вперёд».

drop trigger if exists requests_client_rules on app.requests;
drop function if exists app.requests_client_rules();
