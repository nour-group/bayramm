-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — API клиента: правила создания заявки, которых не было в ядре.
--
--   · гостей не больше вместимости листинга (cap_max): форма заявки и каталог
--     считают одинаково — фильтр каталога отсекает площадки, где cap_max
--     меньше числа гостей;
--   · лимит заявок клиента — settings.client_requests_per_day за последние
--     24 часа (скользящее окно). Считаются все заявки, в том числе отозванные:
--     иначе «подать — отозвать» по кругу заваливает вендоров уведомлениями.
--     Параллельные заявки одного клиента проверяются по очереди
--     (advisory-блокировка на клиента). Заявки, внесённые оператором
--     (source = admin), в лимит не входят.
--
-- Проверки стоят отдельным триггером после requests_before_insert (триггеры
-- одного события срабатывают по имени): сначала — листинг активен, клиент не
-- заблокирован, согласие действует; потом — эти правила.
--
-- Коды ошибок (продолжение списка из 20260928120100_core.sql):
--   BR014 daily_request_limit                BR015 guests_over_capacity
--
-- Откат: supabase/rollbacks/20260930110000_client_api.down.sql
-- ════════════════════════════════════════════════════════════════════════════

create function app.requests_client_rules() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_cap   int;
  v_limit int;
  v_count int;
begin
  select l.cap_max into v_cap from app.listings l where l.id = new.listing_id;
  if v_cap is not null and new.guests > v_cap then
    raise exception 'guests_over_capacity' using errcode = 'BR015',
      detail = 'гостей больше, чем вмещает площадка';
  end if;

  if new.source in ('tma', 'web') then
    -- Блокировка до конца транзакции: вторая заявка того же клиента ждёт и
    -- считает уже с учётом первой (count под READ COMMITTED берёт свежий снимок)
    perform pg_advisory_xact_lock(hashtextextended('bayramm.client_requests:' || new.client_id::text, 0));
    v_limit := coalesce(app.setting_int('client_requests_per_day'), 10);
    select count(*) into v_count
    from app.requests r
    where r.client_id = new.client_id and r.created_at > now() - interval '24 hours';
    if v_count >= v_limit then
      raise exception 'daily_request_limit' using errcode = 'BR014',
        detail = 'лимит заявок за 24 часа исчерпан';
    end if;
  end if;
  return new;
end $$;

comment on function app.requests_client_rules() is
  'Заявка: гостей не больше cap_max листинга; не больше client_requests_per_day заявок клиента за 24 часа';

create trigger requests_client_rules before insert on app.requests
  for each row execute function app.requests_client_rules();

-- ── права ───────────────────────────────────────────────────────────────────
-- Триггерную функцию никто не вызывает напрямую
revoke execute on function app.requests_client_rules() from public;
