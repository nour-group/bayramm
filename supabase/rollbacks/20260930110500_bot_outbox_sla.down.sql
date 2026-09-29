-- Откат миграции 20260930110500_bot_outbox_sla.sql.
--
-- Только для локальной разработки и проверки в CI (up → down → up). На
-- staging/production откат — новая миграция «вперёд»; после ручного отката:
-- supabase migration repair --status reverted <версия>.
-- Привязки вендоров к Telegram и строки outbox остаются: это данные, а не схема.
-- Записи vendor_user.telegram_claim в app.audit_log остаются: журнал только на добавление.

drop function if exists
  app.sla_advance(uuid, smallint, timestamptz),
  app.telegram_started(bytea, bigint),
  app.vendor_user_claim_telegram(bytea, text, bytea, bigint, bigint);

drop trigger if exists outbox_dead_alert on app.outbox;
drop trigger if exists request_status_log_notify on app.request_status_log;
drop function if exists
  app.outbox_dead_alert(),
  app.request_status_log_notify(),
  app.enqueue_ops_alert(text, jsonb, text, uuid),
  app.enqueue_client_notice(uuid, text, jsonb, text, timestamptz),
  app.enqueue_vendor_notice(uuid, text, jsonb, text),
  app.client_notifiable(uuid);

comment on column app.outbox.enqueued_at is null;
drop index if exists app.outbox_sending;

drop trigger if exists vendor_users_tg_link_guard on app.vendor_users;
drop function if exists app.vendor_users_tg_link_guard();
alter table app.vendor_users drop constraint if exists vendor_users_tg_link_consistent;

drop table if exists app.telegram_updates;
