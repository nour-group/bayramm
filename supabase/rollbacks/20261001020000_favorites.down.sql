-- Откат 20261001020000_favorites.sql: избранное клиента. Отметки клиентов удаляются
-- вместе с таблицей; выгрузка своих данных — снова без избранного.

drop trigger if exists clients_forget_favorites on app.clients;
drop function if exists app.clients_forget_favorites();
drop function if exists app.client_favorites_merge(uuid[]);
drop function if exists app.client_favorite_add(uuid);
drop function if exists app.favorites_client();
drop table if exists app.favorites;

-- Выгрузка — как в 20260930140000_platform_hardening.sql
create or replace function app.client_export() returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_client uuid := app.actor_id();
begin
  if app.actor_kind() is distinct from 'client' or v_client is null then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;

  return jsonb_build_object(
    'version', 1,
    'generatedAt', now(),
    'account', (
      select jsonb_build_object(
        'id', c.id, 'locale', c.locale, 'canMessage', c.can_message,
        'createdAt', c.created_at, 'lastSeenAt', c.last_seen_at)
      from app.clients c where c.id = v_client),
    'profile', (
      select jsonb_build_object(
        'telegramId', p.telegram_id, 'firstName', p.first_name, 'lastName', p.last_name,
        'username', p.username, 'phone', pii.read_client_phone(v_client),
        'phoneVerifiedAt', p.phone_verified_at, 'updatedAt', p.updated_at)
      from pii.client_profiles p where p.client_id = v_client),
    'consents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'purpose', c.purpose, 'action', c.action, 'textVersion', t.version, 'textLocale', t.locale,
               'listingId', c.scope_listing_id, 'source', c.source, 'at', c.created_at)
             order by c.created_at, c.id)
      from app.consents c
      join app.consent_texts t on t.id = c.text_id
      where c.subject_kind = 'client' and c.subject_id = v_client), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'publicNo', r.public_no, 'status', r.status, 'declineReason', r.decline_reason,
               'occasionCode', r.occasion_code, 'eventDate', r.event_date, 'guests', r.guests,
               'budgetMinUzs', r.budget_min_uzs, 'budgetMaxUzs', r.budget_max_uzs, 'source', r.source,
               'createdAt', r.created_at, 'slaDueAt', r.sla_due_at, 'firstResponseAt', r.first_response_at,
               'listing', jsonb_build_object('id', r.listing_id, 'slug', l.slug, 'name', l.name),
               'contact', (
                 select jsonb_build_object(
                   'name', rc.contact_name, 'phone', pii.read_request_phone(r.id),
                   'comment', rc.comment, 'purgedAt', rc.purged_at)
                 from pii.request_contacts rc where rc.request_id = r.id),
               'history', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'from', h.from_status, 'to', h.to_status, 'actorKind', h.actor_kind, 'at', h.at)
                        order by h.at, h.id)
                 from app.request_status_log h where h.request_id = r.id), '[]'::jsonb))
             order by r.created_at, r.id)
      from app.requests r
      left join app.listings l on l.id = r.listing_id
      where r.client_id = v_client), '[]'::jsonb));
end $$;
