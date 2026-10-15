-- Откат 20261015100000_day_sessions: одна часть дня у заявки (day_part), время работы витрины
-- и части дня поводов убраны; зал — весь день (day), студия и ЗАГС — slot, как в
-- 20261006100000_categories_wedding_path.sql. Функции — как в 20261001120100_categories_services.sql,
-- 20261002090000_services_only_category_metrics.sql и 20261012090000_vendor_listing_facts.sql

-- ── заявки: снова одна часть дня (первая из частей) ─────────────────────────
alter table app.requests add column day_part app.day_part;
alter table app.requests disable trigger user;
update app.requests set day_part = day_parts[1] where cardinality(day_parts) > 0;
alter table app.requests enable trigger user;
drop index if exists app.requests_listing_deals;
drop index if exists app.requests_deals_day;
create index requests_listing_deals on app.requests (listing_id, event_date, day_part) where status = 'deal';
create index requests_deals_day on app.requests (event_date, listing_id)
  where status = 'deal' and day_part is not null;
comment on column app.requests.day_part is
  'Часть дня (режим parts): API выводит её из времени начала в details';
create or replace function app.requests_category_rules() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_mode app.availability_mode;
begin
  select c.availability_mode into v_mode
  from app.listings l join app.categories c on c.code = l.category_code
  where l.id = new.listing_id;
  if (v_mode = 'parts') <> (new.day_part is not null) then
    raise exception 'invalid_input' using errcode = '23514', detail = 'day_part';
  end if;
  return new;
end $$;
create or replace function app.requests_before_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor app.actor_kind := app.effective_actor();
begin
  if (new.id, new.public_no, new.client_id, new.listing_id, new.vendor_id, new.consent_id, new.occasion_code,
      new.event_date, new.guests, new.budget_min_uzs, new.budget_max_uzs, new.source, new.sla_due_at, new.created_at,
      new.details, new.day_part)
     is distinct from
     (old.id, old.public_no, old.client_id, old.listing_id, old.vendor_id, old.consent_id, old.occasion_code,
      old.event_date, old.guests, old.budget_min_uzs, old.budget_max_uzs, old.source, old.sla_due_at, old.created_at,
      old.details, old.day_part) then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;

  -- этапы SLA двигает только система и только вперёд
  if (new.sla_stage, new.sla_breached_at) is distinct from (old.sla_stage, old.sla_breached_at) then
    if v_actor <> 'system' then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'sla';
    end if;
    if new.sla_stage < old.sla_stage then
      raise exception 'illegal_transition' using errcode = 'BR002', detail = 'sla_stage';
    end if;
  end if;

  if new.status is distinct from old.status then
    if not exists (select 1 from app.request_transitions t
                   where t.from_status = old.status and t.to_status = new.status and t.actor = v_actor) then
      raise exception 'illegal_transition' using errcode = 'BR002',
        detail = format('%s -> %s (%s)', old.status, new.status, v_actor);
    end if;
    if new.status = 'viewed' and old.first_viewed_at is null then
      new.first_viewed_at := now();
    end if;
    if new.status in ('contacted', 'declined', 'deal') and old.first_response_at is null then
      new.first_response_at := now();
      new.first_response_by := v_actor;
    end if;
    if new.status <> 'declined' then
      new.decline_reason := null;
      new.decline_note := null;
    end if;
  elsif (new.decline_reason, new.decline_note) is distinct from (old.decline_reason, old.decline_note) then
    raise exception 'immutable_column' using errcode = 'BR006', detail = 'причина меняется только вместе со статусом';
  end if;

  if (new.first_viewed_at, new.first_response_at, new.first_response_by)
     is distinct from (old.first_viewed_at, old.first_response_at, old.first_response_by)
     and new.status is not distinct from old.status then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;

  new.updated_at := now();
  return new;
