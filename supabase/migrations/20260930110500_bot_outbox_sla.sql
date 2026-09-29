-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — бот Telegram, уведомления (outbox) и SLA 12 часов.
--
--   · вебхук бота: повторы одного update_id отсекает app.telegram_updates
--     (Telegram повторяет доставку до суток; храним три дня, чистит cron API);
--   · вендор привязывает Telegram, поделившись своим контактом с ботом:
--     app.vendor_user_claim_telegram под актором system. Номер сверяется по
--     HMAC (app.vendor_users.phone_hash), привязку нельзя перевесить на другой
--     аккаунт — только снять и привязать заново;
--   · /start: бот может писать клиенту (can_message), сотруднику — чат для
--     оповещений (pii.staff_profiles.telegram_chat_id): app.telegram_started;
--   · уведомления ставятся в app.outbox триггерами — остальному коду ничего
--     делать не нужно. В payload — только id и коды, текст собирается при
--     отправке:
--       vendor.request_new     вендору: новая заявка (каждому привязанному пользователю)
--       vendor.sla_reminder    вендору: напоминание, этапы 1 и 2 (4 и 8 часов)
--       client.request_status  клиенту: ответили, договорились, отказ — только
--                              с согласием bot_notifications
--       client.sla_breach      клиенту: вендор молчит 12 часов — предложение
--                              посмотреть похожие (только предложение)
--       ops.sla_breach         администраторам: просрочка SLA
--       ops.outbox_dead        администраторам: уведомление не доставлено
--   · этапы SLA двигает app.sla_advance (API по cron): когда наступает этап и
--     не тихие ли часы по Ташкенту, решает API, здесь — атомарный сдвиг этапа
--     и постановка уведомлений. Этап только растёт — повтор ничего не шлёт.
--
-- Откат: supabase/rollbacks/20260930110500_bot_outbox_sla.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── вебхук: уже обработанные обновления ─────────────────────────────────────
create table app.telegram_updates (
  update_id   bigint primary key check (update_id >= 0),
  received_at timestamptz not null default now()
);
create index telegram_updates_received on app.telegram_updates (received_at);

comment on table app.telegram_updates is
  'update_id уже обработанных обновлений бота — повтор доставки не обрабатывается дважды. Без содержимого';

-- ── пользователь вендора: привязка к Telegram ───────────────────────────────
-- Хэш и время привязки — вместе; перевесить привязку на другой аккаунт нельзя
-- (как у сотрудников): только снять оба поля и привязать заново
alter table app.vendor_users
  add constraint vendor_users_tg_link_consistent check ((tg_user_hash is null) = (tg_linked_at is null));

create function app.vendor_users_tg_link_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.tg_user_hash is not null and new.tg_user_hash is not null and new.tg_user_hash <> old.tg_user_hash then
    raise exception 'immutable_column' using errcode = 'BR006',
      detail = 'привязку к Telegram можно только снять, но не перевесить';
  end if;
  return new;
end $$;
create trigger vendor_users_tg_link_guard before update of tg_user_hash on app.vendor_users
  for each row execute function app.vendor_users_tg_link_guard();

-- ── outbox: зависшие отправки ───────────────────────────────────────────────
-- enqueued_at — момент, когда строку взял отправитель (status = sending). Если
-- воркер упал посреди отправки, строку через 10 минут возьмёт следующий
create index outbox_sending on app.outbox (enqueued_at) where status = 'sending';

comment on column app.outbox.enqueued_at is 'Когда строку взял отправитель (status = sending)';

-- ════════════════════════════════════════════════════════════════════════════
-- Кому можно писать
-- ════════════════════════════════════════════════════════════════════════════

-- Клиенту — только с действующим согласием bot_notifications (последнее событие —
-- grant), если бот может ему писать и аккаунт не удалён
create function app.client_notifiable(p_client uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from app.clients c
                 where c.id = p_client and c.can_message and c.deleted_at is null)
     and coalesce((select c.action = 'grant' from app.consents c
                    where c.subject_kind = 'client' and c.subject_id = p_client
                      and c.purpose = 'bot_notifications'
                    order by c.created_at desc
                    limit 1), false)
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Постановка в outbox. dedupe_key = <вид>:<событие>[:<получатель>] — одно
-- событие не ставится дважды. Только внутренние: API их не вызывает
-- ════════════════════════════════════════════════════════════════════════════

