-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — после перехода панели, кабинета и клиента на услуги (v0.2):
--
--   · пакеты залов v0.1 удалены: таблица app.listing_packages (с её триггерами,
--     политиками и журналом), тип app.package_kind, функции listing_packages_guard,
--     listing_packages_keep_ready, listing_packages_sync, столбец
--     app.listing_services.package_id и ветка зеркала пакетов в listing_services_guard.
--     Готовность к публикации и цена «от» и раньше считались из услуг
--     (20261001120100_categories_services.sql) — здесь они не меняются;
--   · правка карточки (app.listing_revisions.payload) больше не принимает ключи
--     price_from_uzs, price_unit и packages. Открытые правки: ключи цены (они и так
--     ничего не меняли) убраны; правка с пакетами или только с ценой отклонена с
--     причиной для партнёра — пакеты теперь услуги (запись в журнал —
--     listing_revision.legacy_declined). Решённые правки — история, их payload не
--     трогаем: проверка ключей — у правки, которая ждёт решения (её вставляют только
--     открытой, после решения payload не меняется — listing_revisions_guard);
--   · цену «от» (price_from_uzs, price_unit) пишет только триггер — право роли API
--     менять эти столбцы снято;
--   · метрики по категориям: в фактах заявки — категория витрины (её нельзя сменить,
--     пока у витрины есть заявки, — BR026, поэтому это категория на момент заявки);
--     app.metrics_period и app.metrics_weekly — с фильтром категории (недоставленные
--     уведомления — по заявкам этой категории), app.metrics_vendors — с фильтром и
--     категориями вендора, app.metrics_listings — с категорией витрины, новая
--     app.metrics_categories — сводка по категориям за N дней. Определения ответа,
--     «в срок» и доли — прежние (20260930220000_launch_metrics.sql);
--   · каталог без вызова функций на каждую строку. Обложку и число фото гость читает из
--     app.photos под RLS, а политика photos_read на каждой строке звала owns_listing и
--     listing_is_public (функции с правами владельца не встраиваются в план). Теперь
--     owns_listing — только когда действует партнёр, а «витрина опубликована» — подзапрос
--     в самой политике (тот же смысл: опубликованные витрины видны всем); обложка — по
--     частичному индексу photos_public. Загрузка на дату (свободно / частично / занято)
--     считалась app.listing_day_load дважды на каждую витрину выдачи — теперь
--     app.catalog_day_load(категория, день) одним запросом на всю выдачу, договорённости
--     дня — по индексу requests_deals_day.
--
-- Откат: supabase/rollbacks/20261002090000_services_only_category_metrics.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- Правки карточки: только поля, которые правка меняет
-- ════════════════════════════════════════════════════════════════════════════

-- Открытые правки с пакетами (их применяло зеркало в услуги) или только с ценой —
-- отклонены: менять цены теперь — услугами. Причину партнёр видит в кабинете
insert into app.audit_log (actor_kind, action, object_type, object_id, detail, source)
select 'system', 'listing_revision.legacy_declined', 'listing', rv.listing_id::text,
       jsonb_build_object('revision_id', rv.id,
                          'keys', to_jsonb(array(select k from jsonb_object_keys(rv.payload) k order by k))),
       'system'
from app.listing_revisions rv
where rv.status = 'pending'
  and (rv.payload ? 'packages' or rv.payload - array['price_from_uzs', 'price_unit'] = '{}'::jsonb);

update app.listing_revisions rv
set status = 'declined',
    decision_reason = 'Цены и пакеты больше не меняются правкой карточки: они задаются в разделе «Услуги». '
                      'Название и описания можно предложить заново.'
where rv.status = 'pending'
  and (rv.payload ? 'packages' or rv.payload - array['price_from_uzs', 'price_unit'] = '{}'::jsonb);

-- Остальные открытые: ключи цены убраны (цену «от» правка и раньше не меняла)
update app.listing_revisions rv
set payload = rv.payload - array['price_from_uzs', 'price_unit']
where rv.status = 'pending' and rv.payload ?| array['price_from_uzs', 'price_unit'];

alter table app.listing_revisions drop constraint listing_revisions_payload_check;

