-- ════════════════════════════════════════════════════════════════════════════
-- Миграция 5 — панель оператора v0.1: вендоры и карточки.
--
--   · app.vendor_accounts.name — название вендора для панели и поиска (бренд,
--     не юрназвание): у лида ещё нет реквизитов, а называть его как-то надо;
--   · app.listing_status_log — история статусов карточки с причиной. Пишется
--     только триггером, изменить нельзя — как app.request_status_log. Причина:
--     status_reason (приостановка, отклонение) или GUC app.reason (возврат в
--     черновик с комментарием);
--   · журнал действий сотрудников пишет база: триггер на таблицах вендоров и
--     карточек кладёт в app.audit_log, кто, что и какие поля изменил. Значения
--     в журнал не попадают — только коды, id и имена полей (без ПДн). API и
--     браузер строк журнала не пишут.
--
-- Откат: supabase/rollbacks/20260930150000_admin_v01.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── название вендора ────────────────────────────────────────────────────────
alter table app.vendor_accounts
  add column name text check (length(btrim(name)) between 2 and 120);

comment on column app.vendor_accounts.name is
  'Название для панели и поиска (бренд). Юрназвание и СТИР — в pii.vendor_contacts';

-- ── история статусов карточки ───────────────────────────────────────────────
create table app.listing_status_log (
  id          bigint generated always as identity primary key,
  -- без внешнего ключа, как object_id в audit_log: журнал переживает карточку и не
  -- мешает удалить её там, где это вообще возможно (ручной SQL, тестовые данные)
  listing_id  uuid not null,
  from_status app.listing_status,
  to_status   app.listing_status not null,
  actor_kind  app.actor_kind not null,
  actor_id    uuid,
  reason      text check (length(reason) <= 1000),
  at          timestamptz not null default clock_timestamp()
);
create index listing_status_log_listing on app.listing_status_log (listing_id, at);

comment on table app.listing_status_log is
  'История статусов карточки: пишет только триггер listings_log_status, только на добавление';

create function app.listings_log_status() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return null;
  end if;
  insert into app.listing_status_log (listing_id, from_status, to_status, actor_kind, actor_id, reason)
  values (new.id,
          case when tg_op = 'UPDATE' then old.status end,
          new.status,
          app.effective_actor(),
          app.actor_id(),
          coalesce(new.status_reason, nullif(btrim(current_setting('app.reason', true)), '')));
  return null;
end $$;
create trigger listings_log_status after insert or update of status on app.listings
  for each row execute function app.listings_log_status();

create trigger listing_status_log_append_only before update or delete on app.listing_status_log
  for each row execute function app.forbid_mutation();
create trigger listing_status_log_no_truncate before truncate on app.listing_status_log
  for each statement execute function app.forbid_mutation();

alter table app.listing_status_log enable row level security;
-- сотрудники — все, вендор — свои карточки (причина отклонения нужна и ему)
create policy listing_status_log_read on app.listing_status_log for select to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id));
grant select on app.listing_status_log to bayramm_api;

-- ── журнал действий сотрудников ─────────────────────────────────────────────
-- Аргументы триггера: тип объекта, столбец с id объекта, префикс действия и
-- (необязательно) столбец, значение которого уточняет запись: вид пакета, день
-- занятости, id фото. Действие — <префикс>.create | update | delete.
-- Для UPDATE в detail — имена изменённых полей (служебные не считаются), для
-- смены статуса — ещё from/to. Без изменений (UPDATE того же значения) — ничего.
-- Пишет только за сотрудника: вендор и система ведут свои журналы
create function app.audit_staff_change() returns trigger
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

create trigger audit_staff after insert or update on app.vendor_accounts
  for each row execute function app.audit_staff_change('vendor', 'id', 'vendor');
create trigger audit_staff after insert or update on pii.vendor_contacts
  for each row execute function app.audit_staff_change('vendor', 'vendor_id', 'vendor_contact');
create trigger audit_staff after insert or update on app.vendor_users
  for each row execute function app.audit_staff_change('vendor_user', 'id', 'vendor_user', 'vendor_id');
create trigger audit_staff after insert or update on app.listings
  for each row execute function app.audit_staff_change('listing', 'id', 'listing', 'vendor_id');
create trigger audit_staff after insert or update or delete on app.listing_packages
  for each row execute function app.audit_staff_change('listing', 'listing_id', 'listing_package', 'kind');
create trigger audit_staff after insert or update or delete on pii.listing_contacts
  for each row execute function app.audit_staff_change('listing', 'listing_id', 'listing_contact');
create trigger audit_staff after insert or update on app.photos
  for each row execute function app.audit_staff_change('listing', 'listing_id', 'photo', 'id');
create trigger audit_staff after insert or delete on app.availability
  for each row execute function app.audit_staff_change('listing', 'listing_id', 'availability', 'day');

-- ── права ───────────────────────────────────────────────────────────────────
-- Новые функции вызывают только триггеры: API — ничего
revoke execute on all functions in schema app, pii from public;
