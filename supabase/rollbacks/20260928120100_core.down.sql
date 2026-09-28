-- Откат миграции 20260928120100_core.sql.
--
-- Только для локальной разработки и проверки в CI (up → down → up).
-- На staging/production откат — это новая миграция «вперёд» и бэкап: этот
-- файл удаляет данные. После ручного отката на удалённой базе историю миграций
-- нужно привести в порядок: supabase migration repair --status reverted <версия>.

-- вернуть версию app.is_privileged из миграции 1 (без проверки app.staff)
create or replace function app.is_privileged() returns boolean
language sql stable parallel safe security invoker set search_path = ''
as $$ select coalesce(app.actor_kind() in ('staff', 'system'), false) $$;

-- таблицы (CASCADE снимает политики, триггеры, представления и внешние ключи)
drop view if exists app.consents_current;
drop table if exists
  app.outbox,
  app.pii_access_log,
  app.audit_log,
  app.otp_codes,
  app.sessions,
  app.availability,
  app.request_status_log,
  app.request_transitions,
  pii.request_contacts,
  app.requests,
  app.consents,
  app.listing_revisions,
  app.photos,
  app.listing_packages,
  pii.listing_contacts,
  app.listings,
  pii.vendor_user_profiles,
  app.vendor_users,
  pii.vendor_contacts,
  app.vendor_accounts,
  pii.client_profiles,
  app.clients,
  pii.staff_profiles,
  app.staff,
  app.consent_texts,
  app.legal_entities
  cascade;
drop sequence if exists app.vendor_code_seq;

-- функции
drop function if exists
  pii.read_listing_phone(uuid, text),
  pii.read_vendor_user_phone(uuid, text),
  pii.read_vendor_contact_phones(uuid, text),
  pii.read_client_phone(uuid, text),
  pii.read_request_phone(uuid, text),
  app.log_pii_access(text, uuid, text, text),
  app.requests_log_status(),
  app.requests_before_update(),
  app.requests_before_insert(),
  app.consents_before_insert(),
  app.listing_revisions_guard(),
  app.photos_keep_ready(),
  app.photos_guard(),
  app.listing_contacts_keep_ready(),
  app.listing_packages_keep_ready(),
  app.listing_packages_guard(),
  app.listings_before_update(),
  app.listings_before_insert(),
  app.vendor_accounts_guard(),
  app.vendor_users_guard(),
  app.clients_guard(),
  app.listing_publish_blockers(uuid, app.listing_status),
  app.can_see_request_contact(uuid),
  app.can_see_request(uuid),
  app.request_consent_active(uuid),
  app.current_staff_role(),
  app.listing_is_public(uuid),
  app.owns_listing(uuid),
  app.revision_payload_ok(jsonb),
  app.consent_texts_guard(),
  app.touch_updated_at();
