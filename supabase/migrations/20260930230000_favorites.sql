-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — избранное клиента.
--
--   · app.favorites — площадки, отмеченные клиентом сердечком: (клиент, листинг,
--     когда). Строки видит и удаляет только сам клиент (RLS по актору client);
--     сотрудникам и вендорам они не видны;
--   · добавляют только функции (своей строки INSERT-ом не вставить):
--       – app.client_favorite_add(листинг) — одна площадка: added | already |
--         not_found (не опубликована или нет такой) | full (уже 100);
--       – app.client_favorites_merge(листинги[]) — гостевой список при входе:
--         опубликованные и ещё не отмеченные, пока не наберётся 100; сколько
--         добавлено. Больше 100 id за раз — ошибка аргумента;
--   · снятая с публикации площадка из таблицы не пропадает, но клиенту её не
--     показывают (API выбирает по публичным листингам) — вернётся с публикацией;
--   · выгрузка своих данных (app.client_export) — со списком избранного;
--   · удаление аккаунта клиента стирает его избранное (триггер на
--     app.clients.deleted_at — любой путь удаления).
--
-- Откат: supabase/rollbacks/20260930230000_favorites.down.sql
-- ════════════════════════════════════════════════════════════════════════════

create table app.favorites (
  client_id  uuid        not null references app.clients (id) on delete cascade,
  listing_id uuid        not null references app.listings (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (client_id, listing_id)
);
create index favorites_listing_idx on app.favorites (listing_id);
create index favorites_client_recent_idx on app.favorites (client_id, created_at desc);

comment on table app.favorites is
  'Избранное клиента: площадки, отмеченные сердечком. Не больше 100 на клиента; добавляют app.client_favorite_add и app.client_favorites_merge';

alter table app.favorites enable row level security;

-- только свои строки: читать и убирать; добавлять — функциями ниже
create policy favorites_read on app.favorites for select to bayramm_api
  using ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id()));
create policy favorites_delete on app.favorites for delete to bayramm_api
  using ((select app.actor_kind()) = 'client' and client_id = (select app.actor_id()));

grant select, delete on app.favorites to bayramm_api;

-- ── добавление ──────────────────────────────────────────────────────────────
-- Клиент текущего актора, действующий (не удалён); иначе — BR003. Параллельные
-- добавления одного клиента идут по очереди: лимит считается без гонок
create function app.favorites_client() returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_client uuid := app.actor_id();
begin
  if app.actor_kind() is distinct from 'client' or v_client is null
     or not exists (select 1 from app.clients c where c.id = v_client and c.deleted_at is null) then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bayramm.favorites:' || v_client::text, 0));
  return v_client;
end $$;

create function app.client_favorite_add(p_listing uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_client uuid := app.favorites_client();
begin
  if p_listing is null or not app.listing_is_public(p_listing) then
    return 'not_found';
  end if;
  if exists (select 1 from app.favorites f where f.client_id = v_client and f.listing_id = p_listing) then
    return 'already';
  end if;
  if (select count(*) from app.favorites f where f.client_id = v_client) >= 100 then
    return 'full';
  end if;
  insert into app.favorites (client_id, listing_id) values (v_client, p_listing);
  return 'added';
end $$;

-- Порядок гостевого списка сохраняется: первые в массиве — первыми, пока есть место
create function app.client_favorites_merge(p_listings uuid[]) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_client uuid := app.favorites_client();
  v_added  int;
begin
  if p_listings is null or cardinality(p_listings) > 100 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  insert into app.favorites (client_id, listing_id)
  select v_client, w.id
  from (select u.id, min(u.ord) as ord
        from unnest(p_listings) with ordinality as u (id, ord)
        where u.id is not null
        group by u.id) w
  join app.listings l on l.id = w.id and l.status = 'active'
  where not exists (select 1 from app.favorites f where f.client_id = v_client and f.listing_id = w.id)
  order by w.ord
  limit greatest(0, 100 - (select count(*) from app.favorites f where f.client_id = v_client));
  get diagnostics v_added = row_count;
  return v_added;
end $$;

-- ── удаление аккаунта клиента ───────────────────────────────────────────────
create function app.clients_forget_favorites() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from app.favorites f where f.client_id = new.id;
  return null;
end $$;
create trigger clients_forget_favorites after update of deleted_at on app.clients
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function app.clients_forget_favorites();

-- ── выгрузка своих данных ───────────────────────────────────────────────────
-- Та же функция, что в 20260930140000_platform_hardening.sql, плюс избранное:
-- id площадки, её адрес и название (если клиенту она ещё видна) и когда отмечена
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
      where r.client_id = v_client), '[]'::jsonb),
    'favorites', coalesce((
      select jsonb_agg(jsonb_build_object(
               'listing', jsonb_build_object('id', f.listing_id, 'slug', l.slug, 'name', l.name),
               'savedAt', f.created_at)
             order by f.created_at, f.listing_id)
      from app.favorites f
      left join app.listings l on l.id = f.listing_id
      where f.client_id = v_client), '[]'::jsonb));
end $$;

-- ── права ───────────────────────────────────────────────────────────────────
revoke execute on all functions in schema app, pii from public;
grant execute on function
  app.client_favorite_add(uuid),
  app.client_favorites_merge(uuid[])
  to bayramm_api;
