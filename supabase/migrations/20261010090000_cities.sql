-- Города: район — в городе. Фильтр каталога «город → район»: весь Ташкент или только
-- Юнусабад. Пока город один — Ташкент; новые города и их районы — миграцией, как районы.
-- Справочник публичный (его видят и гости), меняется миграциями, а не API

create table app.cities (
  code    text primary key check (code ~ '^[a-z_]{2,30}$'),
  name_ru text not null,
  name_uz text not null,
  sort    smallint not null default 0
);
comment on table app.cities is 'Города; районы (app.districts) — внутри города';

insert into app.cities (code, name_ru, name_uz, sort) values
  ('tashkent', 'Ташкент', 'Toshkent', 1)
on conflict (code) do update
  set name_ru = excluded.name_ru, name_uz = excluded.name_uz, sort = excluded.sort;

-- Все 12 районов — Ташкента; дальше город у района задаётся явно
alter table app.districts add column city_code text references app.cities;
update app.districts set city_code = 'tashkent' where city_code is null;
alter table app.districts alter column city_code set not null;
comment on column app.districts.city_code is 'Город района';
create index districts_city on app.districts (city_code);

alter table app.cities enable row level security;
create policy cities_read on app.cities for select to bayramm_api using (true);
grant select on app.cities to bayramm_api;
