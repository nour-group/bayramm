-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — удаление в панели оператора: витрина, вендор, приглашение в команду.
--
-- Удаляется только то, что ещё не стало историей: у чего нет заявок (и согласий
-- клиентов на передачу контактов — журнал согласий не трогаем) и что не на проверке
-- и не в каталоге. Остальное снимают с публикации (приостановить) — история заявок
-- остаётся.
--
--   · app.staff_delete_listing(витрина) — администратор и менеджер: статус lead, draft,
--     rejected или suspended и ни одной заявки. Уходят оповещения о витрине (её правках,
--     услугах, фото) и сама строка — фото, услуги, правки, занятость, контакты, избранное
--     и события «Связаться» каскадом. История статусов (app.listing_status_log) и
--     журнал действий остаются: они только на добавление. Возвращает ключи фото в
--     хранилище — объекты удаляет API после фиксации (не удалились — их уберёт ежедневная
--     сверка photos/sweep.ts как объекты без строки);
--   · app.staff_delete_vendor(вендор) — только администратор: каждая витрина проходит
--     правило выше. Уходят витрины (тем же путём), пользователи кабинета с их профилями,
--     старыми сессиями и оповещениями, реквизиты и контакты. Аккаунты людей остаются —
--     у них бывают другие роли; согласия пользователей кабинета — в журнале согласий;
--   · app.staff_revoke_invite(сотрудник) — только администратор: приглашение, которое не
--     приняли (нет аккаунта и Telegram, ни одного входа и действия). Принятое не
--     удаляют — сотрудника отключают;
--   · app.listing_delete_blocker / app.vendor_delete_blocker — почему нельзя удалить
--     (requests — есть заявки, published — на проверке или в каталоге) или null: панель
--     показывает причину до нажатия;
--   · app.audit_staff_change: удаление строк витрины каскадом (контакты, услуги,
--     занятость) в журнал не пишется — удаление витрины одной записью listing.delete;
--   · app.staff_keep_admin: «последний действующий администратор» — только принятые
--     приглашения: непринятое войти не может, его отключают и понижают всегда.
--
-- Журнал — только id, коды и числа (без названий и ПДн): listing.delete (вендор,
-- категория, статус, сколько фото, услуг, правок, отметок занятости — и у каждой витрины
-- удалённого вендора), vendor.delete (код V…, сколько витрин, фото, пользователей
-- кабинета), staff.invite_revoke (роль, способ).
--
-- Коды ошибок (DETAIL — причина кодом):
--   BR029 listing_in_use           у витрины заявки (requests) или она опубликована (published)
--   BR030 vendor_in_use            то же у какой-то витрины вендора
--   BR033 staff_invite_accepted    приглашение уже приняли — сотрудника отключают
--
-- Откат: supabase/rollbacks/20261011100000_staff_deletes.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- Ссылка согласия на витрину: проверка при удалении витрины (и внешнего ключа) — по индексу
create index consents_scope_listing on app.consents (scope_listing_id) where scope_listing_id is not null;

-- ════════════════════════════════════════════════════════════════════════════
-- Журнал: каскад удаления витрины — одной записью
-- ════════════════════════════════════════════════════════════════════════════

-- Та же функция, что в 20260930150000_admin_v01.sql, плюс: строка витрины (контакты,
-- услуга, отметка занятости) удалена, а самой витрины уже нет — значит, её удалили
-- каскадом вместе с витриной. Это не правка витрины, а её удаление: в журнал пишет
-- app.staff_delete_listing
create or replace function app.audit_staff_change() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_row    jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  v_old    jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  v_fields text[];
  v_detail jsonb := '{}'::jsonb;
