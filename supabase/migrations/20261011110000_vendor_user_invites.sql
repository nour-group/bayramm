-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — пользователи кабинета вендора: приглашение, владелец, удаление.
--
--   · приглашение — app.staff_invite_vendor_user (администратор, менеджер): HMAC номера,
--     профиль (номер, имя), роль owner | member и язык уведомлений. Номер уже подтверждён
--     у действующего аккаунта — приглашение принимается сразу тем же путём, что вход кодом
--     (app.account_bind_phone), как у приглашения сотрудника по телефону. Тот же номер у
--     вендора — 23505 vendor_users_vendor_phone_key; человек с этим номером уже в кабинете
--     под другим номером — BR032;
--   · у кабинета всегда есть владелец: если у вендора есть действующие пользователи, хотя бы
--     один из них — действующий владелец (BR031). Триггер vendor_keep_owner проверяет итог
--     оператора (AFTER), поэтому удаление всех пользователей вендора одним оператором
--     (сброс демо, удаление вендора) проходит. Функция, которая удаляет вендора по шагам,
--     ставит app.deleting_vendor = id вендора (set_config(…, true)) — проверка для него
--     пропускается. Пригласить сотрудника площадки, пока владельца нет, тоже нельзя (BR031);
--   · убрать пользователя из кабинета — app.staff_remove_vendor_user: его сессии до
--     аккаунтов, неотправленные ему уведомления и профиль (каскад) уходят вместе с ним,
--     аккаунт человека остаётся. DELETE у API нет — только эта функция;
--   · чат для уведомлений: членство получило аккаунт с Telegram (код на телефон, контакт в
--     боте, Telegram добавили к аккаунту) — чат берётся из того, что бот уже знает об этом
--     человеке: другие его кабинеты, роль сотрудника, клиент, которому бот может писать.
--     Раньше привязка по телефону ставила «Telegram привязан», но без чата уведомления не
--     уходили, пока человек не напишет боту. Такие строки заполняются здесь же, без
--     уведомлений;
--   · vendor.access_granted — партнёру, когда приглашение принято и боту есть куда писать:
--     «вас добавили в кабинет», кнопка кабинета. Один раз на пользователя (dedupe_key).
--
-- В журнал — только id, коды и флаги: vendor_user.invite { vendor_id, role, via, accepted },
-- vendor_user.remove { vendor_id, role, had_account }. Принятие сразу при приглашении пишет
-- система, как при входе кодом (vendor_user.account_bind).
--
-- Коды ошибок (продолжение списка из 20261001120100_categories_services.sql):
--   BR031 vendor_last_owner                  BR032 vendor_user_exists
--
-- Откат: supabase/rollbacks/20261011110000_vendor_user_invites.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- Владелец кабинета
-- ════════════════════════════════════════════════════════════════════════════

-- Параллельные правки пользователей одного вендора проверяются по очереди
-- (advisory-блокировка на вендора, её же берёт приглашение). Проверка — после
-- оператора: строки, которые он ещё изменит, не мешают
create function app.vendor_keep_owner() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- vendor_id не меняется (vendor_users_guard): old годится и для UPDATE, и для DELETE
  if current_setting('app.deleting_vendor', true) = old.vendor_id::text then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bayramm.vendor_owners:' || old.vendor_id::text, 0));
  if exists (select 1 from app.vendor_users u where u.vendor_id = old.vendor_id and u.disabled_at is null)
     and not exists (select 1 from app.vendor_users u
                     where u.vendor_id = old.vendor_id and u.disabled_at is null and u.role = 'owner') then
    raise exception 'vendor_last_owner' using errcode = 'BR031',
      detail = 'у кабинета с действующими пользователями должен остаться действующий владелец';
  end if;
  return null;
end $$;

-- Владелец перестал быть действующим владельцем или включили пользователя (сотрудник
-- площадки без владельца). Прочие правки старых строк не проверяются
create trigger vendor_keep_owner after update of role, disabled_at on app.vendor_users
  for each row
  when ((old.role = 'owner' and old.disabled_at is null and (new.role <> 'owner' or new.disabled_at is not null))
        or (old.disabled_at is not null and new.disabled_at is null))
  execute function app.vendor_keep_owner();
create trigger vendor_keep_owner_delete after delete on app.vendor_users
  for each row when (old.role = 'owner' and old.disabled_at is null)
  execute function app.vendor_keep_owner();

-- ════════════════════════════════════════════════════════════════════════════
-- Привязка уведомлений и «вас добавили в кабинет»
-- ════════════════════════════════════════════════════════════════════════════

