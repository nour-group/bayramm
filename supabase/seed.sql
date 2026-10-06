-- ════════════════════════════════════════════════════════════════════════════
-- Локальный сид (supabase db reset). Только справочники.
--
-- Сами справочники — категории, поводы, районы, настройки — заводят миграции
-- (20260928120000_foundation.sql; категории и каталог услуг v0.2 —
-- 20261001120100_categories_services.sql из packages/shared/src/categories): они нужны
-- во всех окружениях, а seed.sql на staging/production не применяется. Здесь — только
-- проверка, что они на месте.
--
-- Вендоров, рейтингов, отзывов и телефонов здесь нет и не будет: демо-данные
-- не попадают ни в локальную базу, ни в production. Демо-залы для показа на staging
-- заводит и убирает POST /ops/demo (workflow Demo data) — с явной пометкой «Демо».
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_categories int := (select count(*) from app.categories);
  v_enabled    text[] := (select array_agg(code order by code) from app.categories where enabled);
  v_occasions  int := (select count(*) from app.occasions);
  v_districts  int := (select count(*) from app.districts);
  v_sla        int := app.setting_int('sla_hours');
begin
  if v_categories <> 14
     or v_enabled is distinct from array['attire', 'cake', 'car', 'decor', 'flowers', 'food', 'gifts', 'hall', 'photo', 'restaurant', 'studio', 'zags']
     or v_occasions <> 5
     or v_districts <> 12 or v_sla is distinct from 12 then
    raise exception 'справочники не совпадают с ожидаемыми: категорий %, включены %, поводов %, районов %, sla_hours %',
      v_categories, v_enabled, v_occasions, v_districts, v_sla;
  end if;
end $$;
