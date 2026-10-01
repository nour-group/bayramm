-- Откат 20261001120000_categories_units.sql: значения per_hour, per_item, per_kg, per_set,
-- per_table перечисления app.price_unit остаются — Postgres значения перечисления не
-- удаляет, а пересоздавать тип со всеми столбцами ради отката незачем: без услуг
-- (откат 20261001120100_categories_services.sql) их никто не пишет.
select 1;