-- Telegram ID и чат пользователя вендора — из того, что уже известно о его аккаунте:
-- чат другого его кабинета, чат роли сотрудника, Telegram клиента, которому бот может
-- писать (в личном чате id чата = Telegram ID). Только для того же Telegram, что в
-- привязке; уже заполненное не меняется
create function app.vendor_user_fill_telegram(p_user uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user app.vendor_users;
  v_tg   bigint;
  v_chat bigint;
begin
  select u.* into v_user from app.vendor_users u where u.id = p_user;
  if v_user.account_id is null or v_user.tg_user_hash is null then
    return;
  end if;
  select ap.telegram_id into v_tg from pii.account_profiles ap where ap.account_id = v_user.account_id;
  select coalesce(
    (select p.telegram_chat_id
       from app.vendor_users u join pii.vendor_user_profiles p on p.vendor_user_id = u.id
      where u.account_id = v_user.account_id and u.id <> v_user.id and u.tg_user_hash = v_user.tg_user_hash
        and p.telegram_chat_id is not null
      order by p.updated_at desc
      limit 1),
    (select p.telegram_chat_id
       from app.staff s join pii.staff_profiles p on p.staff_id = s.id
      where s.account_id = v_user.account_id and s.tg_id_hash = v_user.tg_user_hash
        and p.telegram_chat_id is not null),
    (select v_tg
       from app.clients c
      where c.account_id = v_user.account_id and c.tg_id_hash = v_user.tg_user_hash
        and c.can_message and c.deleted_at is null))
  into v_chat;

  update pii.vendor_user_profiles p
  set telegram_user_id = coalesce(p.telegram_user_id, v_tg),
      telegram_chat_id = coalesce(p.telegram_chat_id, v_chat)
  where p.vendor_user_id = v_user.id
    and ((p.telegram_user_id is null and v_tg is not null) or (p.telegram_chat_id is null and v_chat is not null));
end $$;

-- «Вас добавили в кабинет» — действующему пользователю с аккаунтом, если боту есть куда
-- писать (те же условия, что у app.enqueue_vendor_notice). Один раз на пользователя.
-- В payload — только id вендора: название и язык берутся при отправке
create function app.enqueue_vendor_access_granted(p_user uuid) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  insert into app.outbox (kind, recipient_kind, recipient_id, payload, dedupe_key)
  select 'vendor.access_granted', 'vendor_user', u.id, jsonb_build_object('vendor_id', u.vendor_id),
         'vendor.access_granted:' || u.id
  from app.vendor_users u
  join pii.vendor_user_profiles p on p.vendor_user_id = u.id
  where u.id = p_user and u.disabled_at is null and u.account_id is not null and u.tg_linked_at is not null
    and p.telegram_chat_id is not null
  on conflict (dedupe_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Членство получило аккаунт или привязку Telegram — любым путём: вход кодом на телефон
-- (app.account_bind_phone), контакт в боте (app.vendor_user_claim_telegram), Telegram,
-- добавленный к аккаунту (app.account_bind_telegram_rows). Чат — из известного об
-- аккаунте; есть чат — партнёру vendor.access_granted. Контакт в боте пишет чат сам после
-- этой строки — тогда бот отвечает партнёру прямо в чате, уведомление не нужно
create function app.vendor_users_bound() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.vendor_user_fill_telegram(new.id);
  perform app.enqueue_vendor_access_granted(new.id);
  return null;
end $$;
create trigger vendor_users_bound after update of account_id, tg_user_hash on app.vendor_users
  for each row
  when (new.account_id is not null and new.tg_user_hash is not null
        and (old.account_id is distinct from new.account_id or old.tg_user_hash is distinct from new.tg_user_hash))
  execute function app.vendor_users_bound();

-- Привязанные раньше без чата — чат из известного, без уведомлений
do $$
begin
  perform app.vendor_user_fill_telegram(u.id)
  from app.vendor_users u
  join pii.vendor_user_profiles p on p.vendor_user_id = u.id
  where u.account_id is not null and u.tg_user_hash is not null and p.telegram_chat_id is null;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Действия сотрудников
-- ════════════════════════════════════════════════════════════════════════════

-- Пригласить пользователя в кабинет вендора. p_phone_hash — HMAC(ID_HASH_KEY,
-- «+998XXXXXXXXX») того же номера p_phone, считает API. Сотрудник площадки — только к
-- вендору, у которого уже есть действующий владелец. accepted — номер уже подтверждён у
-- действующего аккаунта и приглашение принято сразу
create function app.staff_invite_vendor_user(p_vendor uuid, p_phone_hash bytea, p_phone text, p_full_name text,
                                             p_role text, p_locale app.locale)
returns table (vendor_user_id uuid, accepted boolean)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_name     text := nullif(btrim(p_full_name), '');
  v_id       uuid;
  v_account  uuid;
  v_accepted boolean;
  v_kind     text;
  v_actor    text;
begin
  perform app.assert_staff_role(array['admin', 'manager']::app.staff_role[]);
  if p_vendor is null or octet_length(p_phone_hash) is distinct from 32
     or p_phone is null or p_phone !~ '^\+998[0-9]{9}$'
     or p_role is null or p_role not in ('owner', 'member') or length(v_name) > 120 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  -- Нет вендора — как у внешнего ключа (API: 404), а не ошибка про владельца
  if not exists (select 1 from app.vendor_accounts v where v.id = p_vendor) then
    raise exception 'vendor_not_found' using errcode = '23503';
  end if;
  -- Та же блокировка, что у проверки владельца: приглашение и отключение владельца — по очереди
  perform pg_advisory_xact_lock(hashtextextended('bayramm.vendor_owners:' || p_vendor::text, 0));
  if p_role = 'member' and not exists (select 1 from app.vendor_users u
                                       where u.vendor_id = p_vendor and u.disabled_at is null
                                         and u.role = 'owner') then
    raise exception 'vendor_last_owner' using errcode = 'BR031',
      detail = 'сначала владелец кабинета, потом сотрудники площадки';
  end if;

  -- Номер уже у вендора — 23505 (vendor_users_vendor_phone_key)
  insert into app.vendor_users (vendor_id, phone_hash, role, locale)
  values (p_vendor, p_phone_hash, p_role, coalesce(p_locale, 'uz'))
  returning id into v_id;
  insert into pii.vendor_user_profiles (vendor_user_id, phone, full_name) values (v_id, p_phone, v_name);

  select i.account_id into v_account
  from app.account_identities i
  join app.accounts a on a.id = i.account_id
  where i.kind = 'phone' and i.value_hash = p_phone_hash and a.disabled_at is null and a.deleted_at is null;
  if v_account is not null then
    -- Аккаунт этого номера уже в кабинете другим пользователем: второе членство он не примет
    if exists (select 1 from app.vendor_users u where u.account_id = v_account and u.vendor_id = p_vendor) then
      raise exception 'vendor_user_exists' using errcode = 'BR032',
        detail = 'человек с этим номером уже в кабинете вендора';
    end if;
    -- Принять — как при входе кодом на этот номер, от имени системы: в журнале сотрудника —
    -- его приглашение, а не служебные поля привязки
    v_kind := current_setting('app.actor_kind', true);
    v_actor := current_setting('app.actor_id', true);
    perform set_config('app.actor_kind', 'system', true), set_config('app.actor_id', '', true);
    perform app.account_bind_phone(v_account, p_phone_hash, 'admin');
    perform set_config('app.actor_kind', coalesce(v_kind, ''), true),
            set_config('app.actor_id', coalesce(v_actor, ''), true);
  end if;

  select u.account_id is not null into v_accepted from app.vendor_users u where u.id = v_id;
  -- в журнал — id, роль, способ и принято ли сразу; без имени и номера
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('vendor_user.invite', 'vendor_user', v_id::text,
          jsonb_build_object('vendor_id', p_vendor, 'role', p_role, 'via', 'phone', 'accepted', v_accepted),
          'admin');
  return query select v_id, v_accepted;
end $$;

-- Убрать пользователя из кабинета — и ждущее приглашение, и принятое (человек теряет
-- доступ к этому вендору; аккаунт и другие роли остаются). Владельца, без которого
-- остаются другие действующие пользователи, не убрать (BR031)
create function app.staff_remove_vendor_user(p_user uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user app.vendor_users;
begin
  perform app.assert_staff_role(array['admin', 'manager']::app.staff_role[]);
  select u.* into v_user from app.vendor_users u where u.id = p_user for update;
  if not found then
    raise exception 'invalid_argument' using errcode = '22023', detail = 'нет такого пользователя';
  end if;

  -- Сессии до аккаунтов ссылаются на пользователя. Сессии аккаунта остаются: роль
  -- берётся из членств на каждый запрос — кабинет вендора закроется со следующего
  delete from app.sessions s where s.vendor_user_id = p_user;
  -- Неотправленное ему больше не нужно; отправленное и недоставленное — история
  delete from app.outbox o
  where o.recipient_kind = 'vendor_user' and o.recipient_id = p_user
    and o.status in ('pending', 'sending', 'failed');
  delete from app.vendor_users u where u.id = p_user;

  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('vendor_user.remove', 'vendor_user', p_user::text,
          jsonb_build_object('vendor_id', v_user.vendor_id, 'role', v_user.role,
                             'had_account', v_user.account_id is not null), 'admin');
end $$;

comment on function app.staff_invite_vendor_user(uuid, bytea, text, text, text, app.locale) is
  'Приглашение в кабинет вендора по телефону (администратор, менеджер); номер, уже подтверждённый у аккаунта, — принято сразу';
comment on function app.staff_remove_vendor_user(uuid) is
  'Убрать пользователя из кабинета вендора: сессии до аккаунтов, неотправленные уведомления и профиль — вместе с ним';

-- ── права ───────────────────────────────────────────────────────────────────
-- Триггерные и служебные функции API не вызывает — только действия сотрудников
revoke execute on all functions in schema app, pii from public;
grant execute on function
  app.staff_invite_vendor_user(uuid, bytea, text, text, text, app.locale),
  app.staff_remove_vendor_user(uuid)
  to bayramm_api;
