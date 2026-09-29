-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — сроки хранения и права клиента на свои данные.
--
--   · ежедневное обслуживание (app.run_daily_maintenance, только актор system):
--       – заявки, у которых дата события (по Ташкенту) прошла без итога:
--         new | viewed | contacted → expired — переходом system, с записью в
--         журнале статусов (причина event_date_passed);
--       – контакты из заявок (pii.request_contacts) стираются через
--         request_contact_retention_days дней после даты события: строка
--         остаётся с отметкой purged_at, имя, телефон и комментарий — null;
--       – коды входа старше otp_retention_hours часов удаляются;
--       – сессии, истёкшие или отозванные больше session_retention_days дней
--         назад, удаляются.
--     Каждый шаг идемпотентен; запуск за день (по Ташкенту) — один: повтор в тот
--     же день ничего не делает (отметка maintenance.daily в app.audit_log);
--   · права клиента — только над собой (актор client, id из app.actor_id):
--       – app.client_export()           — выгрузка своих данных (JSON);
--       – app.client_withdraw_consent() — отзыв согласия с записью в журнал;
--       – app.client_delete_account()   — удаление аккаунта: согласия
--         отзываются, открытые заявки отзываются, контакты из заявок стираются,
--         профиль с ПДн удаляется, сессии отзываются. Псевдонимные заявки и
--         журналы остаются; новый вход восстанавливает аккаунт с новым профилем.
--
-- Откат: supabase/rollbacks/20260930140000_platform_hardening.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── настройки ───────────────────────────────────────────────────────────────
-- Та же функция, что в миграции 1, плюс граница session_retention_days
create or replace function app.setting_value_ok(p_key text, p_value jsonb) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  v_min int;
  v_max int;
