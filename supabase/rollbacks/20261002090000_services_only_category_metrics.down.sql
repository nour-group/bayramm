-- Откат 20261002090000_services_only_category_metrics.sql: пакеты залов v0.1 и их
-- зеркало в услуги, ключи v0.1 в правке карточки, метрики без категорий, политика фото
-- и каталог без app.catalog_day_load.
--
-- Только для локальной разработки и проверки в CI (up → down → up). Пакеты залов
-- собираются из их услуг (банкеты будни и выходные, «другие услуги») — как их видел
-- код v0.1. Правки, отклонённые миграцией, остаются отклонёнными.

-- ── каталог ─────────────────────────────────────────────────────────────────
drop function if exists app.catalog_day_load(text, date);
drop index if exists app.requests_deals_day;
drop index if exists app.photos_public;
-- 20260928120100_core.sql
alter policy photos_read on app.photos
  using ((select app.is_privileged())
         or app.owns_listing(listing_id)
         or (deleted_at is null and status = 'ready' and moderation = 'approved'
             and app.listing_is_public(listing_id)));

-- ── метрики — к 20260930220000_launch_metrics.sql ───────────────────────────
drop function if exists app.metrics_categories(int);
drop function if exists app.metrics_weekly(int, text);
drop function if exists app.metrics_period(timestamptz, timestamptz, text);
drop function if exists app.metrics_vendors(int, uuid, text);
drop function if exists app.metrics_listings(uuid, int);

-- Столбец из представления не убрать через create or replace — заново
drop view if exists app.request_metric_facts;
create view app.request_metric_facts with (security_invoker = true) as
select r.id as request_id,
       r.vendor_id,
       r.listing_id,
       r.client_id,
       r.status,
       r.created_at,
       r.sla_due_at,
       v.vendor_response_at,
       c.closed_at,
       (extract(epoch from (v.vendor_response_at - r.created_at)) / 60)::float8 as response_minutes,
       coalesce(v.vendor_response_at <= r.sla_due_at, false) as answered_in_time,
       coalesce(v.vendor_response_at <= r.sla_due_at, false)
         or (r.sla_due_at <= now()
             and not (v.vendor_response_at is null and c.closed_at is not null and c.closed_at < r.sla_due_at))
         as measurable,
       r.status = 'deal' as agreed,
       r.sla_breached_at is not null as breached
from app.requests r
left join lateral (
  select min(l.at) as vendor_response_at
  from app.request_status_log l
  where l.request_id = r.id and l.actor_kind = 'vendor_user' and l.to_status in ('contacted', 'deal', 'declined')
) v on true
left join lateral (
  select min(l.at) as closed_at
  from app.request_status_log l
  where l.request_id = r.id and l.to_status in ('withdrawn', 'expired')
) c on true;

comment on view app.request_metric_facts is
  'Факты заявки для метрик: ответ площадки (не сотрудника), в срок ли, известен ли исход, договорились, нарушение срока. Без ПДн';

create function app.metrics_period(p_from timestamptz, p_to timestamptz)
returns table (requests int, clients int, measurable int, answered_in_time int, answered_rate numeric,
               responded int, median_response_minutes int, p90_response_minutes int,
               agreed int, agreed_rate numeric, sla_breaches int, dead_notifications int)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_metrics_reader();
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '366 days' then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  return query
  select count(*)::int,
         count(distinct f.client_id)::int,
         (count(*) filter (where f.measurable))::int,
         (count(*) filter (where f.answered_in_time))::int,
         round(100.0 * count(*) filter (where f.answered_in_time)
               / nullif(count(*) filter (where f.measurable), 0), 1),
         count(f.response_minutes)::int,
         round(percentile_cont(0.5) within group (order by f.response_minutes))::int,
         round(percentile_cont(0.9) within group (order by f.response_minutes))::int,
         (count(*) filter (where f.agreed))::int,
         round(100.0 * count(*) filter (where f.agreed) / nullif(count(*), 0), 1),
         (count(*) filter (where f.breached))::int,
         (select count(*) from app.outbox o
          where o.status = 'dead' and o.created_at >= p_from and o.created_at < p_to)::int
  from app.request_metric_facts f
  where f.created_at >= p_from and f.created_at < p_to;
end $$;

comment on function app.metrics_period(timestamptz, timestamptz) is
  'Метрики заявок и уведомлений за период. Сотрудник или система';

