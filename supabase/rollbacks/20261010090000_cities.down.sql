-- Откат 20261010090000_cities.sql: районы без города, справочника городов нет. Только для
-- локальной разработки и проверки в CI (up → down → up)

drop index if exists app.districts_city;
alter table app.districts drop column if exists city_code;
drop table if exists app.cities;
