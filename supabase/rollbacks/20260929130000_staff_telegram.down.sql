-- Откат миграции 20260929130000_staff_telegram.sql.
--
-- Только для локальной разработки и проверки в CI (up → down → up): удаляет
-- сессии сотрудников и привязки к Telegram. Если есть сотрудники без e-mail,
-- вернуть NOT NULL нельзя — откат остановится на этом шаге (сначала вписать
-- e-mail или удалить таких сотрудников). На staging/production откат — новая
-- миграция «вперёд»; после ручного отката: supabase migration repair --status reverted <версия>.
-- Записи staff.telegram_claim в app.audit_log остаются: журнал только на добавление.

drop function if exists app.staff_sign_in(bytea, bigint, text);

drop trigger if exists staff_guard on app.staff;
drop trigger if exists staff_profiles_username_guard on pii.staff_profiles;
drop function if exists
  app.staff_guard(),
  app.staff_profiles_username_guard(),
  app.assert_staff_username_free(text, uuid);

-- сессии: вернуть ограничения миграции 2
delete from app.sessions where staff_id is not null;
drop index if exists app.sessions_staff;
alter table app.sessions
  drop constraint if exists sessions_staff_ttl,
  drop constraint if exists sessions_staff_via,
  drop constraint if exists sessions_one_subject,
  drop constraint if exists sessions_via_check,
  drop column if exists staff_id,
  add constraint sessions_via_check check (via in ('tg_client', 'tg_partner', 'sms_otp')),
  add constraint sessions_check check (num_nonnulls(client_id, vendor_user_id) = 1);

alter table pii.staff_profiles
  drop column if exists telegram_id,
  drop column if exists telegram_username,
  alter column email set not null;

alter table app.staff
  drop constraint if exists staff_tg_link_consistent,
  drop column if exists tg_linked_at,
  drop column if exists tg_id_hash;

comment on table app.staff is null;