create function app.metrics_weekly(p_weeks int default 8)
returns table (week_start date, week_label text, partial boolean, requests int, clients int, measurable int,
               answered_in_time int, answered_rate numeric, responded int, median_response_minutes int,
               p90_response_minutes int, agreed int, agreed_rate numeric, sla_breaches int,
               dead_notifications int)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_current date := date_trunc('week', now() at time zone 'Asia/Tashkent')::date;
begin
  perform app.assert_metrics_reader();
  if p_weeks is null or p_weeks not between 1 and 52 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  return query
  select w.day,
         to_char(w.day, 'IYYY-"W"IW'),
         w.day = v_current,
         m.requests, m.clients, m.measurable, m.answered_in_time, m.answered_rate, m.responded,
         m.median_response_minutes, m.p90_response_minutes, m.agreed, m.agreed_rate, m.sla_breaches,
         m.dead_notifications
  from (select v_current - 7 * g as day from generate_series(0, p_weeks - 1) g) w
  cross join lateral app.metrics_period(w.day::timestamp at time zone 'Asia/Tashkent',
                                        (w.day + 7)::timestamp at time zone 'Asia/Tashkent') m
  order by w.day desc;
end $$;

comment on function app.metrics_weekly(int) is
  'Метрики по ISO-неделям (по Ташкенту), текущая — первой. Сотрудник или система';