-- Всем привязанным к Telegram и не отключённым пользователям вендора заявки
create function app.enqueue_vendor_notice(p_request uuid, p_kind text, p_payload jsonb, p_event text)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  insert into app.outbox (kind, recipient_kind, recipient_id, request_id, payload, dedupe_key)
  select p_kind, 'vendor_user', u.id, r.id, p_payload, p_kind || ':' || p_event || ':' || u.id
  from app.requests r
  join app.vendor_users u on u.vendor_id = r.vendor_id
  join pii.vendor_user_profiles p on p.vendor_user_id = u.id
  where r.id = p_request and u.disabled_at is null and u.tg_linked_at is not null
    and p.telegram_chat_id is not null
  on conflict (dedupe_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Клиенту заявки, если ему можно писать; p_at — не раньше этого момента
create function app.enqueue_client_notice(p_request uuid, p_kind text, p_payload jsonb, p_event text,
                                          p_at timestamptz default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  insert into app.outbox (kind, recipient_kind, recipient_id, request_id, payload, dedupe_key, next_attempt_at)
  select p_kind, 'client', r.client_id, r.id, p_payload, p_kind || ':' || p_event,
         greatest(now(), coalesce(p_at, now()))
  from app.requests r
  where r.id = p_request and app.client_notifiable(r.client_id)
  on conflict (dedupe_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Оповещение команды: действующим администраторам, у которых есть чат с ботом
-- (написали боту /start — app.telegram_started)
create function app.enqueue_ops_alert(p_kind text, p_payload jsonb, p_event text, p_request uuid default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  insert into app.outbox (kind, recipient_kind, recipient_id, request_id, payload, dedupe_key)
  select p_kind, 'staff', s.id, p_request, p_payload, p_kind || ':' || p_event || ':' || s.id
  from app.staff s
  join pii.staff_profiles p on p.staff_id = s.id
  where s.active and s.role = 'admin' and p.telegram_chat_id is not null
  on conflict (dedupe_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Триггеры уведомлений
-- ════════════════════════════════════════════════════════════════════════════

-- Каждое изменение статуса заявки пишется в request_status_log ровно один раз
-- (requests_log_status) — поэтому уведомления ставятся от журнала: у события
-- есть свой id, и повтор статуса (договорились → ответили → договорились) —
-- новое событие, а не дубликат.
--   · создание (from_status null) — вендору vendor.request_new;
--   · клиенту — первый ответ (ответили), «договорились» и отказ. «Вернуть в
--     активные» (deal/declined → contacted) клиенту не шлём: это правка вендора
--     у себя, а не ответ
create function app.request_status_log_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.from_status is null then
    perform app.enqueue_vendor_notice(new.request_id, 'vendor.request_new',
      jsonb_build_object('request_id', new.request_id), new.request_id::text);
  elsif new.to_status in ('contacted', 'deal', 'declined')
        and not (new.to_status = 'contacted' and new.from_status in ('deal', 'declined')) then
    perform app.enqueue_client_notice(new.request_id, 'client.request_status',
      jsonb_build_object('request_id', new.request_id, 'status', new.to_status), new.id::text);
  end if;
  return null;
end $$;
create trigger request_status_log_notify after insert on app.request_status_log
  for each row execute function app.request_status_log_notify();

-- Уведомление не доставлено — администраторам. Оповещения команды о самих себе
-- не оповещают (иначе недоставка оповещения порождала бы новые)
create function app.outbox_dead_alert() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.enqueue_ops_alert('ops.outbox_dead', jsonb_build_object('outbox_id', new.id, 'kind', new.kind),
                                new.id::text, new.request_id);
  return null;
end $$;
create trigger outbox_dead_alert after update of status on app.outbox
  for each row when (new.status = 'dead' and old.status <> 'dead' and new.kind !~ '^ops\.')
  execute function app.outbox_dead_alert();

-- ════════════════════════════════════════════════════════════════════════════
-- Функции для API (только актор system)
-- ════════════════════════════════════════════════════════════════════════════

-- Привязка пользователя вендора к Telegram по контакту — так вендор входит в кабинет.
-- API вызывает после проверки, что контакт — свой (contact.user_id = from.id),
-- то есть номер подтверждён самим Telegram. p_phone — тот же номер, что в
-- p_phone_hash (+998XXXXXXXXX): нужен, если профиль ещё не заведён.
-- Результат:
--   claimed          — привязали сейчас (запись в audit_log);
--   linked           — уже привязан этот же аккаунт (повтор ничего не меняет, кроме чата);
--   linked_elsewhere — номер уже привязан к другому аккаунту Telegram: отказ;
--   telegram_taken   — этот Telegram уже у другого пользователя вендора: отказ;
--   not_found        — такого действующего пользователя нет: ничего не пишем
create function app.vendor_user_claim_telegram(p_phone_hash bytea, p_phone text, p_tg_user_hash bytea,
                                               p_telegram_user_id bigint, p_chat_id bigint)
returns table (result text, vendor_user_id uuid, vendor_id uuid, locale app.locale)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user app.vendor_users;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if octet_length(p_phone_hash) is distinct from 32 or octet_length(p_tg_user_hash) is distinct from 32
     or p_phone is null or p_phone !~ '^\+998[0-9]{9}$'
     or p_telegram_user_id is null or p_telegram_user_id <= 0 or p_chat_id is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  -- Строка блокируется: параллельные привязки одного номера идут по очереди
  select u.* into v_user from app.vendor_users u
  where u.phone_hash = p_phone_hash and u.disabled_at is null
  for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::app.locale;
    return;
  end if;

  if v_user.tg_user_hash = p_tg_user_hash then
    update pii.vendor_user_profiles p set telegram_chat_id = p_chat_id
    where p.vendor_user_id = v_user.id and p.telegram_chat_id is distinct from p_chat_id;
    return query select 'linked'::text, v_user.id, v_user.vendor_id, v_user.locale;
    return;
  end if;
  if v_user.tg_user_hash is not null then
    return query select 'linked_elsewhere'::text, null::uuid, null::uuid, null::app.locale;
    return;
  end if;

  begin
    update app.vendor_users u set tg_user_hash = p_tg_user_hash, tg_linked_at = now() where u.id = v_user.id;
    insert into pii.vendor_user_profiles (vendor_user_id, phone, telegram_user_id, telegram_chat_id)
    values (v_user.id, p_phone, p_telegram_user_id, p_chat_id)
    on conflict on constraint vendor_user_profiles_pkey do update
      set telegram_user_id = excluded.telegram_user_id, telegram_chat_id = excluded.telegram_chat_id;
  exception when unique_violation then
    -- этот Telegram (или его хэш) уже у другого пользователя вендора
    return query select 'telegram_taken'::text, null::uuid, null::uuid, null::app.locale;
    return;
  end;

  -- в журнал — только id, без номера и Telegram ID
  insert into app.audit_log (actor_kind, actor_id, action, object_type, object_id, detail, source)
  values ('system', null, 'vendor_user.telegram_claim', 'vendor_user', v_user.id::text,
          jsonb_build_object('vendor_id', v_user.vendor_id), 'partner_bot');

  return query select 'claimed'::text, v_user.id, v_user.vendor_id, v_user.locale;
end $$;

comment on function app.vendor_user_claim_telegram(bytea, text, bytea, bigint, bigint) is
  'Привязка пользователя вендора к Telegram по своему контакту из бота. Только актор system';

-- Человек написал боту (/start): теперь бот может ему писать.
--   · клиент с этим Telegram — can_message;
--   · действующий сотрудник — чат для оповещений команды;
--   · привязанный пользователь вендора — чат для уведомлений (если сменился).
-- Никого не создаёт. p_tg_hash — HMAC(ID_HASH_KEY, Telegram ID), как у клиентов,
-- сотрудников и пользователей вендоров
create function app.telegram_started(p_tg_hash bytea, p_chat_id bigint)
returns table (staff boolean, vendor boolean)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_staff  uuid;
  v_vendor uuid;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if octet_length(p_tg_hash) is distinct from 32 or p_chat_id is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  update app.clients c set can_message = true
  where c.tg_id_hash = p_tg_hash and not c.can_message;

  select s.id into v_staff from app.staff s where s.tg_id_hash = p_tg_hash and s.active;
  if v_staff is not null then
    update pii.staff_profiles p set telegram_chat_id = p_chat_id
    where p.staff_id = v_staff and p.telegram_chat_id is distinct from p_chat_id;
  end if;

  select u.id into v_vendor from app.vendor_users u
  where u.tg_user_hash = p_tg_hash and u.disabled_at is null;
  if v_vendor is not null then
    update pii.vendor_user_profiles p set telegram_chat_id = p_chat_id
    where p.vendor_user_id = v_vendor and p.telegram_chat_id is distinct from p_chat_id;
  end if;

  return query select v_staff is not null, v_vendor is not null;
end $$;

comment on function app.telegram_started(bytea, bigint) is
  'Человек написал боту: клиенту — can_message, сотруднику и вендору — чат для уведомлений. Только актор system';

-- Сдвиг этапа SLA заявки без ответа (new/viewed, first_response_at null):
--   1, 2 — напоминание вендору;
--   3    — срок вышел: sla_breached_at; клиенту — предложение посмотреть похожие
--          не раньше p_client_at (API переносит его из тихих часов на утро),
--          администраторам — оповещение.
-- Этап только растёт; срок нарушения проверяется по часам базы. false — этап
-- уже сдвинут (параллельный запуск), вендор успел ответить или срок не вышел
create function app.sla_advance(p_request uuid, p_stage smallint, p_client_at timestamptz default null)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_request app.requests;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if p_stage is null or p_stage not between 1 and 3 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  select r.* into v_request from app.requests r where r.id = p_request for update;
  if not found or v_request.sla_stage >= p_stage or v_request.first_response_at is not null
     or v_request.status not in ('new', 'viewed')
     or (p_stage = 3 and v_request.sla_due_at > now()) then
    return false;
  end if;

  update app.requests r
  set sla_stage = p_stage,
      sla_breached_at = case when p_stage = 3 then now() else r.sla_breached_at end
  where r.id = p_request;

  if p_stage < 3 then
    perform app.enqueue_vendor_notice(p_request, 'vendor.sla_reminder',
      jsonb_build_object('request_id', p_request, 'stage', p_stage), p_request || ':' || p_stage);
  else
    perform app.enqueue_client_notice(p_request, 'client.sla_breach',
      jsonb_build_object('request_id', p_request), p_request::text, p_client_at);
    perform app.enqueue_ops_alert('ops.sla_breach', jsonb_build_object('request_id', p_request),
      p_request::text, p_request);
  end if;
  return true;
end $$;

comment on function app.sla_advance(uuid, smallint, timestamptz) is
  'Этап SLA заявки: напоминания вендору (1, 2), просрочка (3). Идемпотентно. Только актор system';

-- ════════════════════════════════════════════════════════════════════════════
-- RLS и права
-- ════════════════════════════════════════════════════════════════════════════

-- Обработанные обновления видит и пишет только система (вебхук и чистка по cron)
alter table app.telegram_updates enable row level security;
create policy telegram_updates_system on app.telegram_updates for all to bayramm_api
  using ((select app.actor_kind()) = 'system') with check ((select app.actor_kind()) = 'system');
grant select, insert, delete on app.telegram_updates to bayramm_api;

revoke execute on all functions in schema app, pii from public;
grant execute on function
  app.client_notifiable(uuid),
  app.vendor_user_claim_telegram(bytea, text, bytea, bigint, bigint),
  app.telegram_started(bytea, bigint),
  app.sla_advance(uuid, smallint, timestamptz)
  to bayramm_api;