-- Как в 20261001120100_categories_services.sql, без ключей v0.1
create or replace function app.revision_payload_ok(p_payload jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(p_payload) = 'object'
     and p_payload <> '{}'::jsonb
     and not exists (
       select 1 from jsonb_object_keys(p_payload) k
       where k not in ('name', 'description_ru', 'description_uz', 'attributes', 'video_links'))
$$;

-- Ключи проверяются у правки, которая ждёт решения; решённая — история (в ней бывают
-- ключи v0.1), её payload не меняется
alter table app.listing_revisions add constraint listing_revisions_payload_check
  check (jsonb_typeof(payload) = 'object' and (status <> 'pending' or app.revision_payload_ok(payload)));

-- ════════════════════════════════════════════════════════════════════════════
-- Пакеты залов v0.1
-- ════════════════════════════════════════════════════════════════════════════

-- Таблица уходит с триггерами (listing_packages_guard, listing_packages_keep_ready,
-- listing_packages_sync, audit_staff), политиками и индексами
drop table app.listing_packages;
drop function app.listing_packages_sync();
drop function app.listing_packages_guard();
drop function app.listing_packages_keep_ready();
drop type app.package_kind;

alter table app.listing_services drop column package_id;

-- Как в 20261001120100_categories_services.sql, без зеркала пакетов (app.services_sync)
-- и без package_id
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
  select l.* into v_listing from app.listings l where l.id = coalesce(new.listing_id, old.listing_id);
  v_decides := v_actor = 'system' or (v_actor = 'staff' and app.staff_can_moderate());
  v_restricted := (v_actor = 'vendor_user' and v_listing.status in ('review', 'active', 'suspended'))
               or (v_actor = 'staff' and not v_decides and v_listing.status = 'active');
  if v_actor not in ('vendor_user', 'staff', 'system') then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;

  if tg_op = 'DELETE' then
    -- удаление вместе с карточкой (каскад) — не правка услуг
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
    if (new.id, new.listing_id, new.category_code, new.service_type, new.created_at)
       is distinct from (old.id, old.listing_id, old.category_code, old.service_type, old.created_at) then
      raise exception 'immutable_column' using errcode = 'BR006';
    end if;
    select t.* into v_type from app.service_types t
    where t.category_code = new.category_code and t.code = new.service_type;

    -- статус: кто не решает — только эти шаги
    if new.status is distinct from old.status then
      v_move := old.status::text || '>' || new.status::text;
      if not v_decides and v_move <> all (array[
           'draft>review', 'review>draft', 'rejected>review', 'rejected>draft', 'active>paused', 'paused>review']) then
        raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = v_move;
      end if;
    end if;
    -- содержание активной услуги — предложением
    if v_restricted and old.status in ('active', 'paused')
       and (new.name_ru, new.name_uz, new.price_uzs, new.price_unit, new.min_qty, new.lead_days,
            new.includes_ru, new.includes_uz, new.options)
           is distinct from
           (old.name_ru, old.name_uz, old.price_uzs, old.price_unit, old.min_qty, old.lead_days,
            old.includes_ru, old.includes_uz, old.options) then
      raise exception 'moderated_field_requires_revision' using errcode = 'BR005',
        detail = 'правка активной услуги — предложением';
    end if;
    -- решение — только тот, кто решает
    if not v_decides and (new.decision, new.decision_reason, new.decided_at, new.decided_by)
       is distinct from (old.decision, old.decision_reason, old.decided_at, old.decided_by) then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'решение по услуге';
    end if;
    -- предложение — только у активной или снятой услуги
    if new.proposal is not null and new.status not in ('active', 'paused') then
      raise exception 'illegal_transition' using errcode = 'BR002', detail = 'предложение — только к активной услуге';
    end if;
  end if;

  -- название — только у «другой услуги», и там обязательно; единица — из каталога
  if v_type.free_name and new.name_ru is null then
    raise exception 'invalid_input' using errcode = '23514', detail = 'у другой услуги нужно название';
  end if;
  if not v_type.free_name and new.name_ru is not null then
    raise exception 'invalid_input' using errcode = '23514', detail = 'название — из каталога';
  end if;
  if not new.price_unit = any (v_type.units) then
    raise exception 'invalid_input' using errcode = '23514', detail = 'единица цены не из каталога';
  end if;

  -- служебные поля
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
      -- новый круг: прежнее решение больше не действует
      if new.status in ('review', 'draft') then
        new.decision := null;
        new.decision_reason := null;
      end if;
      -- решение без явной отметки времени (одобрение при публикации карточки)
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

-- Цену «от» считает триггер из услуг: роли API писать её незачем
revoke update (price_from_uzs, price_unit) on app.listings from bayramm_api;

-- ════════════════════════════════════════════════════════════════════════════
-- Метрики по категориям
-- ════════════════════════════════════════════════════════════════════════════

-- Как в 20260930220000_launch_metrics.sql, плюс категория витрины (последним столбцом)
create or replace view app.request_metric_facts with (security_invoker = true) as
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
       r.sla_breached_at is not null as breached,
       l.category_code
from app.requests r
join app.listings l on l.id = r.listing_id
-- первый ответ площадки: её переход в contacted, deal или declined
left join lateral (
  select min(sl.at) as vendor_response_at
  from app.request_status_log sl
  where sl.request_id = r.id and sl.actor_kind = 'vendor_user' and sl.to_status in ('contacted', 'deal', 'declined')
) v on true
-- заявку закрыли без площадки: клиент отозвал или истекла дата события
left join lateral (
  select min(sl.at) as closed_at
  from app.request_status_log sl
  where sl.request_id = r.id and sl.to_status in ('withdrawn', 'expired')
) c on true;

comment on view app.request_metric_facts is
  'Факты заявки для метрик: ответ площадки (не сотрудника), в срок ли, известен ли исход, договорились, нарушение срока, категория витрины. Без ПДн';

-- Сигнатуры меняются (фильтр категории, новые столбцы): прежние — удалить, иначе вызов
-- без категории был бы неоднозначным
drop function app.metrics_weekly(int);
drop function app.metrics_period(timestamptz, timestamptz);
drop function app.metrics_vendors(int, uuid);
drop function app.metrics_listings(uuid, int);

-- Всё за период [p_from, p_to) — как в 20260930220000_launch_metrics.sql. p_category —
-- только заявки витрин этой категории и недоставленные уведомления по ним
create function app.metrics_period(p_from timestamptz, p_to timestamptz, p_category text default null)
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
          where o.status = 'dead' and o.created_at >= p_from and o.created_at < p_to
            and (p_category is null or exists (
                   select 1 from app.requests r join app.listings l on l.id = r.listing_id
                   where r.id = o.request_id and l.category_code = p_category)))::int
  from app.request_metric_facts f
  where f.created_at >= p_from and f.created_at < p_to
    and (p_category is null or f.category_code = p_category);
