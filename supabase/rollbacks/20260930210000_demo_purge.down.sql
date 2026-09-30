-- Откат 20260930210000_demo_purge.sql: функция уборки демо-данных staging.
-- Сами демо-строки, если они есть, остаются — убрать их до отката: POST /ops/demo (reset).

drop function if exists app.demo_purge();
