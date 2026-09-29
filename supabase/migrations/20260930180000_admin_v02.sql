-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — панель оператора v0.2: работа с заявками, клиенты, уведомления,
-- настройки и команда, решения по правкам карточек.
--
--   · заметки сотрудников к заявке (app.request_notes): только на добавление,
--     видны только сотрудникам; автора и время ставит база;
--   · «напомнить вендору сейчас» — app.staff_remind_vendor: уведомление
--     vendor.ops_reminder всем привязанным пользователям вендора заявки, пока
--     она ждёт первого ответа; не чаще раза в 30 минут на заявку. «Связались» —
--     переход заявки сотрудником (actor staff): first_response_by = staff, в
--     метрику ответов вендора он не идёт;
--   · блокировка клиента с причиной — app.staff_block_client, снятие —
--     app.staff_unblock_client. Заблокированный клиент новых заявок не создаёт
--     (app.requests_before_insert, BR008) и не входит (API, 403);
--   · повтор недоставленного уведомления (dead) — app.staff_retry_outbox;
--   · настройки — app.staff_set_setting: только перечисленные ключи; границы —
--     app.setting_value_ok (добавлены sla_reminder_hours и quiet_hours), плюс
--     согласованность: напоминания раньше срока ответа, min_photos ≤ max_photos;
--   · команда — app.staff_invite (по имени пользователя Telegram, как в
--     20260929130000_staff_telegram.sql), app.staff_set_active, app.staff_set_role.
--     Себя не отключить и не понизить; последнего действующего администратора
--     не отключить и не понизить никаким путём — триггер staff_keep_admin;
--   · журнал действий сотрудников (триггер audit_staff) теперь ведётся и по
--     заявкам, заметкам и решениям по ревизиям карточек; действия выше пишут
--     его сами — только коды и id, без ПДн.
--
-- Права по ролям (admin / manager / moderator) проверяет API; функции ниже
-- проверяют их ещё раз — база не доверяет тому, кто её вызывает.
--
-- Коды ошибок (продолжение списка из 20260930110000_client_api.sql):
--   BR016 reminder_too_soon                  BR019 request_not_awaiting
--   BR017 staff_last_admin                   BR020 vendor_unreachable
--   BR018 staff_self
--
-- Откат: supabase/rollbacks/20260930180000_admin_v02.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── роль сотрудника ─────────────────────────────────────────────────────────
-- Действующий сотрудник одной из ролей — иначе forbidden_for_actor. Возвращает роль
create function app.assert_staff_role(p_roles app.staff_role[]) returns app.staff_role
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_role app.staff_role := app.current_staff_role();
begin
  if v_role is null or not (v_role = any (p_roles)) then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  return v_role;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Заявки: заметки, напоминание, журнал
-- ════════════════════════════════════════════════════════════════════════════