end $$;

comment on function app.metrics_period(timestamptz, timestamptz, text) is
  'Метрики заявок и уведомлений за период, по всем категориям или одной. Сотрудник или система';

-- По ISO-неделям по Ташкенту, текущая — первой; p_category — как в app.metrics_period
create function app.metrics_weekly(p_weeks int default 8, p_category text default null)
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
                                        (w.day + 7)::timestamp at time zone 'Asia/Tashkent', p_category) m
  order by w.day desc;
end $$;

comment on function app.metrics_weekly(int, text) is
  'Метрики по ISO-неделям (по Ташкенту), текущая — первой; по всем категориям или одной. Сотрудник или система';

-- По вендорам за последние p_days дней — как в 20260930220000_launch_metrics.sql, плюс:
-- categories — категории витрин вендора (опубликованных, приостановленных и с заявками
-- за период), по порядку категорий; p_category — только заявки и витрины этой категории
-- (вендоры — с заявками в ней или с опубликованной витриной в ней)
create function app.metrics_vendors(p_days int default 30, p_vendor uuid default null, p_category text default null)
returns table (vendor_id uuid, vendor_code text, vendor_name text, active_listings int, categories text[],
               requests int, measurable int, answered_in_time int, answered_rate numeric, responded int,
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
         (select count(*) from app.listings l
          where l.vendor_id = v.id and l.status = 'active'
            and (p_category is null or l.category_code = p_category))::int,
         array(select c.code from app.categories c
               where exists (select 1 from app.listings l
                             where l.vendor_id = v.id and l.category_code = c.code
                               and (l.status in ('active', 'suspended')
                                    or exists (select 1 from app.requests r
                                               where r.listing_id = l.id
                                                 and r.created_at >= now() - make_interval(days => p_days))))
               order by c.sort, c.code),
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
      and (p_category is null or f.category_code = p_category)
  ) m
  where (p_vendor is null or v.id = p_vendor)
    and (p_vendor is not null or m.requests > 0
         or exists (select 1 from app.listings l
                    where l.vendor_id = v.id and l.status = 'active'
                      and (p_category is null or l.category_code = p_category)))
  order by v.public_code;
end $$;

comment on function app.metrics_vendors(int, uuid, text) is
  'Ответы вендоров за последние N дней: заявки, доля ответов в срок, медиана ответа; по всем категориям или одной. Сотрудник или система';

