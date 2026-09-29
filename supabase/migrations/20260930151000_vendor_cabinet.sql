-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — кабинет вендора v0.1: сессии кабинета и календарь занятости.
--
--   · сессия кабинета — app.sessions.vendor_user_id: via tg_partner (вход из
--     Mini App бота по initData) или sms_otp (позже); сессия tg_partner живёт
--     не дольше 12 часов — как у сотрудников;
--   · занятость (app.availability) пишут вендор, сотрудник и система.
--     Вендор отмечает и снимает свои дни (source vendor) и дни, занятые его
--     отказом «занято» (request_decline), но не дни, закрытые сотрудником
--     (staff). Отметку не правят, а снимают и ставят заново. Автора и время
--     отметки ставит база;
--   · отказ по заявке с причиной «занято» сам занимает дату события у
--     листинга (source request_decline, ссылка на заявку), «вернуть в
--     активные» — освобождает её. Кто бы ни отказал — кабинет, бот или
--     оператор, — календарь один и тот же.
--
-- Откат: supabase/rollbacks/20260930151000_vendor_cabinet.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── сессии кабинета ─────────────────────────────────────────────────────────
-- Субъект сессии по via: tg_client — клиент, tg_staff — сотрудник (миграция
-- staff_telegram), tg_partner и sms_otp — пользователь вендора
alter table app.sessions
  add constraint sessions_vendor_via check ((via in ('tg_partner', 'sms_otp')) = (vendor_user_id is not null)),
  add constraint sessions_vendor_ttl check (via <> 'tg_partner' or expires_at <= created_at + interval '12 hours');

-- ── занятость ───────────────────────────────────────────────────────────────
-- «Отказной» день всегда знает свою заявку, остальные — нет
alter table app.availability
  add constraint availability_decline_request check ((source = 'request_decline') = (request_id is not null));

comment on column app.availability.source is
  'vendor — отметил вендор; request_decline — отказ «занято» по заявке request_id; staff — закрыл сотрудник';

create function app.availability_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor app.actor_kind := app.effective_actor();
begin
  if tg_op = 'DELETE' then
    if v_actor = 'vendor_user' and old.source = 'staff' then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'день закрыт сотрудником';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if v_actor = 'vendor_user' then
      raise exception 'forbidden_for_actor' using errcode = 'BR003',
        detail = 'отметку снимают и ставят заново, а не правят';
    end if;
    if (new.listing_id, new.day, new.created_by, new.created_at)
       is distinct from (old.listing_id, old.day, old.created_by, old.created_at) then
      raise exception 'immutable_column' using errcode = 'BR006';
    end if;
  else
    new.created_by := app.actor_id();
    new.created_at := now();
    if v_actor = 'vendor_user' and new.source = 'staff' then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'source staff ставит только сотрудник';
    end if;
  end if;

  -- «Отказной» день — ровно дата события заявки этого листинга с отказом «занято»
  if new.source = 'request_decline' and not exists (
       select 1 from app.requests r
       where r.id = new.request_id and r.listing_id = new.listing_id and r.event_date = new.day
         and r.status = 'declined' and r.decline_reason = 'busy') then
    raise exception 'invalid_input' using errcode = '23514',
      detail = 'request_decline — только дата заявки этого листинга с отказом «занято»';
  end if;
  return new;
end $$;

create trigger availability_guard before insert or update or delete on app.availability
  for each row execute function app.availability_guard();

-- Отказ «занято» занимает дату события; уход из отказа («вернуть в активные»)
-- снимает только ту отметку, которую поставил этот отказ. День, уже занятый
-- раньше (вендором или сотрудником), не трогается ни при отказе, ни при возврате
create function app.requests_decline_busy_day() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.status = 'declined' and new.status <> 'declined' then
    delete from app.availability a
    where a.request_id = new.id and a.source = 'request_decline';
  end if;
  if new.status = 'declined' and new.decline_reason = 'busy'
     and old.status is distinct from 'declined' then
    insert into app.availability (listing_id, day, source, request_id)
    values (new.listing_id, new.event_date, 'request_decline', new.id)
    on conflict (listing_id, day) do nothing;
  end if;
  return null;
end $$;

create trigger requests_decline_busy_day after update of status on app.requests
  for each row when (old.status is distinct from new.status)
  execute function app.requests_decline_busy_day();

-- ── права ───────────────────────────────────────────────────────────────────
-- Триггерные функции API не вызывает
revoke execute on function app.availability_guard(), app.requests_decline_busy_day() from public;