create table app.request_notes (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references app.requests,     -- без каскада: журнал не удаляется с заявкой
  author_id  uuid not null default app.actor_id() references app.staff,
  body       text not null check (length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default clock_timestamp()
);
create index request_notes_request on app.request_notes (request_id, created_at);

comment on table app.request_notes is
  'Заметки сотрудников к заявке: только на добавление, видны только сотрудникам';

-- Пишет только сотрудник, работающий с заявками; автор и время — из базы
create function app.request_notes_before_insert() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.assert_staff_role(array['admin', 'manager']::app.staff_role[]);
  new.author_id := app.actor_id();
  new.created_at := clock_timestamp();
  return new;
end $$;
create trigger request_notes_before_insert before insert on app.request_notes
  for each row execute function app.request_notes_before_insert();

create trigger request_notes_append_only before update or delete on app.request_notes
  for each row execute function app.forbid_mutation();
create trigger request_notes_no_truncate before truncate on app.request_notes
  for each statement execute function app.forbid_mutation();

alter table app.request_notes enable row level security;
create policy request_notes_read on app.request_notes for select to bayramm_api
  using ((select app.current_staff_role()) is not null);
create policy request_notes_insert on app.request_notes for insert to bayramm_api
  with check ((select app.current_staff_role()) is not null and author_id = (select app.actor_id()));
grant select, insert on app.request_notes to bayramm_api;

-- Журнал действий: правки заявок сотрудником (отметка «связались»), заметки
-- (только id заметки — текст остаётся в app.request_notes)
create trigger audit_staff after update on app.requests
  for each row execute function app.audit_staff_change('request', 'id', 'request', 'listing_id');
create trigger audit_staff after insert on app.request_notes
  for each row execute function app.audit_staff_change('request', 'request_id', 'request_note', 'id');

-- Напомнить вендору сейчас: заявка ждёт первого ответа (new/viewed, ответа
-- ещё не было), прошлое напоминание сотрудника — не меньше 30 минут назад.
-- Уведомление — всем привязанным к Telegram пользователям вендора заявки;
-- никому не отправить — vendor_unreachable (звонить). Возвращает число получателей
create function app.staff_remind_vendor(p_request uuid) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_request app.requests;
  v_count   int;
begin
  perform app.assert_staff_role(array['admin', 'manager']::app.staff_role[]);
  -- строка заявки блокируется: два нажатия подряд проверяются по очереди
  select r.* into v_request from app.requests r where r.id = p_request for update;
  if not found then
    raise exception 'invalid_argument' using errcode = '22023', detail = 'нет такой заявки';
  end if;
  if v_request.status not in ('new', 'viewed') or v_request.first_response_at is not null then
    raise exception 'request_not_awaiting' using errcode = 'BR019';
  end if;
  if exists (select 1 from app.outbox o
             where o.request_id = p_request and o.kind = 'vendor.ops_reminder'
               and o.created_at > now() - interval '30 minutes') then
    raise exception 'reminder_too_soon' using errcode = 'BR016';
  end if;

  v_count := app.enqueue_vendor_notice(p_request, 'vendor.ops_reminder',
    jsonb_build_object('request_id', p_request, 'staff_id', app.actor_id()),
    p_request || ':ops:' || (extract(epoch from clock_timestamp()) * 1000)::bigint);
  if v_count = 0 then
    raise exception 'vendor_unreachable' using errcode = 'BR020',
      detail = 'у вендора нет пользователя с привязанным Telegram';
  end if;

  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('request.remind', 'request', p_request::text, jsonb_build_object('recipients', v_count), 'admin');
  return v_count;
end $$;

comment on function app.staff_remind_vendor(uuid) is
  'Напоминание вендору от сотрудника: заявка ждёт первого ответа, не чаще раза в 30 минут';

-- ════════════════════════════════════════════════════════════════════════════
-- Клиенты: блокировка
-- ════════════════════════════════════════════════════════════════════════════

-- Заблокировать с причиной. Уже заблокированному — новая причина, время блокировки
-- прежнее. Причина — в app.clients, в журнал — только факт
create function app.staff_block_client(p_client uuid, p_reason text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(p_reason), '');
begin
  perform app.assert_staff_role(array['admin', 'manager']::app.staff_role[]);
  if v_reason is null then
    raise exception 'reason_required' using errcode = 'BR010';
  end if;
  update app.clients c
  set blocked_at = coalesce(c.blocked_at, now()), blocked_reason = v_reason, blocked_by = app.actor_id()
  where c.id = p_client;
  if not found then
    raise exception 'invalid_argument' using errcode = '22023', detail = 'нет такого клиента';
  end if;
  insert into app.audit_log (action, object_type, object_id, source)
  values ('client.block', 'client', p_client::text, 'admin');
end $$;

-- Снять блокировку. Не заблокирован — ничего не меняется и не пишется
create function app.staff_unblock_client(p_client uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.assert_staff_role(array['admin', 'manager']::app.staff_role[]);
  update app.clients c
  set blocked_at = null, blocked_reason = null, blocked_by = null
  where c.id = p_client and c.blocked_at is not null;
  if found then
    insert into app.audit_log (action, object_type, object_id, source)
    values ('client.unblock', 'client', p_client::text, 'admin');
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Уведомления: повтор недоставленного
-- ════════════════════════════════════════════════════════════════════════════

-- Строка dead снова в очередь с нуля попыток: её возьмёт ближайший проход
-- отправителя. Не удастся снова — снова dead (оповещение команде второй раз не
-- ставится: dedupe_key то же)
create function app.staff_retry_outbox(p_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_kind text;
begin
  perform app.assert_staff_role(array['admin']::app.staff_role[]);
  update app.outbox o
  set status = 'pending', attempts = 0, next_attempt_at = now(), enqueued_at = null, last_error = null
  where o.id = p_id and o.status = 'dead'
  returning o.kind into v_kind;
  if not found then
    raise exception 'illegal_transition' using errcode = 'BR002',
      detail = 'повторить можно только недоставленное (dead)';
  end if;
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('outbox.retry', 'outbox', p_id::text, jsonb_build_object('kind', v_kind), 'admin');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Настройки
-- ════════════════════════════════════════════════════════════════════════════

-- Та же функция, что в 20260930140000_platform_hardening.sql, плюс форма
-- sla_reminder_hours (до двух целых часов 1–72 по возрастанию) и quiet_hours
-- ({"from": "ЧЧ:ММ", "to": "ЧЧ:ММ"}). Проверки по шагам: порядок условий в
-- одном выражении SQL не гарантирован, а приведение к int на мусоре упадёт
create or replace function app.setting_value_ok(p_key text, p_value jsonb) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  v_min int;
  v_max int;
begin
  case p_key
    when 'sla_reminder_hours' then
      if jsonb_typeof(p_value) is distinct from 'array' or jsonb_array_length(p_value) > 2 then
        return false;
      end if;
      if exists (select 1 from jsonb_array_elements(p_value) e
                 where jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^[0-9]{1,2}$') then
        return false;
      end if;
      return not exists (select 1 from jsonb_array_elements(p_value) e
                         where (e #>> '{}')::int not between 1 and 72)
         and (jsonb_array_length(p_value) < 2 or (p_value ->> 0)::int < (p_value ->> 1)::int);
    when 'quiet_hours' then
      if jsonb_typeof(p_value) is distinct from 'object' then
        return false;
      end if;
      return (select array_agg(k order by k) from jsonb_object_keys(p_value) k) = array['from', 'to']
         and coalesce(p_value ->> 'from', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         and coalesce(p_value ->> 'to', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
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

-- Изменить настройку (администратор). Ключи — только эти; прочие настройки
-- (если появятся) меняются миграцией. Значение вне границ или не согласованное с
-- другими настройками — check_violation (23514), DETAIL — ключ
create function app.staff_set_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_old       jsonb;
  v_sla       int;
  v_reminders jsonb;
  v_min       int;
  v_max       int;
begin
  perform app.assert_staff_role(array['admin']::app.staff_role[]);
  if p_key is null or p_key <> all (array[
       'sla_hours', 'sla_reminder_hours', 'quiet_hours', 'min_photos', 'max_photos', 'client_requests_per_day',
       'request_contact_retention_days', 'otp_retention_hours', 'session_retention_days']) then
    raise exception 'invalid_argument' using errcode = '22023', detail = 'эта настройка меняется только миграцией';
  end if;
  if p_value is null or not app.setting_value_ok(p_key, p_value) then
    raise exception 'invalid_setting' using errcode = '23514', detail = p_key;
  end if;

  -- согласованность ключей проверяется под одной блокировкой: две правки разных
  -- ключей не разойдутся
  perform pg_advisory_xact_lock(hashtextextended('bayramm.settings', 0));
  select s.value into v_old from app.settings s where s.key = p_key for update;
  if not found then
    raise exception 'invalid_argument' using errcode = '22023', detail = 'нет такой настройки';
  end if;

  v_sla := case when p_key = 'sla_hours' then (p_value #>> '{}')::int else app.setting_int('sla_hours') end;
  v_reminders := case when p_key = 'sla_reminder_hours' then p_value
                      else (select s.value from app.settings s where s.key = 'sla_reminder_hours') end;
  if jsonb_typeof(v_reminders) = 'array' and exists (
       select 1 from jsonb_array_elements(v_reminders) e
       where jsonb_typeof(e) = 'number' and (e #>> '{}')::numeric >= v_sla) then
    raise exception 'invalid_setting' using errcode = '23514', detail = p_key;
  end if;

  v_min := case when p_key = 'min_photos' then (p_value #>> '{}')::int else app.setting_int('min_photos') end;
  v_max := case when p_key = 'max_photos' then (p_value #>> '{}')::int else app.setting_int('max_photos') end;
  if v_min > v_max then
    raise exception 'invalid_setting' using errcode = '23514', detail = p_key;
  end if;

  if v_old = p_value then
    return;
  end if;
  update app.settings s set value = p_value, updated_at = now(), updated_by = app.actor_id()
  where s.key = p_key;
  -- значения настроек — не ПДн: в журнал идут было/стало
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('settings.update', 'setting', p_key, jsonb_build_object('from', v_old, 'to', p_value), 'admin');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Команда
-- ════════════════════════════════════════════════════════════════════════════

-- Последний действующий администратор не может перестать им быть — ни через API,
-- ни ручным SQL: иначе командой и настройками некому управлять. Параллельные
-- правки идут по очереди (advisory-блокировка), проверка — после неё
create function app.staff_keep_admin() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.active and old.role = 'admin' and not (new.active and new.role = 'admin') then
    perform pg_advisory_xact_lock(hashtextextended('bayramm.staff_admins', 0));
    if not exists (select 1 from app.staff s
                   where s.active and s.role = 'admin' and s.id <> new.id) then
      raise exception 'staff_last_admin' using errcode = 'BR017',
        detail = 'должен остаться хотя бы один действующий администратор';
    end if;
  end if;
  return new;
end $$;
create trigger staff_keep_admin before update of active, role on app.staff
  for each row execute function app.staff_keep_admin();

-- Пригласить сотрудника: имя пользователя Telegram (приводит и проверяет на
-- занятость триггер staff_profiles_username_guard), имя для панели, роль.
-- При первом входе приглашение привязывается к Telegram ID (app.staff_sign_in)
create function app.staff_invite(p_username text, p_display_name text, p_role app.staff_role) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform app.assert_staff_role(array['admin']::app.staff_role[]);
  if p_role is null or coalesce(btrim(p_username), '') = '' or coalesce(btrim(p_display_name), '') = '' then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  insert into app.staff (role) values (p_role) returning id into v_id;
  insert into pii.staff_profiles (staff_id, display_name, telegram_username)
  values (v_id, btrim(p_display_name), p_username);
  -- в журнал — id и роль, без имени
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('staff.invite', 'staff', v_id::text, jsonb_build_object('role', p_role), 'admin');
  return v_id;
end $$;

-- Отключить или снова включить сотрудника. Себя — нельзя. Отключение действует
-- сразу: сессии отзываются (и без этого API не пустит отключённого)
create function app.staff_set_active(p_staff uuid, p_active boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_active boolean;
begin
  perform app.assert_staff_role(array['admin']::app.staff_role[]);
  if p_active is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  if p_staff = app.actor_id() then
    raise exception 'staff_self' using errcode = 'BR018';
  end if;
  select s.active into v_active from app.staff s where s.id = p_staff for update;
  if not found then
    raise exception 'invalid_argument' using errcode = '22023', detail = 'нет такого сотрудника';
  end if;
  if v_active = p_active then
    return;
  end if;

  update app.staff s set active = p_active where s.id = p_staff;
  if not p_active then
    update app.sessions ss set revoked_at = now() where ss.staff_id = p_staff and ss.revoked_at is null;
  end if;
  insert into app.audit_log (action, object_type, object_id, source)
  values (case when p_active then 'staff.activate' else 'staff.deactivate' end, 'staff', p_staff::text, 'admin');
end $$;

-- Сменить роль сотрудника. Свою — нельзя
create function app.staff_set_role(p_staff uuid, p_role app.staff_role) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_role app.staff_role;
begin
  perform app.assert_staff_role(array['admin']::app.staff_role[]);
  if p_role is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  if p_staff = app.actor_id() then
    raise exception 'staff_self' using errcode = 'BR018';
  end if;
  select s.role into v_role from app.staff s where s.id = p_staff for update;
  if not found then
    raise exception 'invalid_argument' using errcode = '22023', detail = 'нет такого сотрудника';
  end if;
  if v_role = p_role then
    return;
  end if;
  update app.staff s set role = p_role where s.id = p_staff;
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('staff.role', 'staff', p_staff::text, jsonb_build_object('from', v_role, 'to', p_role), 'admin');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Ревизии карточек: решение сотрудника — в журнал
-- ════════════════════════════════════════════════════════════════════════════
-- Решение (одобрить или отклонить) ставит API; кто и когда — триггер
-- listing_revisions_guard; здесь — запись в журнал: поля и from/to статуса
create trigger audit_staff after update on app.listing_revisions
  for each row execute function app.audit_staff_change('listing', 'listing_id', 'listing_revision', 'id');

-- ── права ───────────────────────────────────────────────────────────────────
-- Триггерные и служебные функции API не вызывает — только действия сотрудников
revoke execute on all functions in schema app, pii from public;
grant execute on function
  app.staff_remind_vendor(uuid),
  app.staff_block_client(uuid, text),
  app.staff_unblock_client(uuid),
  app.staff_retry_outbox(uuid),
  app.staff_set_setting(text, jsonb),
  app.staff_invite(text, text, app.staff_role),
  app.staff_set_active(uuid, boolean),
  app.staff_set_role(uuid, app.staff_role)
  to bayramm_api;
