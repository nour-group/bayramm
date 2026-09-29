-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — правки карточки от партнёра и приглашение сотрудника по телефону.
--
--   · партнёр предлагает правку карточки из кабинета: строка app.listing_revisions
--     (вставку и отзыв ему уже дают RLS и listing_revisions_guard, одна открытая
--     правка на листинг — индекс listing_revisions_one_pending). Новая правка от
--     партнёра — оповещение команде ops.revision_submitted: действующим сотрудникам
--     с правом решать по правкам (администратор, модератор — как revisions.moderate
--     в apps/api/src/staff/access.ts), у которых есть чат с ботом. В payload — только
--     id правки: площадку, код вендора и поля текст берёт при отправке;
--   · app.enqueue_staff_alert — как app.enqueue_ops_alert, но получатели —
--     сотрудники перечисленных ролей;
--   · приглашение по телефону — app.staff_invite_phone: HMAC номера
--     (app.staff.phone_hash; сам номер нигде не хранится), имя для панели и роль.
--     Номер — у одного действующего сотрудника (как имя пользователя Telegram).
--     Приглашение принимает вход аккаунта кодом на этот номер
--     (app.account_bind_phone); номер уже подтверждён у аккаунта — сразу.
--
-- Откат: supabase/rollbacks/20260930200000_revisions_phone_invites.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── оповещение сотрудникам ролей ────────────────────────────────────────────
create function app.enqueue_staff_alert(p_kind text, p_roles app.staff_role[], p_payload jsonb, p_event text)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  insert into app.outbox (kind, recipient_kind, recipient_id, payload, dedupe_key)
  select p_kind, 'staff', s.id, p_payload, p_kind || ':' || p_event || ':' || s.id
  from app.staff s
  join pii.staff_profiles p on p.staff_id = s.id
  where s.active and s.role = any (p_roles) and p.telegram_chat_id is not null
  on conflict (dedupe_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ── правка карточки от партнёра — команде ───────────────────────────────────
-- Правки, которые завёл не партнёр (сотрудник, ручной SQL), не оповещают
create function app.listing_revisions_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'pending' and app.effective_actor() = 'vendor_user' then
    perform app.enqueue_staff_alert('ops.revision_submitted', array['admin', 'moderator']::app.staff_role[],
                                    jsonb_build_object('revision_id', new.id), new.id::text);
  end if;
  return null;
end $$;
create trigger listing_revisions_notify after insert on app.listing_revisions
  for each row execute function app.listing_revisions_notify();

-- ── приглашение сотрудника по телефону ──────────────────────────────────────
-- p_phone_hash — HMAC(ID_HASH_KEY, «+998XXXXXXXXX»), считает API. Номер занят, если
-- он у действующего сотрудника или у аккаунта с этим номером уже есть роль
-- сотрудника (тогда её включают в списке, а не приглашают заново). Если аккаунт
-- уже подтвердил этот номер, приглашение принимается сразу — тем же путём, что
-- при входе кодом (app.account_bind_phone: роли с этим номером — к аккаунту)
create function app.staff_invite_phone(p_phone_hash bytea, p_display_name text, p_role app.staff_role)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id      uuid;
  v_account uuid;
begin
  perform app.assert_staff_role(array['admin']::app.staff_role[]);
  if p_role is null or octet_length(p_phone_hash) is distinct from 32
     or coalesce(btrim(p_display_name), '') = '' then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  -- Параллельные приглашения одного номера проверяются по очереди
  perform pg_advisory_xact_lock(hashtextextended('bayramm.staff_phone:' || encode(p_phone_hash, 'hex'), 0));
  select i.account_id into v_account from app.account_identities i
  where i.kind = 'phone' and i.value_hash = p_phone_hash;
  if exists (select 1 from app.staff s where s.active and s.phone_hash = p_phone_hash)
     or (v_account is not null and exists (select 1 from app.staff s where s.account_id = v_account)) then
    raise exception 'staff_phone_taken' using errcode = '23505', constraint = 'staff_phone_active',
      detail = 'номер уже у сотрудника';
  end if;

  insert into app.staff (role, phone_hash) values (p_role, p_phone_hash) returning id into v_id;
  insert into pii.staff_profiles (staff_id, display_name) values (v_id, btrim(p_display_name));
  -- в журнал — id, роль и способ, без имени и номера
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('staff.invite', 'staff', v_id::text, jsonb_build_object('role', p_role, 'via', 'phone'), 'admin');

  if v_account is not null then
    perform app.account_bind_phone(v_account, p_phone_hash, 'admin');
  end if;
  return v_id;
end $$;

-- ── права ───────────────────────────────────────────────────────────────────
revoke execute on all functions in schema app, pii from public;
grant execute on function app.staff_invite_phone(bytea, text, app.staff_role) to bayramm_api;