-- По площадкам вендора — как в 20260930220000_launch_metrics.sql, плюс категория витрины
create function app.metrics_listings(p_vendor uuid, p_days int default 30)
returns table (listing_id uuid, listing_name text, listing_status app.listing_status, category_code text,
               requests int, measurable int, answered_in_time int, answered_rate numeric, responded int,
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
  select l.id, l.name, l.status, l.category_code,
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
  'Ответы по площадкам (витринам) вендора за последние N дней, с категорией витрины. Сотрудник или система';

-- Сводка по категориям за последние p_days дней: включённые категории и те, где были
-- заявки, — по порядку категорий. Опубликованные витрины и их вендоры — сейчас
create function app.metrics_categories(p_days int default 30)
returns table (category_code text, active_listings int, active_vendors int, requests int, clients int,
               measurable int, answered_in_time int, answered_rate numeric, responded int,
               median_response_minutes int, p90_response_minutes int, agreed int, agreed_rate numeric,
               sla_breaches int, last_request_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_metrics_reader();
  if p_days is null or p_days not between 1 and 366 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  return query
  select c.code, a.listings, a.vendors,
         m.requests, m.clients, m.measurable, m.answered_in_time,
         round(100.0 * m.answered_in_time / nullif(m.measurable, 0), 1),
         m.responded, m.median_response_minutes, m.p90_response_minutes, m.agreed,
         round(100.0 * m.agreed / nullif(m.requests, 0), 1),
         m.sla_breaches, m.last_request_at
  from app.categories c
  cross join lateral (
    select count(*)::int as listings, count(distinct l.vendor_id)::int as vendors
    from app.listings l where l.category_code = c.code and l.status = 'active'
  ) a
  cross join lateral (
    select count(*)::int as requests,
           count(distinct f.client_id)::int as clients,
           (count(*) filter (where f.measurable))::int as measurable,
           (count(*) filter (where f.answered_in_time))::int as answered_in_time,
           count(f.response_minutes)::int as responded,
           round(percentile_cont(0.5) within group (order by f.response_minutes))::int as median_response_minutes,
           round(percentile_cont(0.9) within group (order by f.response_minutes))::int as p90_response_minutes,
           (count(*) filter (where f.agreed))::int as agreed,
           (count(*) filter (where f.breached))::int as sla_breaches,
           max(f.created_at) as last_request_at
    from app.request_metric_facts f
    where f.category_code = c.code and f.created_at >= now() - make_interval(days => p_days)
  ) m
  where c.enabled or m.requests > 0
  order by c.sort, c.code;
end $$;

comment on function app.metrics_categories(int) is
  'Сводка по категориям за последние N дней: витрины, заявки, доля ответов в срок, договорились. Сотрудник или система';

-- ════════════════════════════════════════════════════════════════════════════
-- Каталог: без функций на каждую строку
-- ════════════════════════════════════════════════════════════════════════════

-- Фото видят: сотрудник и система — все; партнёр — своих витрин; каждый — готовые
-- одобренные фото опубликованных витрин. Смысл — как в 20260928120100_core.sql, но без
-- вызова функций на каждой строке у гостя и клиента: owns_listing — только у партнёра
-- (is not distinct from: у гостя актора нет, null and … функцию всё равно вызвал бы),
-- «опубликована» — подзапрос, а не app.listing_is_public
alter policy photos_read on app.photos
  using ((select app.is_privileged())
         or ((select app.actor_kind()) is not distinct from 'vendor_user' and app.owns_listing(listing_id))
         or (deleted_at is null and status = 'ready' and moderation = 'approved'
             and exists (select 1 from app.listings l where l.id = listing_id and l.status = 'active')));

-- Обложка и число фото витрины — по порядку показа (is_cover, sort, created_at, id)
create index photos_public on app.photos (listing_id, is_cover desc, sort, created_at, id)
  where deleted_at is null and status = 'ready' and moderation = 'approved';

-- Договорённости дня по частям — для загрузки выдачи на дату (app.catalog_day_load)
create index requests_deals_day on app.requests (event_date, listing_id)
  where status = 'deal' and day_part is not null;

-- Загрузка на день p_day опубликованных витрин категории — одним запросом на всю выдачу.
-- То же, что app.listing_day_load у каждой витрины (те же правила, что app.listing_busy):
-- день занят — отметка на весь день или заняты все части; часть занята — отметка или
-- договорённостей на неё не меньше parallel_capacity. Только витрины, где что-то
-- занято (busy, partial); остальные свободны. Без ПДн: только id витрины и загрузка
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

-- ════════════════════════════════════════════════════════════════════════════
-- Права
-- ════════════════════════════════════════════════════════════════════════════
revoke execute on all functions in schema app, pii from public;
grant execute on function
  app.metrics_period(timestamptz, timestamptz, text),
  app.metrics_weekly(int, text),
  app.metrics_vendors(int, uuid, text),
  app.metrics_listings(uuid, int),
  app.metrics_categories(int),
  app.catalog_day_load(text, date)
  to bayramm_api;
