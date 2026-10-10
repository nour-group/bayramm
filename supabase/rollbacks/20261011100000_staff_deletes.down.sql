-- Откат 20261011100000_staff_deletes.sql: удаления витрины, вендора и приглашения нет;
-- журнал пишет и каскад удаления строк витрины; последним администратором считается и
-- непринятое приглашение. Только для локальной разработки и проверки в CI (up → down → up)

drop function if exists app.staff_revoke_invite(uuid);
drop function if exists app.staff_delete_vendor(uuid);
drop function if exists app.staff_delete_listing(uuid);
drop function if exists app.listing_purge(uuid);
drop function if exists app.outbox_forget(uuid[]);
drop function if exists app.vendor_delete_blocker(uuid);
drop function if exists app.listing_delete_blocker(uuid);
drop index if exists app.consents_scope_listing;

-- app.staff_keep_admin из 20260930180000_admin_v02.sql
create or replace function app.staff_keep_admin() returns trigger
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

-- app.audit_staff_change из 20260930150000_admin_v01.sql
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