create function app.metrics_vendors(p_days int default 30, p_vendor uuid default null)
returns table (vendor_id uuid, vendor_code text, vendor_name text, active_listings int, requests int,
               measurable int, answered_in_time int, answered_rate numeric, responded int,
               median_response_minutes int, sla_breaches int, agreed int, last_request_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_metrics_reader();
  if p_days is null or p_days not between 1 and 366 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  return query
  select v.id, v.public_code, v.name,
         (select count(*) from app.listings l where l.vendor_id = v.id and l.status = 'active')::int,
         m.requests, m.measurable, m.answered_in_time,
         round(100.0 * m.answered_in_time / nullif(m.measurable, 0), 1),
         m.responded, m.median_response_minutes, m.sla_breaches, m.agreed, m.last_request_at
  from app.vendor_accounts v
  cross join lateral (
    select count(*)::int as requests,
           (count(*) filter (where f.measurable))::int as measurable,
           (count(*) filter (where f.answered_in_time))::int as answered_in_time,
           count(f.response_minutes)::int as responded,
           round(percentile_cont(0.5) within group (order by f.response_minutes))::int as median_response_minutes,
           (count(*) filter (where f.breached))::int as sla_breaches,
           (count(*) filter (where f.agreed))::int as agreed,
           max(f.created_at) as last_request_at
    from app.request_metric_facts f
    where f.vendor_id = v.id and f.created_at >= now() - make_interval(days => p_days)
  ) m
  where (p_vendor is null or v.id = p_vendor)
    and (p_vendor is not null or m.requests > 0
         or exists (select 1 from app.listings l where l.vendor_id = v.id and l.status = 'active'))
  order by v.public_code;
end $$;

comment on function app.metrics_vendors(int, uuid) is
  'Ответы вендоров за последние N дней: заявки, доля ответов в срок, медиана ответа. Сотрудник или система';

create function app.metrics_listings(p_vendor uuid, p_days int default 30)
returns table (listing_id uuid, listing_name text, listing_status app.listing_status, requests int,
               measurable int, answered_in_time int, answered_rate numeric, responded int,
               median_response_minutes int, sla_breaches int, agreed int, last_request_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_metrics_reader();
  if p_vendor is null or p_days is null or p_days not between 1 and 366 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  return query
  select l.id, l.name, l.status,
         m.requests, m.measurable, m.answered_in_time,
         round(100.0 * m.answered_in_time / nullif(m.measurable, 0), 1),
         m.responded, m.median_response_minutes, m.sla_breaches, m.agreed, m.last_request_at
  from app.listings l
  cross join lateral (
    select count(*)::int as requests,
           (count(*) filter (where f.measurable))::int as measurable,
           (count(*) filter (where f.answered_in_time))::int as answered_in_time,
           count(f.response_minutes)::int as responded,
           round(percentile_cont(0.5) within group (order by f.response_minutes))::int as median_response_minutes,
           (count(*) filter (where f.breached))::int as sla_breaches,
           (count(*) filter (where f.agreed))::int as agreed,
           max(f.created_at) as last_request_at
    from app.request_metric_facts f
    where f.listing_id = l.id and f.created_at >= now() - make_interval(days => p_days)
  ) m
  where l.vendor_id = p_vendor and (m.requests > 0 or l.status in ('active', 'suspended'))
  order by l.created_at, l.id;
end $$;

comment on function app.metrics_listings(uuid, int) is
  'Ответы по площадкам вендора за последние N дней. Сотрудник или система';

-- ── цена «от»: право роли API — как в 20260928120100_core.sql ───────────────
grant update (price_from_uzs, price_unit) on app.listings to bayramm_api;

-- ── пакеты залов v0.1 ───────────────────────────────────────────────────────
create type app.package_kind as enum ('weekday', 'weekend', 'custom');

create table app.listing_packages (
  id         uuid primary key default gen_random_uuid(),
  listing_id uuid not null references app.listings on delete cascade,
  kind       app.package_kind not null,
  name_ru    text not null check (length(btrim(name_ru)) between 1 and 80),
  name_uz    text not null check (length(btrim(name_uz)) between 1 and 80),
  price_uzs  bigint not null check (price_uzs between 1 and 99999999999),
  price_unit app.price_unit not null default 'per_guest',
  sort       smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index listing_packages_listing on app.listing_packages (listing_id, sort);
create unique index listing_packages_day_kind on app.listing_packages (listing_id, kind)
  where kind in ('weekday', 'weekend');

alter table app.listing_services add column package_id uuid unique;

-- 20261001010000_cabinet_integrity.sql
create function app.listing_packages_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing app.listings;
begin
  select l.* into v_listing from app.listings l where l.id = coalesce(new.listing_id, old.listing_id);
  if tg_op = 'UPDATE' and new.listing_id <> old.listing_id then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;
  if app.actor_kind() = 'vendor_user' and v_listing.status in ('review', 'active', 'suspended') then
    raise exception 'moderated_field_requires_revision' using errcode = 'BR005';
  end if;
  if app.actor_kind() = 'staff' and v_listing.status = 'active' and not app.staff_can_moderate() then
    raise exception 'moderated_field_requires_revision' using errcode = 'BR005',
      detail = 'правку опубликованной карточки решает модератор';
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
    return new;
  elsif tg_op = 'INSERT' then
    return new;
  end if;
  return old;
end $$;
create trigger listing_packages_guard before insert or update or delete on app.listing_packages
  for each row execute function app.listing_packages_guard();

-- 20260928120100_core.sql
create function app.listing_packages_keep_ready() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing app.listings;
begin
  select l.* into v_listing from app.listings l where l.id = old.listing_id;
  if found and v_listing.status in ('review', 'active')
     and 'packages' = any (app.listing_publish_blockers(v_listing, v_listing.status)) then
    raise exception 'publish_blocked' using errcode = 'BR004', detail = 'packages';
  end if;
  return null;
end $$;
create trigger listing_packages_keep_ready after update of kind, listing_id or delete on app.listing_packages
  for each row execute function app.listing_packages_keep_ready();

-- 20260930150000_admin_v01.sql
create trigger audit_staff after insert or update or delete on app.listing_packages
  for each row execute function app.audit_staff_change('listing', 'listing_id', 'listing_package', 'kind');

-- 20261001120100_categories_services.sql
create or replace function app.listing_services_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor      app.actor_kind := app.effective_actor();
  v_listing    app.listings;
  v_type       app.service_types;
  v_decides    boolean;
  v_restricted boolean;
  v_move       text;
begin
  -- Зеркало пакетов v0.1 (listing_packages_sync): пакеты пишет прежний код по своим правилам
  if current_setting('app.services_sync', true) = 'on' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    new.updated_at := now();
    return new;
  end if;

  select l.* into v_listing from app.listings l where l.id = coalesce(new.listing_id, old.listing_id);
  v_decides := v_actor = 'system' or (v_actor = 'staff' and app.staff_can_moderate());
  v_restricted := (v_actor = 'vendor_user' and v_listing.status in ('review', 'active', 'suspended'))
               or (v_actor = 'staff' and not v_decides and v_listing.status = 'active');
  if v_actor not in ('vendor_user', 'staff', 'system') then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;

  if tg_op = 'DELETE' then
    if v_listing.id is not null and v_restricted and old.status = 'active' then
      raise exception 'moderated_field_requires_revision' using errcode = 'BR005',
        detail = 'активную услугу сначала снимают с витрины';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    new.category_code := v_listing.category_code;
    select t.* into v_type from app.service_types t
    where t.category_code = new.category_code and t.code = new.service_type;
    if not found or not v_type.enabled then
      raise exception 'invalid_input' using errcode = '23514', detail = 'тип услуги не из каталога категории';
    end if;
    if not app.service_allowed(v_listing.vendor_id, new.category_code, new.service_type) then
      raise exception 'service_not_allowed' using errcode = 'BR027';
    end if;
    if not v_decides and new.status not in ('draft', 'review') then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'услугу одобряет модератор';
    end if;
    if not v_decides and (new.decision, new.decision_reason, new.decided_at) is distinct from (null, null, null) then
      raise exception 'forbidden_for_actor' using errcode = 'BR003';
    end if;
  else
    if (new.id, new.listing_id, new.category_code, new.service_type, new.created_at, new.package_id)
       is distinct from (old.id, old.listing_id, old.category_code, old.service_type, old.created_at, old.package_id) then
      raise exception 'immutable_column' using errcode = 'BR006';
    end if;
    select t.* into v_type from app.service_types t
    where t.category_code = new.category_code and t.code = new.service_type;

    if new.status is distinct from old.status then
      v_move := old.status::text || '>' || new.status::text;
      if not v_decides and v_move <> all (array[
           'draft>review', 'review>draft', 'rejected>review', 'rejected>draft', 'active>paused', 'paused>review']) then
        raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = v_move;
      end if;
    end if;
    if v_restricted and old.status in ('active', 'paused')
       and (new.name_ru, new.name_uz, new.price_uzs, new.price_unit, new.min_qty, new.lead_days,
            new.includes_ru, new.includes_uz, new.options)
           is distinct from
           (old.name_ru, old.name_uz, old.price_uzs, old.price_unit, old.min_qty, old.lead_days,
            old.includes_ru, old.includes_uz, old.options) then
      raise exception 'moderated_field_requires_revision' using errcode = 'BR005',
        detail = 'правка активной услуги — предложением';
    end if;
    if not v_decides and (new.decision, new.decision_reason, new.decided_at, new.decided_by)
       is distinct from (old.decision, old.decision_reason, old.decided_at, old.decided_by) then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'решение по услуге';
    end if;
    if new.proposal is not null and new.status not in ('active', 'paused') then
      raise exception 'illegal_transition' using errcode = 'BR002', detail = 'предложение — только к активной услуге';
    end if;
  end if;

  if v_type.free_name and new.name_ru is null then
    raise exception 'invalid_input' using errcode = '23514', detail = 'у другой услуги нужно название';
  end if;
  if not v_type.free_name and new.name_ru is not null then
    raise exception 'invalid_input' using errcode = '23514', detail = 'название — из каталога';
  end if;
  if not new.price_unit = any (v_type.units) then
    raise exception 'invalid_input' using errcode = '23514', detail = 'единица цены не из каталога';
  end if;

  if tg_op = 'INSERT' then
    new.proposal := null;
    new.proposal_at := null;
    new.proposal_by := null;
    new.created_at := now();
    new.submitted_at := case when new.status = 'review' then now() end;
    new.submitted_by := case when new.status = 'review' then app.actor_id() end;
    if new.status = 'active' then
      new.decision := 'approved';
      new.decided_at := now();
    end if;
    new.decided_by := case when new.decided_at is not null and v_actor = 'staff' then app.actor_id() end;
  else
    if new.status is distinct from old.status then
      if new.status = 'review' then
        new.submitted_at := now();
        new.submitted_by := app.actor_id();
      end if;
      if new.status in ('review', 'draft') then
        new.decision := null;
        new.decision_reason := null;
      end if;
      if new.status in ('active', 'rejected') and new.decided_at is not distinct from old.decided_at then
        new.decided_at := now();
        new.decision := case when new.status = 'active' then 'approved' else coalesce(new.decision, 'declined') end;
      end if;
    end if;
    if new.decided_at is distinct from old.decided_at then
      new.decided_by := case when v_actor = 'staff' then app.actor_id() end;
    end if;
    if new.proposal is distinct from old.proposal then
      new.proposal_at := case when new.proposal is not null then now() end;
      new.proposal_by := case when new.proposal is not null then app.actor_id() end;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- 20261001120100_categories_services.sql
create function app.listing_packages_sync() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_type text;
begin
  if not exists (select 1 from app.listings l
                 where l.id = coalesce(new.listing_id, old.listing_id) and l.category_code = 'hall') then
    return null;
  end if;
  perform set_config('app.services_sync', 'on', true);
  if tg_op in ('DELETE', 'UPDATE') then
    if tg_op = 'DELETE' or new.kind <> old.kind then
      delete from app.listing_services s where s.package_id = old.id;
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_type := case new.kind when 'weekday' then 'banquet_weekday' when 'weekend' then 'banquet_weekend' else 'other' end;
    update app.listing_services s
    set price_uzs = new.price_uzs, price_unit = new.price_unit, sort = new.sort,
        name_ru = case when v_type = 'other' then new.name_ru end,
        name_uz = case when v_type = 'other' then new.name_uz end
    where s.package_id = new.id;
    if not found then
      insert into app.listing_services
        (listing_id, category_code, service_type, status, name_ru, name_uz, price_uzs, price_unit, sort, package_id,
         decision, decided_at)
      values (new.listing_id, 'hall', v_type, 'active',
              case when v_type = 'other' then new.name_ru end, case when v_type = 'other' then new.name_uz end,
              new.price_uzs, new.price_unit, new.sort, new.id, 'approved', now());
    end if;
  end if;
  perform set_config('app.services_sync', '', true);
  return null;
end $$;

-- Данные: пакеты — из услуг залов (банкеты будни и выходные — по одному, «другие» —
-- произвольными), услуга помечена пакетом. Без зеркала и проверок: строки уже согласованы
alter table app.listing_packages disable trigger user;
insert into app.listing_packages (id, listing_id, kind, name_ru, name_uz, price_uzs, price_unit, sort, created_at)
select s.id, s.listing_id,
       (case s.service_type when 'banquet_weekday' then 'weekday' when 'banquet_weekend' then 'weekend'
                            else 'custom' end)::app.package_kind,
       coalesce(s.name_ru, t.name_ru), coalesce(s.name_uz, t.name_uz), s.price_uzs, s.price_unit, s.sort, s.created_at
from app.listing_services s
join app.service_types t on t.category_code = s.category_code and t.code = s.service_type
where s.category_code = 'hall' and s.status in ('draft', 'review', 'active')
  and (s.service_type = 'other'
       or s.id = (select s2.id from app.listing_services s2
                  where s2.listing_id = s.listing_id and s2.service_type = s.service_type
                    and s2.status in ('draft', 'review', 'active')
                  order by s2.status = 'active' desc, s2.sort, s2.created_at, s2.id
                  limit 1))
  and s.service_type in ('banquet_weekday', 'banquet_weekend', 'other');
alter table app.listing_packages enable trigger user;

alter table app.listing_services disable trigger user;
update app.listing_services s set package_id = s.id
where exists (select 1 from app.listing_packages k where k.id = s.id);
alter table app.listing_services enable trigger user;

create trigger listing_packages_sync after insert or update or delete on app.listing_packages
  for each row execute function app.listing_packages_sync();

alter table app.listing_packages enable row level security;
create policy listing_packages_read on app.listing_packages for select to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id) or app.listing_is_public(listing_id));
create policy listing_packages_write on app.listing_packages for all to bayramm_api
  using ((select app.is_privileged()) or app.edits_listing(listing_id))
  with check ((select app.is_privileged()) or app.edits_listing(listing_id));
grant select, insert, update, delete on app.listing_packages to bayramm_api;

-- ── правки карточки — к 20261001120100_categories_services.sql ──────────────
alter table app.listing_revisions drop constraint if exists listing_revisions_payload_check;
create or replace function app.revision_payload_ok(p_payload jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(p_payload) = 'object'
     and p_payload <> '{}'::jsonb
     and not exists (
       select 1 from jsonb_object_keys(p_payload) k
       where k not in ('name', 'price_from_uzs', 'price_unit', 'description_ru', 'description_uz', 'packages',
                       'attributes', 'video_links'))
$$;
alter table app.listing_revisions add constraint listing_revisions_payload_check
  check (app.revision_payload_ok(payload));

-- ── права ───────────────────────────────────────────────────────────────────
revoke execute on all functions in schema app, pii from public;
grant execute on function
  app.metrics_period(timestamptz, timestamptz),
  app.metrics_weekly(int),
  app.metrics_vendors(int, uuid),
  app.metrics_listings(uuid, int)
  to bayramm_api;