begin
  case p_key
    when 'sla_hours'  then v_min := 1; v_max := 72;
    when 'min_photos' then v_min := 3; v_max := 10;
    when 'max_photos' then v_min := 3; v_max := 30;
    when 'client_requests_per_day' then v_min := 1; v_max := 100;
    when 'request_contact_retention_days' then v_min := 1; v_max := 3650;
    when 'otp_retention_hours' then v_min := 1; v_max := 720;
    when 'session_retention_days' then v_min := 1; v_max := 365;
    else return true;
  end case;
  if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}') !~ '^[0-9]+$' then
    return false;
  end if;
  return (p_value #>> '{}')::int between v_min and v_max;
end $$;

insert into app.settings (key, value) values
  ('session_retention_days', '30')   -- истёкшие и отозванные сессии хранятся столько дней
on conflict (key) do nothing;

-- «Сегодня» по Ташкенту: даты событий — в местном календаре
create function app.tashkent_today() returns date
language sql stable parallel safe set search_path = ''
as $$ select (now() at time zone 'Asia/Tashkent')::date $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Ежедневное обслуживание (актор system)
-- ════════════════════════════════════════════════════════════════════════════

-- Заявки с прошедшей датой события без итога → expired. Переход system разрешён
-- в app.request_transitions; журнал статусов пишет триггер (actor system, source
-- system, причина — через GUC app.reason, как у любого перехода)
create function app.expire_past_requests() returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_reason text := current_setting('app.reason', true);
  v_count  int;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  perform set_config('app.reason', 'event_date_passed', true);
  update app.requests r
  set status = 'expired'
  where r.status in ('new', 'viewed', 'contacted') and r.event_date < app.tashkent_today();
  get diagnostics v_count = row_count;
  perform set_config('app.reason', coalesce(v_reason, ''), true);
  return v_count;
end $$;

-- Контакты из заявок — через request_contact_retention_days дней после даты
-- события. Строка остаётся (purged_at — когда стёрли), ПДн — нет
create function app.purge_request_contacts() returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_days  int := coalesce(app.setting_int('request_contact_retention_days'), 90);
  v_count int;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  update pii.request_contacts rc
  set contact_name = null, contact_phone = null, comment = null, purged_at = now()
  from app.requests r
  where r.id = rc.request_id and rc.purged_at is null
    and r.event_date < app.tashkent_today() - v_days;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Коды входа старше otp_retention_hours
create function app.purge_otp_codes() returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_hours int := coalesce(app.setting_int('otp_retention_hours'), 24);
  v_count int;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  delete from app.otp_codes o where o.created_at < now() - make_interval(hours => v_hours);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Сессии, истёкшие или отозванные больше session_retention_days дней назад.
-- Действующие сессии не трогаются никогда
create function app.purge_sessions() returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_days  int := coalesce(app.setting_int('session_retention_days'), 30);
  v_count int;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  delete from app.sessions s
  where s.expires_at < now() - make_interval(days => v_days)
     or s.revoked_at < now() - make_interval(days => v_days);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Всё обслуживание одной транзакцией, раз в день по Ташкенту. Повторный вызов
-- в тот же день (повтор Cron, второй экземпляр) ничего не делает и отвечает
-- ran = false; упавший запуск откатывается целиком и не мешает повтору
create function app.run_daily_maintenance()
returns table (ran boolean, run_day date, expired_requests int, purged_request_contacts int,
               deleted_otp_codes int, deleted_sessions int)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_day      date := app.tashkent_today();
  v_expired  int;
  v_contacts int;
  v_otp      int;
  v_sessions int;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  -- параллельный запуск ждёт первый и потом видит его отметку
  perform pg_advisory_xact_lock(hashtextextended('bayramm.daily_maintenance', 0));
  if exists (select 1 from app.audit_log a
             where a.object_type = 'maintenance' and a.object_id = v_day::text
               and a.action = 'maintenance.daily') then
    return query select false, v_day, 0, 0, 0, 0;
    return;
  end if;

  v_expired  := app.expire_past_requests();
  v_contacts := app.purge_request_contacts();
  v_otp      := app.purge_otp_codes();
  v_sessions := app.purge_sessions();

  -- отметка о запуске — в журнал действий: только числа, без ПДн
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('maintenance.daily', 'maintenance', v_day::text,
          jsonb_build_object('expired_requests', v_expired, 'purged_request_contacts', v_contacts,
                             'deleted_otp_codes', v_otp, 'deleted_sessions', v_sessions),
          'system');

  return query select true, v_day, v_expired, v_contacts, v_otp, v_sessions;
end $$;

comment on function app.run_daily_maintenance() is
  'Ежедневное обслуживание: истечение заявок, сроки хранения контактов, кодов входа и сессий. Только актор system';

-- ════════════════════════════════════════════════════════════════════════════
-- Права клиента на свои данные (актор client — только над собой)
-- ════════════════════════════════════════════════════════════════════════════

-- Отзыв согласия: запись withdraw по тому же тексту, что и действующее согласие.
-- request_transfer — всегда на конкретный листинг, остальные цели — без него.
-- Нечего отзывать (согласия не было или оно уже отозвано) — null, журнал не
-- меняется. SECURITY INVOKER: вставка идёт под RLS роли API (субъект = актор)
create function app.client_withdraw_consent(p_purpose app.consent_purpose, p_listing uuid,
                                            p_source app.source, p_ip_hash bytea default null)
returns uuid
language plpgsql set search_path = ''
as $$
declare
  v_client  uuid := app.actor_id();
  v_current app.consents;
  v_id      uuid;
begin
  if app.actor_kind() is distinct from 'client' or v_client is null then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if p_purpose not in ('client_service', 'request_transfer', 'bot_notifications')
     or (p_purpose = 'request_transfer') <> (p_listing is not null) then
    raise exception 'invalid_argument' using errcode = '22023',
      detail = 'цель клиента; листинг — только и обязательно для request_transfer';
  end if;

  -- два одновременных отзыва одного согласия дают одну запись
  perform pg_advisory_xact_lock(hashtextextended(
    'bayramm.consent:' || v_client || ':' || p_purpose || ':' || coalesce(p_listing::text, ''), 0));

  select c.* into v_current
  from app.consents c
  where c.subject_kind = 'client' and c.subject_id = v_client and c.purpose = p_purpose
    and c.scope_listing_id is not distinct from p_listing
  order by c.created_at desc
  limit 1;
  if not found or v_current.action <> 'grant' then
    return null;
  end if;

  insert into app.consents (subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source, ip_hash)
  values ('client', v_client, p_purpose, 'withdraw', v_current.text_id, p_listing, p_source, p_ip_hash)
  returning id into v_id;
  return v_id;
end $$;

-- Удаление аккаунта клиентом. Порядок:
--   1. все действующие согласия — отзыв (журнал согласий);
--   2. открытые заявки (new, viewed, contacted) — отзыв от имени клиента,
--      причина account_deleted в журнале статусов;
--   3. контакты из всех его заявок стираются (purged_at);
--   4. профиль с ПДн (Telegram ID, имя, телефон) удаляется;
--   5. аккаунт помечается удалённым: псевдоним (HMAC Telegram ID) остаётся —
--      по нему новый вход восстанавливает аккаунт, а блокировку нельзя обойти
--      удалением;
--   6. все сессии отзываются;
--   7. запись в журнал действий — только числа.
-- Уже удалённый аккаунт — ни одной строки в ответе, ничего не меняется
create function app.client_delete_account(p_source app.source, p_ip_hash bytea default null)
returns table (consents_withdrawn int, requests_withdrawn int, contacts_purged int, sessions_revoked int)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_client   uuid := app.actor_id();
  v_reason   text := current_setting('app.reason', true);
  v_src      text := current_setting('app.source', true);
  v_consents int;
  v_requests int;
  v_contacts int;
  v_sessions int;
begin
  if app.actor_kind() is distinct from 'client' or v_client is null then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  perform 1 from app.clients c where c.id = v_client and c.deleted_at is null for update;
  if not found then
    return;
  end if;

  insert into app.consents (subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source, ip_hash)
  select 'client', v_client, cur.purpose, 'withdraw', cur.text_id, cur.scope_listing_id, p_source, p_ip_hash
  from app.consents_current cur
  where cur.subject_kind = 'client' and cur.subject_id = v_client and cur.action = 'grant';
  get diagnostics v_consents = row_count;

  perform set_config('app.reason', 'account_deleted', true);
  perform set_config('app.source', coalesce(p_source::text, ''), true);
  update app.requests r
  set status = 'withdrawn'
  where r.client_id = v_client and r.status in ('new', 'viewed', 'contacted');
  get diagnostics v_requests = row_count;
  perform set_config('app.reason', coalesce(v_reason, ''), true);
  perform set_config('app.source', coalesce(v_src, ''), true);

  update pii.request_contacts rc
  set contact_name = null, contact_phone = null, comment = null, purged_at = now()
  from app.requests r
  where r.id = rc.request_id and r.client_id = v_client and rc.purged_at is null;
  get diagnostics v_contacts = row_count;

  delete from pii.client_profiles p where p.client_id = v_client;

  update app.clients c set deleted_at = now(), can_message = false where c.id = v_client;

  update app.sessions s set revoked_at = now() where s.client_id = v_client and s.revoked_at is null;
  get diagnostics v_sessions = row_count;

  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('client.delete_account', 'client', v_client::text,
          jsonb_build_object('consents_withdrawn', v_consents, 'requests_withdrawn', v_requests,
                             'contacts_purged', v_contacts, 'sessions_revoked', v_sessions),
          p_source);

  return query select v_consents, v_requests, v_contacts, v_sessions;
end $$;

-- Выгрузка своих данных: аккаунт, профиль, журнал согласий, свои заявки с
-- контактами, которые клиент в них оставил, и историей статусов. Данных
-- вендоров нет: ни телефонов, ни реквизитов, ни id сотрудников вендора и
-- операторов, ни текста причин отказа — только коды.
-- SECURITY INVOKER: читает под RLS роли API; телефоны — через журналируемые
-- pii.read_* (цель self)
create function app.client_export() returns jsonb
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

-- ── права ───────────────────────────────────────────────────────────────────
-- Отдельные шаги обслуживания API не вызывает — только весь запуск целиком
revoke execute on all functions in schema app, pii from public;
grant execute on function
  app.tashkent_today(),
  app.run_daily_maintenance(),
  app.client_export(),
  app.client_withdraw_consent(app.consent_purpose, uuid, app.source, bytea),
  app.client_delete_account(app.source, bytea)
  to bayramm_api;
