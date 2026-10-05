-- Контакты витрины для клиентов: телефон и Telegram — по кнопке «Связаться», а не в карточке
-- сразу. Каждое открытие контактов и выбор канала — событие без клиента (только витрина,
-- откуда и вошёл ли человек): по ним панель видит, у каких витрин чаще ищут связь.
--
--   · pii.listing_contacts.public_telegram — Telegram витрины для клиентов (имя без @);
--     читать — только функциями, как телефон;
--   · pii.listing_contact_kinds(листинг) — какие каналы есть (phone, telegram), без значений:
--     карточке клиента — какие кнопки показать, панели — что вписано;
--   · pii.reveal_listing_contacts(листинг, источник, вошёл) — контакты опубликованной витрины
--     и событие open одним вызовом: без события контактов не прочитать;
--   · pii.read_listing_contacts(листинг, причина) — телефон и Telegram для панели и кабинета
--     (у неопубликованной — в журнал доступа к ПДн, как pii.read_listing_phone);
--   · app.contact_events и app.record_contact_event — «позвонил» / «написал в Telegram»;
--   · app.metrics_contacts(дней, категория) — витрины по числу открытий (право metrics.read).

-- ════════════════════════════════════════════════════════════════════════════
-- Telegram витрины
-- ════════════════════════════════════════════════════════════════════════════

-- Имя пользователя или канала Telegram: 5–32 знака, латиница, цифры и _, с буквы
alter table pii.listing_contacts
  add column public_telegram text check (public_telegram ~ '^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$');

comment on column pii.listing_contacts.public_telegram is
  'Telegram витрины для клиентов (имя без @); читать — pii.read_listing_contacts / reveal_listing_contacts';

-- Какие каналы связи вписаны — без самих значений
create function pii.listing_contact_kinds(p_listing uuid) returns text[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select array_remove(array[
              case when c.public_phone is not null then 'phone' end,
              case when c.public_telegram is not null then 'telegram' end
            ], null)
       from pii.listing_contacts c where c.listing_id = p_listing),
    array[]::text[])
$$;

-- Телефон и Telegram витрины: у опубликованной — всем (без журнала), у остальных — сотруднику и
-- владельцу, с записью в журнал. Те же правила, что pii.read_listing_phone
create function pii.read_listing_contacts(p_listing uuid, p_reason text default null)
returns table (phone text, telegram text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_status  app.listing_status;
  v_purpose text;
  v_phone   text;
  v_tg      text;
begin
  select l.status into v_status from app.listings l where l.id = p_listing;
  if not found then
    return;
  end if;
  select c.public_phone, c.public_telegram into v_phone, v_tg
  from pii.listing_contacts c where c.listing_id = p_listing;
  if v_status <> 'active' and (v_phone is not null or v_tg is not null) then
    if app.actor_kind() = 'staff' and app.current_staff_role() is not null then
      v_purpose := 'staff_listing';
    elsif app.owns_listing(p_listing) then
      v_purpose := 'self';
    else
      return;
    end if;
    perform app.log_pii_access('listing_contact', p_listing, v_purpose, p_reason);
  end if;
  return query select v_phone, v_tg;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- События «связаться»
-- ════════════════════════════════════════════════════════════════════════════

-- Без клиента и адреса: витрина, что сделал, откуда и вошёл ли. Для «у кого чаще ищут связь»
create table app.contact_events (
  id         bigint generated always as identity primary key,
  listing_id uuid not null references app.listings on delete cascade,
  action     text not null check (action in ('open', 'phone', 'telegram')),
  source     app.source not null check (source in ('tma', 'web')),
  signed_in  boolean not null,
  created_at timestamptz not null default now()
);

create index contact_events_listing on app.contact_events (listing_id, created_at);
create index contact_events_created on app.contact_events (created_at);

comment on table app.contact_events is
  'Клиент открыл контакты витрины (open) или выбрал канал (phone, telegram) — без клиента; пишут функции';

-- Прямого доступа у API нет: пишут pii.reveal_listing_contacts и app.record_contact_event,
-- читает app.metrics_contacts
alter table app.contact_events enable row level security;

-- Контакты опубликованной витрины и событие open — одним вызовом. Неопубликованной или
-- несуществующей — ничего (и события нет)
create function pii.reveal_listing_contacts(p_listing uuid, p_source text, p_signed_in boolean)
returns table (phone text, telegram text)
language plpgsql security definer set search_path = ''
as $$
begin
  if p_source is null or p_source not in ('tma', 'web') or p_signed_in is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  if not exists (select 1 from app.listings l where l.id = p_listing and l.status = 'active') then
    return;
  end if;
  insert into app.contact_events (listing_id, action, source, signed_in)
  values (p_listing, 'open', p_source::app.source, p_signed_in);
  return query
  select c.public_phone, c.public_telegram from pii.listing_contacts c where c.listing_id = p_listing;
end $$;

-- Клиент выбрал канал: «позвонить» или «написать в Telegram». Только у опубликованной витрины;
-- возвращает, записано ли
create function app.record_contact_event(p_listing uuid, p_action text, p_source text, p_signed_in boolean)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_action is null or p_action not in ('phone', 'telegram')
     or p_source is null or p_source not in ('tma', 'web') or p_signed_in is null then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  if not exists (select 1 from app.listings l where l.id = p_listing and l.status = 'active') then
    return false;
  end if;
  insert into app.contact_events (listing_id, action, source, signed_in)
  values (p_listing, p_action, p_source::app.source, p_signed_in);
  return true;
end $$;

-- Витрины по числу открытий контактов за p_days дней (1–366), категория — по желанию. Только
-- витрины с событиями, не больше 50. Без ПДн: числа, названия витрин и вендоров
create function app.metrics_contacts(p_days int default 30, p_category text default null)
returns table (listing_id uuid, listing_name text, listing_status app.listing_status, category_code text,
               vendor_id uuid, vendor_name text, opens int, phone int, telegram int)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_metrics_reader();
  if p_days is null or p_days not between 1 and 366 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;
  return query
  select l.id, l.name, l.status, l.category_code, v.id, v.name,
         e.opens, e.phone, e.telegram
  from (
    select ce.listing_id,
           (count(*) filter (where ce.action = 'open'))::int as opens,
           (count(*) filter (where ce.action = 'phone'))::int as phone,
           (count(*) filter (where ce.action = 'telegram'))::int as telegram
    from app.contact_events ce
    where ce.created_at >= now() - make_interval(days => p_days)
    group by ce.listing_id
  ) e
  join app.listings l on l.id = e.listing_id
  join app.vendor_accounts v on v.id = l.vendor_id
  where p_category is null or l.category_code = p_category
  order by e.opens desc, e.phone + e.telegram desc, l.name, l.id
  limit 50;
end $$;

comment on function app.metrics_contacts(int, text) is
  'У каких витрин чаще открывают контакты: открытия, звонки, Telegram за период (без клиентов)';

-- ════════════════════════════════════════════════════════════════════════════
-- Права
-- ════════════════════════════════════════════════════════════════════════════
revoke execute on all functions in schema app, pii from public;
grant execute on function
  pii.listing_contact_kinds(uuid),
  pii.read_listing_contacts(uuid, text),
  pii.reveal_listing_contacts(uuid, text, boolean),
  app.record_contact_event(uuid, text, text, boolean),
  app.metrics_contacts(int, text)
  to bayramm_api;