end $$;
create or replace function app.requests_decline_busy_day() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.status = 'declined' and new.status <> 'declined' then
    delete from app.availability a
    where a.request_id = new.id and a.source = 'request_decline' and a.day >= app.tashkent_today();
    delete from app.availability_parts a
    where a.request_id = new.id and a.source = 'request_decline' and a.day >= app.tashkent_today();
  end if;
  if new.status = 'declined' and new.decline_reason = 'busy'
     and old.status is distinct from 'declined' and new.event_date >= app.tashkent_today() then
    if new.day_part is not null then
      insert into app.availability_parts (listing_id, day, part, source, request_id)
      values (new.listing_id, new.event_date, new.day_part, 'request_decline', new.id)
      on conflict (listing_id, day, part) do nothing;
    else
      insert into app.availability (listing_id, day, source, request_id)
      values (new.listing_id, new.event_date, 'request_decline', new.id)
      on conflict (listing_id, day) do nothing;
    end if;
  end if;
  return null;
end $$;
create or replace function app.availability_parts_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor app.actor_kind := app.effective_actor();
  v_today date := app.tashkent_today();
begin
  if tg_op = 'DELETE' then
    if old.day < v_today then
      -- удаление вместе с листингом (каскад) — не правка календаря
      if not exists (select 1 from app.listings l where l.id = old.listing_id) then
        return old;
      end if;
      raise exception 'date_out_of_range' using errcode = 'BR024', detail = 'прошедший день не меняется';
    end if;
    if v_actor = 'vendor_user' and old.source = 'staff' then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'часть дня закрыта сотрудником';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    raise exception 'immutable_column' using errcode = 'BR006', detail = 'отметку снимают и ставят заново';
  end if;
  if new.day < v_today then
    raise exception 'date_out_of_range' using errcode = 'BR024', detail = 'прошедший день не меняется';
  end if;
  if not exists (select 1 from app.listings l join app.categories c on c.code = l.category_code
                 where l.id = new.listing_id and c.availability_mode = 'parts') then
    raise exception 'invalid_input' using errcode = '23514', detail = 'части дня — только у режима parts';
  end if;
  new.created_by := app.actor_id();
  new.created_at := now();
  if v_actor = 'vendor_user' and new.source = 'staff' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'source staff ставит только сотрудник';
  end if;
  if new.source = 'request_decline' and not exists (
       select 1 from app.requests r
       where r.id = new.request_id and r.listing_id = new.listing_id and r.event_date = new.day
         and r.day_part = new.part and r.status = 'declined' and r.decline_reason = 'busy') then
    raise exception 'invalid_input' using errcode = '23514',
      detail = 'request_decline — только часть дня и дата заявки этого листинга с отказом «занято»';
  end if;
  return new;
end $$;

-- ── занятость ───────────────────────────────────────────────────────────────
create or replace function app.listing_busy(p_listing uuid, p_from date, p_to date)
returns table (day date, parts text[])
language sql stable security definer set search_path = ''
as $$
  with l as (
    select l.id, l.parallel_capacity, c.availability_mode as mode
    from app.listings l
    join app.categories c on c.code = l.category_code
    where l.id = p_listing and (l.status = 'active' or app.is_privileged() or app.owns_listing(l.id))
      and p_to <= p_from + 400
  ),
  whole as (
    select a.day from app.availability a join l on a.listing_id = l.id
    where a.day >= p_from and a.day < p_to
  ),
  part_full as (
    select a.day, a.part from app.availability_parts a join l on a.listing_id = l.id
    where l.mode = 'parts' and a.day >= p_from and a.day < p_to
    union
    select r.event_date, r.day_part from app.requests r join l on r.listing_id = l.id
    where l.mode = 'parts' and r.status = 'deal' and r.day_part is not null
      and r.event_date >= p_from and r.event_date < p_to
    group by r.event_date, r.day_part, l.parallel_capacity
    having count(*) >= l.parallel_capacity
  ),
  by_day as (
    select f.day, array_agg(f.part order by f.part) as parts from part_full f group by f.day
  )
  select w.day, array['all']::text[] from whole w
  union all
  select d.day, case when cardinality(d.parts) = 3 then array['all']::text[] else d.parts::text[] end
  from by_day d
  where not exists (select 1 from whole w where w.day = d.day)
  order by 1