begin
  if app.actor_kind() is distinct from 'staff' then
    return null;
  end if;
  if tg_op = 'DELETE' and tg_argv[0] = 'listing'
     and not exists (select 1 from app.listings l where l.id::text = v_row ->> tg_argv[1]) then
    return null;
  end if;

  if tg_op = 'UPDATE' then
    select coalesce(array_agg(n.key order by n.key), '{}') into v_fields
    from jsonb_each(v_row) n
    where n.value is distinct from v_old -> n.key
      and n.key not in ('updated_at', 'version', 'status_changed_at', 'status_changed_by',
                        'submitted_at', 'published_at', 'moderated_at', 'moderated_by');
    if cardinality(v_fields) = 0 then
      return null;
    end if;
    v_detail := jsonb_build_object('fields', to_jsonb(v_fields));
    if 'status' = any (v_fields) then
      v_detail := v_detail || jsonb_build_object('from', v_old ->> 'status', 'to', v_row ->> 'status');
    end if;
  end if;

  if tg_nargs > 3 then
    v_detail := v_detail || jsonb_build_object(tg_argv[3], v_row ->> tg_argv[3]);
  end if;

  insert into app.audit_log (action, object_type, object_id, detail, source)
  values (tg_argv[2] || '.' || case tg_op when 'INSERT' then 'create' when 'DELETE' then 'delete' else 'update' end,
          tg_argv[0], v_row ->> tg_argv[1], v_detail, 'admin');
  return null;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Можно ли удалить
-- ════════════════════════════════════════════════════════════════════════════

