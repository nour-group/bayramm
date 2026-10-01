-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — единицы цены для категорий v0.2: за час, за штуку, за кг, за
-- комплект, за стол.
--
-- Отдельным файлом: новое значение перечисления нельзя использовать в той же
-- транзакции, где его добавили, а сид каталога услуг (следующая миграция,
-- 20261001120100_categories_services.sql) им уже пользуется.
--
-- Откат: supabase/rollbacks/20261001120000_categories_units.down.sql
-- ════════════════════════════════════════════════════════════════════════════

alter type app.price_unit add value if not exists 'per_hour';
alter type app.price_unit add value if not exists 'per_item';
alter type app.price_unit add value if not exists 'per_kg';
alter type app.price_unit add value if not exists 'per_set';
alter type app.price_unit add value if not exists 'per_table';