$$;
drop function app.catalog_day_load(text, date);
create function app.catalog_day_load(p_category text, p_day date)
returns table (listing_id uuid, load text)
language sql stable security definer set search_path = ''
as $$
  with l as (
    select l.id, l.parallel_capacity, c.availability_mode as mode
    from app.listings l
    join app.categories c on c.code = l.category_code
    where l.category_code = p_category and l.status = 'active'
  ),
  whole as (
    select a.listing_id from app.availability a join l on l.id = a.listing_id where a.day = p_day
  ),
  part_full as (
    select a.listing_id, a.part from app.availability_parts a join l on l.id = a.listing_id
    where l.mode = 'parts' and a.day = p_day
    union
    select r.listing_id, r.day_part from app.requests r join l on l.id = r.listing_id
    where l.mode = 'parts' and r.status = 'deal' and r.day_part is not null and r.event_date = p_day
    group by r.listing_id, r.day_part, l.parallel_capacity
    having count(*) >= l.parallel_capacity
  )
  select w.listing_id, 'busy'::text from whole w
  union all
  select f.listing_id, case when count(*) = 3 then 'busy' else 'partial' end
  from part_full f
  where not exists (select 1 from whole w where w.listing_id = f.listing_id)
  group by f.listing_id
$$;
comment on function app.catalog_day_load(text, date) is
  'Загрузка на день опубликованных витрин категории (busy, partial; свободных нет в ответе) — одним запросом для выдачи';
drop function app.listing_load_days(uuid[], date, date);

alter table app.requests drop constraint requests_day_parts, drop column day_parts;

-- ── время работы витрины ────────────────────────────────────────────────────
create or replace function app.audit_vendor_listing() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_fields text[];
begin
  if app.actor_kind() is distinct from 'vendor_user' then
    return null;
  end if;
  select coalesce(array_agg(n.key order by n.key), '{}') into v_fields
  from jsonb_each(to_jsonb(new)) n
  where n.key in ('name', 'description_ru', 'description_uz', 'attributes', 'video_links',
                  'cap_min', 'cap_max', 'district_code', 'address_ru', 'address_uz')
    and n.value is distinct from to_jsonb(old) -> n.key;
  if cardinality(v_fields) = 0 then
    return null;
  end if;
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('listing.vendor_update', 'listing', new.id::text,
          jsonb_build_object('fields', to_jsonb(v_fields), 'vendor_id', new.vendor_id),
          coalesce(nullif(current_setting('app.source', true), '')::app.source, 'vendor_cabinet'));
  return null;
end $$;
drop function app.listing_set_day_sessions(uuid, app.part_mode, app.day_part[], jsonb, int, int);
drop trigger listings_capacity_bump on app.listings;
create trigger listings_capacity_bump after update of parallel_capacity on app.listings
  for each row when (new.parallel_capacity is distinct from old.parallel_capacity)
  execute function app.listings_capacity_bump();
alter table app.listings
  drop constraint listings_day_parts,
  drop constraint listings_part_windows,
  drop column part_mode,
  drop column day_parts,
  drop column part_windows;
comment on column app.listings.parallel_capacity is
  'Сколько заказов витрина берёт одновременно (режим занятости parts): экипажи, машины';

-- ── поводы ──────────────────────────────────────────────────────────────────
-- Новые поводы без заявок убираются; с заявками остаются (на них ссылаются заявки)
delete from app.occasions o
where o.code in ('nahorgi_osh', 'nikoh', 'fotiha', 'qiz_bazmi', 'kelin_salom', 'sunnat', 'yubiley')
  and not exists (select 1 from app.requests r where r.occasion_code = o.code);
update app.occasions set sort = case code
  when 'toy' then 1 when 'beshik' then 2 when 'bd' then 3 when 'corp' then 4 when 'small' then 5 else sort end;
alter table app.occasions drop constraint occasions_default_parts, drop column default_parts;

drop function app.day_parts_ok(app.day_part[], int);
drop function app.part_windows_ok(jsonb);
drop type app.part_mode;

-- ── категории: зал и выключенные — день целиком, студия и ЗАГС — slot ─────────
alter table app.categories alter column availability_mode set default 'day';
update app.categories set availability_mode = 'day' where code in ('hall', 'music', 'kids');
update app.categories set availability_mode = 'slot' where code in ('studio', 'zags');

-- ── права ───────────────────────────────────────────────────────────────────
revoke execute on all functions in schema app, pii from public;
grant execute on function app.catalog_day_load(text, date) to bayramm_api;