-- Почему витрину нельзя удалить: requests — по ней были заявки (или согласия клиентов на
-- передачу контактов: их журнал не меняется), published — она на проверке или в каталоге
-- (сначала вернуть в черновик или приостановить). null — можно (или витрины нет).
-- Заявки — сильнее статуса: их история не уйдёт и после приостановки
create function app.listing_delete_blocker(p_listing uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when exists (select 1 from app.requests r where r.listing_id = l.id)
      or exists (select 1 from app.consents c where c.scope_listing_id = l.id) then 'requests'
    when l.status in ('review', 'active') then 'published'
  end
  from app.listings l
  where l.id = p_listing
$$;

-- То же у вендора: какая-то его витрина не проходит правило выше (или есть заявка на вендора)
create function app.vendor_delete_blocker(p_vendor uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when exists (select 1 from app.requests r where r.vendor_id = p_vendor)
      or exists (select 1 from app.listings l
                 where l.vendor_id = p_vendor and app.listing_delete_blocker(l.id) = 'requests') then 'requests'
    when exists (select 1 from app.listings l
                 where l.vendor_id = p_vendor and l.status in ('review', 'active')) then 'published'
  end
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Удаление витрины
-- ════════════════════════════════════════════════════════════════════════════

-- Оповещения, которые больше не о чем отправлять, и оповещения команде о том, что они
-- не дошли (ops.outbox_dead ссылается на строку очереди). Служебная: только вызовы ниже
create function app.outbox_forget(p_ids uuid[]) returns void
language sql security definer set search_path = ''
as $$
  delete from app.outbox o
  where o.kind = 'ops.outbox_dead' and o.payload ->> 'outbox_id' = any (p_ids::text[]);
$$;

-- Убрать витрину целиком, без проверок: их делают вызывающие под блокировкой строки.
-- Оповещения о витрине, её правках, услугах и фото — в любом состоянии (в payload только
-- id: 20260930200000_revisions_phone_invites.sql, 20261001120100_categories_services.sql);
-- остальное уходит каскадом, триггеры каскад узнают по тому, что витрины уже нет. В журнал —
-- listing.delete: вендор, категория, статус и сколько чего (без названий).
-- keys — ключи всех фото в хранилище (и удалённых из витрины: их объекты ещё живут до
-- ежедневной сверки), counts — числа для журнала
create function app.listing_purge(p_listing uuid, out keys text[], out counts jsonb)
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing   app.listings;
  v_photos    text[];
  v_services  text[];
  v_revisions text[];
  v_outbox    uuid[];
begin
  select l.* into strict v_listing from app.listings l where l.id = p_listing;
  select coalesce(array_agg(p.id::text), '{}'), coalesce(array_agg(p.storage_key), '{}')
    into v_photos, keys
  from app.photos p where p.listing_id = p_listing;
  select coalesce(array_agg(s.id::text), '{}') into v_services
  from app.listing_services s where s.listing_id = p_listing;
  select coalesce(array_agg(r.id::text), '{}') into v_revisions
  from app.listing_revisions r where r.listing_id = p_listing;
  counts := jsonb_build_object(
    'photos', cardinality(v_photos),
    'services', cardinality(v_services),
    'revisions', cardinality(v_revisions),
    'busy_days', (select count(*) from app.availability a where a.listing_id = p_listing)
               + (select count(*) from app.availability_parts a where a.listing_id = p_listing));

  with gone as (
    delete from app.outbox o
    where o.payload ->> 'listing_id' = p_listing::text
       or o.payload ->> 'revision_id' = any (v_revisions)
       or o.payload ->> 'service_id' = any (v_services)
       or o.payload ->> 'photo_id' = any (v_photos)
    returning o.id
  )
  select coalesce(array_agg(g.id), '{}') into v_outbox from gone g;
  perform app.outbox_forget(v_outbox);

  delete from app.listings l where l.id = p_listing;
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('listing.delete', 'listing', p_listing::text,
          jsonb_build_object('vendor_id', v_listing.vendor_id, 'category', v_listing.category_code,
                             'status', v_listing.status) || counts,
          'admin');
end $$;

-- Удалить витрину (администратор, менеджер). Строка — под блокировкой: параллельная смена
-- статуса или заявка (ей нужна ссылка на витрину) ждут и затем не проходят
create function app.staff_delete_listing(p_listing uuid) returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  v_blocker text;
  v_purge   record;
begin
  perform app.assert_staff_role(array['admin', 'manager']::app.staff_role[]);
  perform 1 from app.listings l where l.id = p_listing for update;
  if not found then
    raise exception 'not_found' using errcode = '42501';
  end if;
  v_blocker := app.listing_delete_blocker(p_listing);
  if v_blocker is not null then
    raise exception 'listing_in_use' using errcode = 'BR029', detail = v_blocker;
  end if;
  select * into v_purge from app.listing_purge(p_listing);
  return v_purge.keys;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Удаление вендора
-- ════════════════════════════════════════════════════════════════════════════

-- Удалить вендора (администратор). Вендор и все его витрины — под блокировкой (витрины по
-- порядку id): новая витрина, пользователь кабинета или удаление витрины параллельно ждут.
-- В журнал — listing.delete каждой витрины и vendor.delete
create function app.staff_delete_vendor(p_vendor uuid) returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  v_code     text;
  v_blocker  text;
  v_listing  uuid;
  v_purge    record;
  v_keys     text[] := '{}';
  v_listings int := 0;
  v_photos   int := 0;
  v_users    uuid[];
  v_outbox   uuid[];
begin
  perform app.assert_staff_role(array['admin']::app.staff_role[]);
  select v.public_code into v_code from app.vendor_accounts v where v.id = p_vendor for update;
  if not found then
    raise exception 'not_found' using errcode = '42501';
  end if;
  perform 1 from app.listings l where l.vendor_id = p_vendor order by l.id for update;
  v_blocker := app.vendor_delete_blocker(p_vendor);
  if v_blocker is not null then
    raise exception 'vendor_in_use' using errcode = 'BR030', detail = v_blocker;
  end if;

  for v_listing in select l.id from app.listings l where l.vendor_id = p_vendor order by l.created_at, l.id loop
    select * into v_purge from app.listing_purge(v_listing);
    v_keys := v_keys || v_purge.keys;
    v_listings := v_listings + 1;
    v_photos := v_photos + (v_purge.counts ->> 'photos')::int;
  end loop;

  -- Пользователи кабинета: оповещения им, сессии старого входа партнёра (до аккаунтов они
  -- ссылаются на пользователя), профили — каскадом. Сессии аккаунта остаются: кабинет
  -- этого вендора аккаунт больше не найдёт
  select coalesce(array_agg(u.id), '{}') into v_users from app.vendor_users u where u.vendor_id = p_vendor;
  with gone as (
    delete from app.outbox o
    where o.recipient_kind = 'vendor_user' and o.recipient_id = any (v_users)
    returning o.id
  )
  select coalesce(array_agg(g.id), '{}') into v_outbox from gone g;
  perform app.outbox_forget(v_outbox);
  delete from app.sessions s where s.vendor_user_id = any (v_users);
  delete from app.vendor_users u where u.id = any (v_users);
  -- Реквизиты и контакты (pii.vendor_contacts) — каскадом
  delete from app.vendor_accounts v where v.id = p_vendor;

  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('vendor.delete', 'vendor', p_vendor::text,
          jsonb_build_object('code', v_code, 'listings', v_listings, 'photos', v_photos,
                             'users', cardinality(v_users)),
          'admin');
  return v_keys;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Команда: отозвать приглашение
-- ════════════════════════════════════════════════════════════════════════════

-- Приглашение, которое никто не принял: ни аккаунта, ни Telegram, ни одного входа (сессии)
-- и действия (журнал). Принятое — уже человек с историей: его отключают
-- (app.staff_set_active). Менеджер вендора с этим приглашением снимается; профиль
-- приглашения — каскадом. Себя — нельзя
create function app.staff_revoke_invite(p_staff uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_staff app.staff;
  v_via   text;
begin
  perform app.assert_staff_role(array['admin']::app.staff_role[]);
  if p_staff = app.actor_id() then
    raise exception 'staff_self' using errcode = 'BR018';
  end if;
  select s.* into v_staff from app.staff s where s.id = p_staff for update;
  if not found then
    raise exception 'invalid_argument' using errcode = '22023', detail = 'нет такого сотрудника';
  end if;
  if v_staff.account_id is not null or v_staff.tg_id_hash is not null
     or exists (select 1 from app.sessions ss where ss.staff_id = p_staff)
     or exists (select 1 from app.audit_log a where a.actor_kind = 'staff' and a.actor_id = p_staff) then
    raise exception 'staff_invite_accepted' using errcode = 'BR033',
      detail = 'приглашение принято: отключите сотрудника вместо удаления';
  end if;
  select case when v_staff.phone_hash is not null and p.telegram_username is null then 'phone' else 'telegram' end
    into v_via
  from pii.staff_profiles p where p.staff_id = p_staff;

  update app.vendor_accounts v set manager_id = null where v.manager_id = p_staff;
  delete from app.outbox o where o.recipient_kind = 'staff' and o.recipient_id = p_staff;
  begin
    delete from app.staff s where s.id = p_staff;
  exception when foreign_key_violation then
    -- на приглашение уже ссылается чьё-то решение — значит, им пользовались
    raise exception 'staff_invite_accepted' using errcode = 'BR033',
      detail = 'приглашением уже пользовались: отключите сотрудника вместо удаления';
  end;

  -- в журнал — id, роль и способ приглашения, без имени и номера
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('staff.invite_revoke', 'staff', p_staff::text,
          jsonb_build_object('role', v_staff.role, 'via', coalesce(v_via, 'telegram')), 'admin');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Последний действующий администратор — только из принятых приглашений
-- ════════════════════════════════════════════════════════════════════════════

-- Та же функция, что в 20260930180000_admin_v02.sql, но «действующий» — тот, кто может
-- войти (приглашение принято, у роли есть аккаунт). Непринятое приглашение
-- администратора не держит команду: войти по нему нельзя, пока его не примут, — его
-- можно отключить, понизить или отозвать всегда
create or replace function app.staff_keep_admin() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.active and old.role = 'admin' and old.account_id is not null
     and not (new.active and new.role = 'admin') then
    perform pg_advisory_xact_lock(hashtextextended('bayramm.staff_admins', 0));
    if not exists (select 1 from app.staff s
                   where s.active and s.role = 'admin' and s.account_id is not null and s.id <> new.id) then
      raise exception 'staff_last_admin' using errcode = 'BR017',
        detail = 'должен остаться хотя бы один действующий администратор';
    end if;
  end if;
  return new;
end $$;

-- ── права ───────────────────────────────────────────────────────────────────
-- Действия сотрудников и причины «нельзя удалить» (их читает панель); служебные —
-- app.listing_purge, app.outbox_forget — API не вызывает
revoke execute on function
  app.listing_delete_blocker(uuid),
  app.vendor_delete_blocker(uuid),
  app.outbox_forget(uuid[]),
  app.listing_purge(uuid),
  app.staff_delete_listing(uuid),
  app.staff_delete_vendor(uuid),
  app.staff_revoke_invite(uuid)
  from public;
grant execute on function
  app.listing_delete_blocker(uuid),
  app.vendor_delete_blocker(uuid),
  app.staff_delete_listing(uuid),
  app.staff_delete_vendor(uuid),
  app.staff_revoke_invite(uuid)
  to bayramm_api;

comment on function app.staff_delete_listing(uuid) is
  'Удалить витрину без заявок, не на проверке и не в каталоге (администратор, менеджер). Возвращает ключи фото в хранилище';
comment on function app.staff_delete_vendor(uuid) is
  'Удалить вендора, все витрины которого можно удалить (администратор). Возвращает ключи фото в хранилище';
comment on function app.staff_revoke_invite(uuid) is
  'Отозвать непринятое приглашение в команду (администратор). Принятое — отключают';
