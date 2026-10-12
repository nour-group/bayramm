-- Откат 20261012110000_perf_indexes.sql: журнал в панели снова читается без индекса по времени.
-- Только для локальной разработки и проверки в CI (up → down → up)

drop index if exists app.audit_log_at_id;
