-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — категории и услуги (v0.2).
--
--   · категории: режим занятости (day | parts | slot | lead), правило фото
--     (no_people | portfolio), минимум фото, ссылки на видео, обязательные поля
--     карточки, поля витрины и услуги — из конфигурации packages/shared/src/categories
--     (источник правды; сид ниже печатает pnpm --filter @bayramm/shared categories:sql,
--     интеграционный тест API сверяет базу с конфигурацией). Новые коды: studio, flowers,
--     gifts, restaurant, attire, zags; приоритетные категории включены;
--   · каталог услуг app.service_types: код в категории, названия, допустимые единицы
--     цены, уровень tier (base | extra — точка для будущей проверки тарифа), входит ли в
--     цену «от», «другая услуга» со свободным названием (other — в каждой категории),
--     шаблоны опций;
--   · услуги витрины app.listing_services: тип, цена и единица, минимальное количество,
--     срок подготовки, «что входит» на двух языках, опции (название, цена, единица).
--     Статусы: draft → review → active | rejected; active ⇄ paused (снова на витрину — через
--     review). Кто решает по модерации (администратор, модератор, система), ставит
--     active и rejected; остальные (партнёр, менеджер) — draft и review. Правка активной
--     услуги у опубликованной карточки — предложением (proposal): клиент видит одобренное,
--     пока предложение ждёт решения. Публикация карточки одобряет её услуги на проверке
--     (как фото). Решение по услуге опубликованной карточки — оповещение владельцам
--     кабинета (vendor.service_decided), новая услуга или предложение от партнёра или
--     менеджера — команде (ops.service_submitted); в payload — только id;
--   · app.service_allowed(вендор, категория, тип) — единственная точка будущей проверки
--     тарифа: сейчас всегда true, плата ни на что не влияет — ни на выдачу, ни на порядок;
--   · цена «от» карточки (listings.price_from_uzs, price_unit) теперь вычисляемая: самая
--     низкая цена активных услуг, входящих в цену «от» (у зала — банкеты; нет таких —
--     любых активных). Пока карточка не опубликована, считаются и услуги на проверке.
--     Пишет её только триггер — запись API в эти столбцы ничего не меняет. Прежние
--     значения записаны в журнал действий (listing.price_from_snapshot);
--   · готовность к публикации — по категории (app.listing_publish_blockers): цена
--     (price — хоть одна услуга с ценой), вместимость и район — если обязательны в
--     категории, описания, телефон, обязательные услуги категории (packages — у зала
--     банкеты будни и выходные, как пакеты v0.1), обязательные поля витрины
--     (attributes), минимум фото категории, чек-лист вендора;
--   · поля витрины — app.listings.attributes (jsonb; структуру проверяет API по
--     конфигурации, база — объект и размер, обязательность — блокер attributes); ссылки
--     на видео — app.listings.video_links (YouTube, Instagram; канонический вид, не
--     больше max_video_links категории);
--   · один вендор — витрины в нескольких категориях: app.staff_add_listing (сотрудник
--     добавляет витрину существующему вендору, запись в журнал). Категорию витрины
--     меняет только сотрудник (app.staff_set_listing_category) и только пока по ней нет
--     заявок; услуги прежней категории удаляются, поля витрины очищаются;
--   · занятость по частям дня (режим parts — фото и видео, кортеж, декор): день делится
--     на утро, день и вечер; app.listings.parallel_capacity — сколько заказов витрина
--     берёт одновременно (экипажи, машины). Часть занята, когда договорённостей
--     (заявки deal) на неё не меньше parallel_capacity или вендор отметил её занятой
--     (app.availability_parts); день занят — отметка на весь день (app.availability, как
--     раньше) или заняты все части. Часть дня заявки (app.requests.day_part) API
--     выводит из времени начала. Прошедшие дни не меняются, правка календаря — от
--     версии (как в 20261001010000_cabinet_integrity.sql), смена parallel_capacity тоже
--     поднимает версию. Публичная занятость — app.listing_busy (без ПДн);
--   · заявка: число гостей — не у всех категорий (guests может быть пустым), поля
--     категории — app.requests.details (jsonb; проверяет API по форме категории, без
--     свободного текста — он в комментарии по согласию). details и day_part после
--     подачи не меняются;
--   · фото: у категорий portfolio (фото и видео, студия) люди на фото допустимы —
--     загрузивший подтверждает согласие людей (people_consent_ack, заголовок
--     X-Photo-Consent); у остальных — как раньше, «без лиц» (no_faces_ack);
--   · залы переходят на услуги без простоя: пакеты v0.1 скопированы в услуги
--     (weekday → banquet_weekday, weekend → banquet_weekend, custom → other), пакеты,
--     которые пишет прежний код, зеркалит в услуги триггер listing_packages_sync.
--     Таблицу app.listing_packages, этот триггер, столбец listing_services.package_id и
--     ключи price_from_uzs, price_unit, packages правки карточки удалит отдельная
--     миграция, когда панель, кабинет и клиент перейдут на услуги.
--
-- Коды ошибок (продолжение списка из 20261001010000_cabinet_integrity.sql):
--   BR026 category_locked                    BR028 photo_ack_required
--   BR027 service_not_allowed
--
-- Откат: supabase/rollbacks/20261001120100_categories_services.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── перечисления ────────────────────────────────────────────────────────────
create type app.availability_mode as enum ('day', 'parts', 'slot', 'lead');
create type app.photo_policy as enum ('no_people', 'portfolio');
create type app.service_tier as enum ('base', 'extra');
create type app.service_status as enum ('draft', 'review', 'active', 'rejected', 'paused');
create type app.day_part as enum ('morning', 'day', 'evening');

-- ════════════════════════════════════════════════════════════════════════════
-- Категории и каталог услуг
-- ════════════════════════════════════════════════════════════════════════════

alter table app.categories
  add column availability_mode   app.availability_mode not null default 'day',
  add column photo_policy        app.photo_policy not null default 'no_people',
  add column min_photos          smallint not null default 3,
  add column max_video_links     smallint not null default 0,
  add column required_fields     text[] not null default '{}',
  add column required_attributes text[] not null default '{}',
  add column required_services   text[] not null default '{}',
  -- правило продукта: минимум 3 фото, у категории можно только больше
  add constraint categories_min_photos check (min_photos between 3 and 30),
  add constraint categories_max_video_links check (max_video_links between 0 and 10),
  add constraint categories_required_fields check (required_fields <@ array['guest_capacity', 'district']::text[]);

comment on table app.categories is
  'Категории; описание каждой — packages/shared/src/categories (источник правды), сид — миграцией';

create table app.service_types (
  category_code text not null references app.categories,
  code          text not null check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_ru       text not null check (length(btrim(name_ru)) between 1 and 80),
  name_uz       text not null check (length(btrim(name_uz)) between 1 and 80),
  units         app.price_unit[] not null check (cardinality(units) between 1 and 7),
  -- base | extra: точка для будущей проверки тарифа (app.service_allowed), сейчас ни на что не влияет
  tier          app.service_tier not null default 'extra',
  in_price_from boolean not null default true,
  free_name     boolean not null default false,
  enabled       boolean not null default true,
  sort          smallint not null default 0,
  -- шаблоны опций: [{ code, name_ru, name_uz, unit }]
  options       jsonb not null default '[]' check (jsonb_typeof(options) = 'array'),
  primary key (category_code, code)
);
comment on table app.service_types is
  'Каталог типов услуг категорий: коды и правила — из packages/shared/src/categories, сид — миграцией';

-- categories-seed:begin (pnpm --filter @bayramm/shared categories:sql)
insert into app.categories (code, name_ru, name_uz, enabled, sort, availability_mode, photo_policy,
                            min_photos, max_video_links, required_fields, required_attributes,
                            required_services) values
  ('hall', 'Площадка / Тойхона', 'Maydon / Toʻyxona', true, 1, 'day'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, array['guest_capacity', 'district']::text[], '{}'::text[], array['banquet_weekday', 'banquet_weekend']::text[]),
  ('car', 'Кортеж', 'Kortej', true, 2, 'parts'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], array['fleet', 'service_area']::text[], '{}'::text[]),
  ('studio', 'Фотостудия', 'Fotostudiya', true, 3, 'slot'::app.availability_mode, 'portfolio'::app.photo_policy, 3, 3, array['district']::text[], array['area_m2', 'zones_count']::text[], '{}'::text[]),
  ('flowers', 'Цветы', 'Gullar', true, 4, 'lead'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], array['flower_kinds', 'lead_days']::text[], '{}'::text[]),
  ('photo', 'Фото и видео', 'Foto va video', true, 5, 'parts'::app.availability_mode, 'portfolio'::app.photo_policy, 3, 3, '{}'::text[], array['team', 'delivery_days']::text[], '{}'::text[]),
  ('cake', 'Торты и сладости', 'Tort va shirinliklar', true, 6, 'lead'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], array['cake_kinds', 'lead_days']::text[], '{}'::text[]),
  ('gifts', 'Подарки', 'Sovgʻalar', true, 7, 'lead'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], array['gift_kinds', 'min_batch', 'lead_days']::text[], '{}'::text[]),
  ('decor', 'Декор / Оформление', 'Dekor / Bezak', true, 8, 'parts'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], array['styles']::text[], '{}'::text[]),
  ('food', 'Стол / Кейтеринг', 'Dasturxon / Ketering', false, 9, 'day'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], '{}'::text[], '{}'::text[]),
  ('restaurant', 'Рестораны', 'Restoranlar', false, 10, 'day'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], '{}'::text[], '{}'::text[]),
  ('attire', 'Свадебная одежда', 'Toʻy liboslari', false, 11, 'lead'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], '{}'::text[], '{}'::text[]),
  ('music', 'Музыка / Ведущий', 'Musiqa / Boshlovchi', false, 12, 'day'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], '{}'::text[], '{}'::text[]),
  ('kids', 'Аниматоры', 'Animatorlar', false, 13, 'day'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], '{}'::text[], '{}'::text[]),
  ('zags', 'ЗАГС', 'FHDYo', false, 14, 'day'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], '{}'::text[], '{}'::text[])
on conflict (code) do update set
  name_ru = excluded.name_ru, name_uz = excluded.name_uz, enabled = excluded.enabled,
  sort = excluded.sort, availability_mode = excluded.availability_mode,
  photo_policy = excluded.photo_policy, min_photos = excluded.min_photos,
  max_video_links = excluded.max_video_links, required_fields = excluded.required_fields,
  required_attributes = excluded.required_attributes, required_services = excluded.required_services;

insert into app.service_types (category_code, code, name_ru, name_uz, units, tier, in_price_from,
                               free_name, sort, options) values
  ('hall', 'banquet_weekday', 'Банкет — будни', 'Banket — ish kunlari', array['per_guest', 'per_event']::app.price_unit[], 'base'::app.service_tier, true, false, 1, '[{"code":"extra_dish","name_ru":"Дополнительное блюдо","name_uz":"Qoʻshimcha taom","unit":"per_guest"},{"code":"drinks","name_ru":"Напитки","name_uz":"Ichimliklar","unit":"per_guest"},{"code":"cake","name_ru":"Торт","name_uz":"Tort","unit":"per_event"}]'::jsonb),
  ('hall', 'banquet_weekend', 'Банкет — выходные', 'Banket — dam olish kunlari', array['per_guest', 'per_event']::app.price_unit[], 'base'::app.service_tier, true, false, 2, '[{"code":"extra_dish","name_ru":"Дополнительное блюдо","name_uz":"Qoʻshimcha taom","unit":"per_guest"},{"code":"drinks","name_ru":"Напитки","name_uz":"Ichimliklar","unit":"per_guest"},{"code":"cake","name_ru":"Торт","name_uz":"Tort","unit":"per_event"}]'::jsonb),
  ('hall', 'morning_plov', 'Утренний плов', 'Nahorgi osh', array['per_guest']::app.price_unit[], 'extra'::app.service_tier, false, false, 3, '[]'::jsonb),
  ('hall', 'fotiha_hall', 'Малый зал: фотиха, девичник', 'Kichik zal: fotiha, qiz bazmi', array['per_guest', 'per_event']::app.price_unit[], 'extra'::app.service_tier, false, false, 4, '[]'::jsonb),
  ('hall', 'hall_rent', 'Аренда зала без угощения', 'Zal ijarasi (taomsiz)', array['per_event']::app.price_unit[], 'extra'::app.service_tier, false, false, 5, '[{"code":"decor","name_ru":"Оформление","name_uz":"Bezak","unit":"per_event"},{"code":"sound","name_ru":"Звук","name_uz":"Ovoz tizimi","unit":"per_event"},{"code":"stage","name_ru":"Сцена","name_uz":"Sahna","unit":"per_event"}]'::jsonb),
  ('hall', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_guest', 'per_event']::app.price_unit[], 'extra'::app.service_tier, false, true, 6, '[]'::jsonb),
  ('car', 'bride_car', 'Машина для молодожёнов', 'Kelin-kuyov mashinasi', array['per_hour']::app.price_unit[], 'base'::app.service_tier, true, false, 1, '[{"code":"flower_decor","name_ru":"Украшение живыми цветами","name_uz":"Jonli gullar bilan bezash","unit":"per_event"},{"code":"extra_hour","name_ru":"Дополнительный час","name_uz":"Qoʻshimcha soat","unit":"per_hour"},{"code":"champagne","name_ru":"Шампанское и вода","name_uz":"Shampan va suv","unit":"per_item"}]'::jsonb),
  ('car', 'motorcade', 'Кортеж из нескольких машин', 'Bir nechta mashinadan kortej', array['per_hour']::app.price_unit[], 'extra'::app.service_tier, true, false, 2, '[{"code":"decor","name_ru":"Оформление","name_uz":"Bezak","unit":"per_event"},{"code":"coordinator","name_ru":"Координатор","name_uz":"Koordinator","unit":"per_event"}]'::jsonb),
  ('car', 'limousine', 'Лимузин', 'Limuzin', array['per_hour']::app.price_unit[], 'extra'::app.service_tier, true, false, 3, '[{"code":"photo_stops","name_ru":"Остановки для фотосессии","name_uz":"Fotosessiya uchun toʻxtashlar","unit":"per_event"}]'::jsonb),
  ('car', 'retro_car', 'Ретро-автомобиль', 'Retro mashina', array['per_hour', 'per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 4, '[{"code":"photo_stops","name_ru":"Остановки для фотосессии","name_uz":"Fotosessiya uchun toʻxtashlar","unit":"per_event"}]'::jsonb),
  ('car', 'guest_transfer', 'Трансфер гостей (минивэн, автобус)', 'Mehmonlar transferi (miniven, avtobus)', array['per_hour', 'per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 5, '[]'::jsonb),
  ('car', 'car_decor', 'Украшение машины', 'Mashina bezagi', array['per_item']::app.price_unit[], 'extra'::app.service_tier, false, false, 6, '[{"code":"fresh_flowers","name_ru":"Живые цветы","name_uz":"Jonli gullar","unit":"per_item"}]'::jsonb),
  ('car', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_hour', 'per_event', 'per_item']::app.price_unit[], 'extra'::app.service_tier, false, true, 7, '[]'::jsonb),
  ('studio', 'studio_rent', 'Аренда студии', 'Studiya ijarasi', array['per_hour']::app.price_unit[], 'base'::app.service_tier, true, false, 1, '[{"code":"extra_hour","name_ru":"Дополнительный час","name_uz":"Qoʻshimcha soat","unit":"per_hour"},{"code":"extra_zone","name_ru":"Дополнительная зона","name_uz":"Qoʻshimcha zona","unit":"per_hour"}]'::jsonb),
  ('studio', 'love_story_package', 'Пакет Love story', 'Love story paketi', array['per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 2, '[{"code":"makeup","name_ru":"Макияж","name_uz":"Grim","unit":"per_event"},{"code":"outfit_rent","name_ru":"Прокат образа","name_uz":"Libos ijarasi","unit":"per_event"}]'::jsonb),
  ('studio', 'pre_wedding_shoot', 'Предсвадебная фотосессия', 'Toʻy oldi fotosessiyasi', array['per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 3, '[]'::jsonb),
  ('studio', 'family_shoot', 'Семейная фотосессия, бешик-той', 'Oilaviy fotosessiya, beshik toʻyi', array['per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 4, '[]'::jsonb),
  ('studio', 'makeup_hair', 'Макияж и причёска в студии', 'Studiyada grim va soch turmagi', array['per_event']::app.price_unit[], 'extra'::app.service_tier, false, false, 5, '[]'::jsonb),
  ('studio', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_hour', 'per_event']::app.price_unit[], 'extra'::app.service_tier, false, true, 6, '[]'::jsonb),
  ('flowers', 'bridal_bouquet', 'Букет невесты', 'Kelin guldastasi', array['per_item']::app.price_unit[], 'base'::app.service_tier, true, false, 1, '[{"code":"toss_bouquet","name_ru":"Дублёр букета для броска","name_uz":"Otish uchun dubl guldasta","unit":"per_item"}]'::jsonb),
  ('flowers', 'boutonniere', 'Бутоньерка', 'Butonyerka', array['per_item']::app.price_unit[], 'extra'::app.service_tier, false, false, 2, '[]'::jsonb),
  ('flowers', 'car_flower_decor', 'Цветы на машину', 'Mashina uchun gullar', array['per_set']::app.price_unit[], 'extra'::app.service_tier, true, false, 3, '[]'::jsonb),
  ('flowers', 'hall_flower_decor', 'Цветочное оформление зала и тора', 'Zal va toʻrni gul bilan bezash', array['per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 4, '[{"code":"arch","name_ru":"Арка","name_uz":"Arka","unit":"per_item"},{"code":"flower_wall","name_ru":"Цветочная стена","name_uz":"Gul devor","unit":"per_item"}]'::jsonb),
  ('flowers', 'flower_arch', 'Цветочная арка', 'Gul arka', array['per_item']::app.price_unit[], 'extra'::app.service_tier, true, false, 5, '[]'::jsonb),
  ('flowers', 'table_compositions', 'Композиции на столы', 'Stol kompozitsiyalari', array['per_table']::app.price_unit[], 'extra'::app.service_tier, true, false, 6, '[]'::jsonb),
  ('flowers', 'gift_bouquet', 'Подарочный букет', 'Sovgʻa guldastasi', array['per_item']::app.price_unit[], 'extra'::app.service_tier, true, false, 7, '[{"code":"delivery","name_ru":"Доставка","name_uz":"Yetkazib berish","unit":"per_event"}]'::jsonb),
  ('flowers', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_item', 'per_set', 'per_event', 'per_table']::app.price_unit[], 'extra'::app.service_tier, false, true, 8, '[]'::jsonb),
  ('photo', 'photo_shoot', 'Фотосъёмка в день свадьбы', 'Toʻy kuni fotosuratga olish', array['per_hour', 'per_event']::app.price_unit[], 'base'::app.service_tier, true, false, 1, '[{"code":"extra_hour","name_ru":"Дополнительный час","name_uz":"Qoʻshimcha soat","unit":"per_hour"},{"code":"second_photographer","name_ru":"Второй фотограф","name_uz":"Ikkinchi fotograf","unit":"per_event"},{"code":"photobook","name_ru":"Фотокнига","name_uz":"Fotokitob","unit":"per_item"}]'::jsonb),
  ('photo', 'videography', 'Видеосъёмка', 'Videoga olish', array['per_hour', 'per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 2, '[{"code":"second_camera","name_ru":"Вторая камера","name_uz":"Ikkinchi kamera","unit":"per_event"},{"code":"extra_hour","name_ru":"Дополнительный час","name_uz":"Qoʻshimcha soat","unit":"per_hour"}]'::jsonb),
  ('photo', 'drone', 'Съёмка с дрона', 'Dron bilan suratga olish', array['per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 3, '[]'::jsonb),
  ('photo', 'love_story', 'Love story (фото или видео)', 'Love story (foto yoki video)', array['per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 4, '[{"code":"studio_rent","name_ru":"Аренда студии","name_uz":"Studiya ijarasi","unit":"per_hour"}]'::jsonb),
  ('photo', 'same_day_edit', 'Клип в тот же день', 'Shu kunning oʻzida klip', array['per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 5, '[]'::jsonb),
  ('photo', 'morning_plov_shoot', 'Съёмка утреннего плова, фотихи', 'Nahorgi osh, fotihani suratga olish', array['per_hour', 'per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 6, '[]'::jsonb),
  ('photo', 'photobook', 'Фотокнига', 'Fotokitob', array['per_item']::app.price_unit[], 'extra'::app.service_tier, false, false, 7, '[]'::jsonb),
  ('photo', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_hour', 'per_event', 'per_item']::app.price_unit[], 'extra'::app.service_tier, false, true, 8, '[]'::jsonb),
  ('cake', 'wedding_cake', 'Свадебный торт', 'Toʻy torti', array['per_kg']::app.price_unit[], 'base'::app.service_tier, true, false, 1, '[{"code":"tier","name_ru":"Дополнительный ярус","name_uz":"Qoʻshimcha qavat","unit":"per_item"},{"code":"figure","name_ru":"Фигурка","name_uz":"Haykalcha","unit":"per_item"},{"code":"fresh_flowers","name_ru":"Живые цветы","name_uz":"Jonli gullar","unit":"per_event"},{"code":"delivery","name_ru":"Доставка","name_uz":"Yetkazib berish","unit":"per_event"}]'::jsonb),
  ('cake', 'bento', 'Бенто и маленькие торты', 'Bento va kichik tortlar', array['per_item']::app.price_unit[], 'extra'::app.service_tier, true, false, 2, '[]'::jsonb),
  ('cake', 'candy_bar', 'Кэнди-бар', 'Shirinlik stoli (candy bar)', array['per_guest', 'per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 3, '[{"code":"decor","name_ru":"Оформление","name_uz":"Bezak","unit":"per_event"},{"code":"table","name_ru":"Стол","name_uz":"Stol","unit":"per_event"}]'::jsonb),
  ('cake', 'pastries', 'Выпечка и национальные сладости', 'Pishiriqlar va milliy shirinliklar', array['per_kg', 'per_item']::app.price_unit[], 'extra'::app.service_tier, true, false, 4, '[]'::jsonb),
  ('cake', 'tasting', 'Дегустация', 'Degustatsiya', array['per_event']::app.price_unit[], 'extra'::app.service_tier, false, false, 5, '[]'::jsonb),
  ('cake', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_kg', 'per_item', 'per_event']::app.price_unit[], 'extra'::app.service_tier, false, true, 6, '[]'::jsonb),
  ('gifts', 'bonbonniere', 'Бонбоньерки для гостей', 'Mehmonlar uchun esdalik (bonbonyerka)', array['per_item']::app.price_unit[], 'base'::app.service_tier, true, false, 1, '[{"code":"name_print","name_ru":"Имена и дата на упаковке","name_uz":"Qadoqda ismlar va sana","unit":"per_item"}]'::jsonb),
  ('gifts', 'in_law_gift_set', 'Подарки сватам (набор)', 'Quda sovgʻalari (toʻplam)', array['per_set']::app.price_unit[], 'extra'::app.service_tier, true, false, 2, '[{"code":"special_packaging","name_ru":"Особая упаковка","name_uz":"Maxsus qadoq","unit":"per_set"}]'::jsonb),
  ('gifts', 'couple_gift_set', 'Подарочный набор для молодожёнов', 'Kelin-kuyov uchun sovgʻa toʻplami', array['per_set']::app.price_unit[], 'extra'::app.service_tier, true, false, 3, '[]'::jsonb),
  ('gifts', 'corporate_gifts', 'Корпоративные подарки', 'Korporativ sovgʻalar', array['per_item']::app.price_unit[], 'extra'::app.service_tier, true, false, 4, '[{"code":"logo","name_ru":"Логотип","name_uz":"Logotip","unit":"per_item"}]'::jsonb),
  ('gifts', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_item', 'per_set']::app.price_unit[], 'extra'::app.service_tier, false, true, 5, '[]'::jsonb),
  ('decor', 'stage_decor', 'Оформление тора (места молодожёнов)', 'Toʻr (kelin-kuyov joyi) bezagi', array['per_event']::app.price_unit[], 'base'::app.service_tier, true, false, 1, '[{"code":"flower_wall","name_ru":"Цветочная стена","name_uz":"Gul devor","unit":"per_event"},{"code":"lighting","name_ru":"Подсветка","name_uz":"Yoritish","unit":"per_event"}]'::jsonb),
  ('decor', 'full_hall_package', 'Оформление зала под ключ', 'Zalni toʻliq bezash', array['per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 2, '[]'::jsonb),
  ('decor', 'table_decor', 'Оформление столов', 'Stollarni bezash', array['per_table']::app.price_unit[], 'extra'::app.service_tier, true, false, 3, '[]'::jsonb),
  ('decor', 'entrance_arch', 'Входная арка, фотозона', 'Kirish arkasi, fotozona', array['per_item', 'per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 4, '[]'::jsonb),
  ('decor', 'lighting_effects', 'Свет и сценические эффекты', 'Yorugʻlik va sahna effektlari', array['per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 5, '[{"code":"smoke","name_ru":"Тяжёлый дым","name_uz":"Ogʻir tutun","unit":"per_event"},{"code":"confetti","name_ru":"Конфетти","name_uz":"Konfetti","unit":"per_event"}]'::jsonb),
  ('decor', 'morning_plov_decor', 'Оформление утреннего плова, фотихи', 'Nahorgi osh, fotiha bezagi', array['per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 6, '[]'::jsonb),
  ('decor', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_event', 'per_table', 'per_item']::app.price_unit[], 'extra'::app.service_tier, false, true, 7, '[]'::jsonb),
  ('food', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_guest', 'per_event']::app.price_unit[], 'extra'::app.service_tier, false, true, 1, '[]'::jsonb),
  ('restaurant', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_guest', 'per_event']::app.price_unit[], 'extra'::app.service_tier, false, true, 1, '[]'::jsonb),
  ('attire', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_item', 'per_event']::app.price_unit[], 'extra'::app.service_tier, false, true, 1, '[]'::jsonb),
  ('music', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_hour', 'per_event']::app.price_unit[], 'extra'::app.service_tier, false, true, 1, '[]'::jsonb),
  ('kids', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_hour', 'per_event']::app.price_unit[], 'extra'::app.service_tier, false, true, 1, '[]'::jsonb),
  ('zags', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_event']::app.price_unit[], 'extra'::app.service_tier, false, true, 1, '[]'::jsonb)
on conflict (category_code, code) do update set
  name_ru = excluded.name_ru, name_uz = excluded.name_uz, units = excluded.units,
  tier = excluded.tier, in_price_from = excluded.in_price_from, free_name = excluded.free_name,
  sort = excluded.sort, options = excluded.options, enabled = true;
-- categories-seed:end

-- ════════════════════════════════════════════════════════════════════════════
-- Карточка: поля витрины, ссылки на видео, одновременные заказы
-- ════════════════════════════════════════════════════════════════════════════

-- Ссылка на видео — только канонический вид YouTube или Instagram (normalizeVideoLink в
-- @bayramm/shared/categories); всё остальное база не примет
create function app.video_link_ok(p_link text) returns boolean
language sql immutable parallel safe set search_path = ''
as $$
  select p_link ~ '^https://www\.(youtube\.com/(watch\?v=|shorts/)[A-Za-z0-9_-]{11}|instagram\.com/(p|reel|tv)/[A-Za-z0-9_-]{5,40}/)$'
$$;

create function app.video_links_ok(p_links text[]) returns boolean
language sql immutable parallel safe set search_path = ''
as $$ select coalesce(bool_and(app.video_link_ok(l)), true) from unnest(p_links) l $$;

alter table app.listings
  add column attributes        jsonb not null default '{}'::jsonb,
  add column video_links       text[] not null default '{}',
  add column parallel_capacity smallint not null default 1,
  add constraint listings_attributes_object
    check (jsonb_typeof(attributes) = 'object' and pg_column_size(attributes) <= 32768),
  add constraint listings_video_links check (cardinality(video_links) <= 10 and app.video_links_ok(video_links)),
  add constraint listings_parallel_capacity check (parallel_capacity between 1 and 50),
  -- цену и вместимость требует app.listing_publish_blockers по категории: у кортежа,
  -- например, вместимости в гостях нет, а цена «от» — из услуг
  drop constraint listings_price_required,
  drop constraint listings_capacity_required;

comment on column app.listings.attributes is
  'Поля витрины категории (packages/shared/src/categories): структуру проверяет API';
comment on column app.listings.parallel_capacity is
  'Сколько заказов витрина берёт одновременно (режим занятости parts): экипажи, машины';
comment on column app.listings.price_from_uzs is
  'Цена «от»: самая низкая цена услуг, входящих в цену «от» (app.listing_price_from). Пишет только триггер';

-- Фильтры каталога по полям витрины (@>) — только опубликованные карточки
create index listings_attributes on app.listings using gin (attributes jsonb_path_ops) where status = 'active';

-- Поле витрины заполнено: не null, не пустая строка, не пустой список; текст на двух
-- языках — оба языка
create function app.attribute_present(p_value jsonb) returns boolean
language sql immutable parallel safe set search_path = ''
as $$
  select case jsonb_typeof(p_value)
    when 'string' then btrim(p_value #>> '{}') <> ''
    when 'array' then jsonb_array_length(p_value) > 0
    when 'object' then coalesce(btrim(p_value ->> 'ru'), '') <> '' and coalesce(btrim(p_value ->> 'uz'), '') <> ''
    when 'number' then true
    when 'boolean' then true
    else false
  end
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Услуги витрины
-- ════════════════════════════════════════════════════════════════════════════

-- Опции услуги: [{ id, code?, name_ru, name_uz, price_uzs, price_unit }], не больше 10.
-- id — UUID, его ставит API: на опцию ссылается заявка
create function app.service_options_ok(p_options jsonb) returns boolean
language sql immutable parallel safe set search_path = ''
as $$
  select jsonb_typeof(p_options) = 'array'
     and jsonb_array_length(p_options) <= 10
     and not exists (
       select 1 from jsonb_array_elements(p_options) o
       where jsonb_typeof(o) <> 'object'
          or exists (select 1 from jsonb_object_keys(o) k
                     where k not in ('id', 'code', 'name_ru', 'name_uz', 'price_uzs', 'price_unit'))
          or coalesce(o ->> 'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or (o ? 'code' and coalesce(o ->> 'code', '') !~ '^[a-z][a-z0-9_]{1,39}$')
          or jsonb_typeof(o -> 'name_ru') is distinct from 'string'
          or jsonb_typeof(o -> 'name_uz') is distinct from 'string'
          or length(btrim(o ->> 'name_ru')) not between 1 and 80
          or length(btrim(o ->> 'name_uz')) not between 1 and 80
          or jsonb_typeof(o -> 'price_uzs') is distinct from 'number'
          or (o ->> 'price_uzs') !~ '^[1-9][0-9]{0,10}$'
          or coalesce(o ->> 'price_unit', '') not in
             ('per_guest', 'per_event', 'per_hour', 'per_item', 'per_kg', 'per_set', 'per_table'))
$$;

-- Предложение правки активной услуги: те же столбцы, только изменённые
create function app.service_proposal_ok(p_proposal jsonb) returns boolean
language sql immutable parallel safe set search_path = ''
as $$
  select jsonb_typeof(p_proposal) = 'object'
     and p_proposal <> '{}'::jsonb
     and not exists (
       select 1 from jsonb_object_keys(p_proposal) k
       where k not in ('name_ru', 'name_uz', 'price_uzs', 'price_unit', 'min_qty', 'lead_days',
                       'includes_ru', 'includes_uz', 'options'))
     and (not p_proposal ? 'options' or app.service_options_ok(p_proposal -> 'options'))
     and (not p_proposal ? 'price_uzs' or (p_proposal ->> 'price_uzs') ~ '^[1-9][0-9]{0,10}$')
$$;

create table app.listing_services (
  id              uuid primary key default gen_random_uuid(),
  listing_id      uuid not null references app.listings on delete cascade,
  -- категория карточки (ставит триггер): тип услуги — из её каталога
  category_code   text not null,
  service_type    text not null,
  status          app.service_status not null default 'draft',
  -- название — только у «другой услуги» (free_name), у остальных — из каталога
  name_ru         text check (length(btrim(name_ru)) between 1 and 80),
  name_uz         text check (length(btrim(name_uz)) between 1 and 80),
  price_uzs       bigint not null check (price_uzs between 1 and 99999999999),
  price_unit      app.price_unit not null,
  min_qty         int check (min_qty between 1 and 100000),
  lead_days       smallint check (lead_days between 0 and 365),
  includes_ru     text check (length(includes_ru) <= 1000),
  includes_uz     text check (length(includes_uz) <= 1000),
  options         jsonb not null default '[]'::jsonb check (app.service_options_ok(options)),
  -- предложение правки активной услуги: клиент видит одобренное, пока решения нет
  proposal        jsonb check (proposal is null or app.service_proposal_ok(proposal)),
  proposal_at     timestamptz,
  proposal_by     uuid,
  submitted_at    timestamptz,
  submitted_by    uuid,
  -- последнее решение команды (по самой услуге или по предложению)
  decision        text check (decision in ('approved', 'declined')),
  decision_reason text check (length(btrim(decision_reason)) between 1 and 1000),
  decided_by      uuid references app.staff,
  decided_at      timestamptz,
  -- переходный: пакет v0.1, из которого услуга (зеркало listing_packages_sync)
  package_id      uuid unique,
  sort            smallint not null default 0 check (sort between 0 and 1000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (category_code, service_type) references app.service_types (category_code, code),
  check ((name_ru is null) = (name_uz is null)),
  check ((proposal is null) = (proposal_at is null)),
  check (decision is distinct from 'declined' or decision_reason is not null),
  check (decision_reason is null or decision = 'declined'),
  check (status <> 'rejected' or decision = 'declined')
);
create index listing_services_listing on app.listing_services (listing_id, sort);
-- очередь модерации: новые услуги и предложения правок
create index listing_services_queue on app.listing_services (coalesce(proposal_at, submitted_at))
  where status = 'review' or proposal is not null;

comment on table app.listing_services is
  'Услуги витрины: цена обязательна, клиент видит только active; правка активной — предложением (proposal)';

-- Может ли вендор вести услугу этого типа. Единственная точка будущей проверки тарифа
-- (уровень типа — app.service_types.tier): сейчас всегда да. Выдачу и порядок в каталоге
-- она не трогает и трогать не будет — правило «место не продаётся»
create function app.service_allowed(p_vendor uuid, p_category text, p_service_type text) returns boolean
language sql stable security definer set search_path = ''
as $$ select true $$;

comment on function app.service_allowed(uuid, text, text) is
  'Точка будущей проверки тарифа: может ли вендор вести услугу типа (категория, код). Сейчас всегда true';

-- Цена «от»: самая низкая цена активных услуг, входящих в цену «от»; нет таких — любых
-- активных. Пока карточка не опубликована, считаются и услуги на проверке
create function app.listing_price_from(p_listing uuid, p_status app.listing_status)
returns table (price bigint, unit app.price_unit)
language sql stable security definer set search_path = ''
as $$
  select s.price_uzs, s.price_unit
  from app.listing_services s
  join app.service_types t on t.category_code = s.category_code and t.code = s.service_type
  where s.listing_id = p_listing
    and (s.status = 'active' or (p_status <> 'active' and s.status = 'review'))
  order by t.in_price_from desc, s.price_uzs, s.sort, s.id
  limit 1
$$;

-- Пересчитать цену «от» карточки; изменилась — UPDATE (его триггер считает то же самое
-- и проверяет готовность опубликованной карточки)
create function app.listing_refresh_price(p_listing uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing app.listings;
  v_price   bigint;
  v_unit    app.price_unit;
begin
  select l.* into v_listing from app.listings l where l.id = p_listing for update;
  if not found then
    return;
  end if;
  select f.price, f.unit into v_price, v_unit from app.listing_price_from(p_listing, v_listing.status) f;
  if (v_price, coalesce(v_unit, v_listing.price_unit))
     is distinct from (v_listing.price_from_uzs, v_listing.price_unit) then
    update app.listings set price_from_uzs = v_price where id = p_listing;
  end if;
end $$;

-- Кто что делает с услугами. Решает (active, rejected, решение по предложению) — тот,
-- кто решает по модерации: администратор, модератор, система. Партнёр — после отправки
-- карточки на проверку — и менеджер у опубликованной карточки меняют активную услугу
-- только предложением; снять её с витрины (paused) могут, вернуть — через проверку
create function app.listing_services_guard() returns trigger
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
    if (new.id, new.listing_id, new.category_code, new.service_type, new.created_at, new.package_id)
       is distinct from (old.id, old.listing_id, old.category_code, old.service_type, old.created_at, old.package_id) then
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

create trigger listing_services_guard before insert or update or delete on app.listing_services
  for each row execute function app.listing_services_guard();

-- После правки услуг: пересчитать цену «от»; опубликованная карточка и карточка на
-- проверке не остаются без цены и без обязательных услуг категории
create function app.listing_services_keep_ready() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing  app.listings;
  v_blockers text[];
begin
  perform app.listing_refresh_price(coalesce(new.listing_id, old.listing_id));
  select l.* into v_listing from app.listings l where l.id = coalesce(new.listing_id, old.listing_id);
  if found and v_listing.status in ('review', 'active') then
    v_blockers := app.listing_publish_blockers(v_listing, v_listing.status);
    if 'price' = any (v_blockers) or 'packages' = any (v_blockers) then
      raise exception 'publish_blocked' using errcode = 'BR004',
        detail = array_to_string(array(select b from unnest(v_blockers) b where b in ('price', 'packages')), ',');
    end if;
  end if;
  return null;
end $$;
create trigger listing_services_keep_ready after insert or update or delete on app.listing_services
  for each row execute function app.listing_services_keep_ready();

-- ── оповещения об услугах ───────────────────────────────────────────────────

-- Владельцам кабинета вендора, привязавшим Telegram (карточка — дело владельца)
create function app.enqueue_vendor_owner_notice(p_vendor uuid, p_kind text, p_payload jsonb, p_event text)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  insert into app.outbox (kind, recipient_kind, recipient_id, payload, dedupe_key)
  select p_kind, 'vendor_user', u.id, p_payload, p_kind || ':' || p_event || ':' || u.id
  from app.vendor_users u
  join pii.vendor_user_profiles p on p.vendor_user_id = u.id
  where u.vendor_id = p_vendor and u.role = 'owner' and u.disabled_at is null and u.tg_linked_at is not null
    and p.telegram_chat_id is not null
  on conflict (dedupe_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Новая услуга или предложение правки у опубликованной карточки от того, кто сам не
-- решает (партнёр, менеджер), — команде, не чаще раза в час на карточку. Решение по
-- услуге опубликованной карточки — владельцам кабинета. В payload — только id
create function app.listing_services_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing app.listings;
begin
  select l.* into v_listing from app.listings l where l.id = new.listing_id;
  if not found or v_listing.status <> 'active' then
    return null;
  end if;
  if app.actor_proposes()
     and ((new.status = 'review' and (tg_op = 'INSERT' or old.status is distinct from 'review'))
          or (new.proposal is not null and (tg_op = 'INSERT' or new.proposal_at is distinct from old.proposal_at))) then
    perform app.enqueue_staff_alert('ops.service_submitted', array['admin', 'moderator']::app.staff_role[],
      jsonb_build_object('listing_id', new.listing_id),
      new.listing_id::text || ':' || to_char(now() at time zone 'Asia/Tashkent', 'YYYY-MM-DD"T"HH24'));
  end if;
  if tg_op = 'UPDATE' and new.decided_at is not null and new.decided_at is distinct from old.decided_at
     and app.effective_actor() in ('staff', 'system') then
    perform app.enqueue_vendor_owner_notice(v_listing.vendor_id, 'vendor.service_decided',
      jsonb_build_object('service_id', new.id, 'decision', new.decision),
      new.id::text || ':' || extract(epoch from new.decided_at)::bigint::text);
  end if;
  return null;
end $$;
create trigger listing_services_notify after insert or update on app.listing_services
  for each row execute function app.listing_services_notify();

create trigger audit_staff after insert or update or delete on app.listing_services
  for each row execute function app.audit_staff_change('listing', 'listing_id', 'listing_service', 'id');

-- ════════════════════════════════════════════════════════════════════════════
-- Готовность к публикации — по категории
-- ════════════════════════════════════════════════════════════════════════════

-- Чего не хватает для перехода в review/active (коды — PublishBlocker в
-- @bayramm/shared/api/staff). Для review услуги и фото достаточно отправленных на
-- проверку, для active — одобренных
create or replace function app.listing_publish_blockers(p_listing app.listings, p_target app.listing_status)
returns text[]
language sql stable security definer set search_path = ''
as $$
  select array_remove(array[
    case when not exists (select 1 from app.listing_services s
                          where s.listing_id = p_listing.id
                            and (s.status = 'active' or (p_target = 'review' and s.status = 'review')))
         then 'price' end,
    case when 'guest_capacity' = any (c.required_fields) and p_listing.cap_max is null then 'capacity' end,
    case when 'district' = any (c.required_fields) and p_listing.district_code is null then 'district' end,
    case when coalesce(btrim(p_listing.description_ru), '') = ''
           or coalesce(btrim(p_listing.description_uz), '') = '' then 'descriptions' end,
    -- при выносе pii в отдельную БД эта проверка переезжает в API
    case when not exists (select 1 from pii.listing_contacts ct where ct.listing_id = p_listing.id)
         then 'phone' end,
    case when exists (select 1 from unnest(c.required_services) rs(code)
                      where not exists (select 1 from app.listing_services s
                                        where s.listing_id = p_listing.id and s.service_type = rs.code
                                          and (s.status = 'active' or (p_target = 'review' and s.status = 'review'))))
         then 'packages' end,
    case when exists (select 1 from unnest(c.required_attributes) ra(key)
                      where not coalesce(app.attribute_present(p_listing.attributes -> ra.key), false))
         then 'attributes' end,
    case when (select count(*) from app.photos p
               where p.listing_id = p_listing.id and p.deleted_at is null and p.status = 'ready'
                 and (p_target = 'review' or p.moderation = 'approved'))
              < greatest(3, c.min_photos, coalesce(app.setting_int('min_photos'), 3))
         then 'photos' end,
    case when p_target = 'active' and v.contract_signed_at is null then 'contract' end,
    case when p_target = 'active' and v.stir_verified_at is null then 'stir' end,
    case when p_target = 'active' and v.contacts_confirmed_at is null then 'contacts' end,
    case when p_target = 'active' and v.pd_consent_signed_at is null then 'pd_consent' end
  ]::text[], null)
  from app.vendor_accounts v, app.categories c
  where v.id = p_listing.vendor_id and c.code = p_listing.category_code
$$;

-- ── карточка: создание ──────────────────────────────────────────────────────
-- Как в 20260928120100_core.sql, плюс: цены «от» без услуг нет, ссылок на видео — не
-- больше, чем разрешает категория
create or replace function app.listings_before_insert() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.status not in ('lead', 'draft') then
    raise exception 'illegal_transition' using errcode = 'BR002',
      detail = format('листинг создаётся в статусе lead или draft, а не %s', new.status);
  end if;
  if app.actor_kind() in ('vendor_user', 'client') and new.status <> 'draft' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if cardinality(new.video_links) > coalesce(
       (select c.max_video_links from app.categories c where c.code = new.category_code), 0) then
    raise exception 'invalid_input' using errcode = '23514', detail = 'video_links';
  end if;
  new.price_from_uzs := null;
  new.version := 1;
  new.submitted_at := null;
  new.published_at := null;
  new.status_changed_at := now();
  new.status_changed_by := app.actor_id();
  new.created_at := now();
  new.updated_at := now();
  return new;
end $$;

-- ── карточка: правка ────────────────────────────────────────────────────────
-- Как в 20261001010000_cabinet_integrity.sql, плюс:
--   · цена «от» — всегда из услуг (app.listing_price_from): запись в столбцы цены не
--     меняет ничего, поэтому цена больше не «модерируемое поле» — модерируются услуги;
--   · поля витрины и ссылки на видео у партнёра — как название и описания: после
--     отправки на проверку — только правкой (listing_revisions);
--   · категорию меняет только сотрудник (система) и только пока по витрине нет заявок и
--     услуг (app.staff_set_listing_category сначала убирает услуги); фото с людьми не
--     переходят в категорию, где людей на фото быть не должно
create or replace function app.listings_before_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor     app.actor_kind := app.effective_actor();
  v_move      text;
  v_blockers  text[];
  v_moderated boolean;
  v_category  app.categories;
  v_price     bigint;
  v_unit      app.price_unit;
begin
  if new.id <> old.id or new.vendor_id <> old.vendor_id or new.created_at <> old.created_at then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;

  select c.* into v_category from app.categories c where c.code = new.category_code;
  if new.category_code <> old.category_code then
    if not app.is_privileged() then
      raise exception 'immutable_column' using errcode = 'BR006', detail = 'категорию меняет сотрудник';
    end if;
    if exists (select 1 from app.requests r where r.listing_id = new.id) then
      raise exception 'category_locked' using errcode = 'BR026', detail = 'requests';
    end if;
    if exists (select 1 from app.listing_services s where s.listing_id = new.id) then
      raise exception 'category_locked' using errcode = 'BR026', detail = 'services';
    end if;
    if v_category.photo_policy = 'no_people' and exists (
         select 1 from app.photos p where p.listing_id = new.id and p.deleted_at is null and not p.no_faces_ack) then
      raise exception 'photo_ack_required' using errcode = 'BR028', detail = 'photos';
    end if;
  end if;
  if cardinality(new.video_links) > coalesce(v_category.max_video_links, 0)
     and new.video_links is distinct from old.video_links then
    raise exception 'invalid_input' using errcode = '23514', detail = 'video_links';
  end if;

  -- Цена «от» — из услуг
  select f.price, f.unit into v_price, v_unit from app.listing_price_from(new.id, new.status) f;
  new.price_from_uzs := v_price;
  new.price_unit := coalesce(v_unit, old.price_unit);

  v_moderated := new.name is distinct from old.name
                 or new.description_ru is distinct from old.description_ru
                 or new.description_uz is distinct from old.description_uz;

  -- После отправки на проверку партнёр меняет название, описания, поля витрины и ссылки
  -- на видео только через listing_revisions: клиент видит одобренную версию
  if v_actor = 'vendor_user' and old.status in ('review', 'active', 'suspended')
     and (v_moderated or new.attributes is distinct from old.attributes
          or new.video_links is distinct from old.video_links) then
    raise exception 'moderated_field_requires_revision' using errcode = 'BR005';
  end if;
  -- Опубликованную карточку менеджер меняет так же — правкой, решает модератор:
  -- кто заполняет карточку, тот её не публикует
  if v_actor = 'staff' and old.status = 'active' and v_moderated and not app.staff_can_moderate() then
    raise exception 'moderated_field_requires_revision' using errcode = 'BR005',
      detail = 'правку опубликованной карточки решает модератор';
  end if;

  if new.status is distinct from old.status then
    v_move := old.status::text || '>' || new.status::text;
    if v_move <> all (array[
         'lead>draft', 'draft>review', 'review>draft', 'review>active',
         'active>suspended', 'suspended>active',
         'lead>rejected', 'draft>rejected', 'review>rejected', 'rejected>draft']) then
      raise exception 'illegal_transition' using errcode = 'BR002', detail = v_move;
    end if;
    if v_actor = 'client'
       or (v_actor = 'vendor_user' and v_move <> all (array['draft>review', 'review>draft', 'rejected>draft'])) then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = v_move;
    end if;
    if new.status not in ('suspended', 'rejected') then
      new.status_reason := null;
    end if;
    new.status_changed_at := now();
    new.status_changed_by := app.actor_id();
    if new.status = 'review' then
      new.submitted_at := now();
    elsif new.status = 'active' then
      new.published_at := coalesce(old.published_at, now());
    end if;
  end if;

  -- Защита публикации: на review/active — только если нечего блокировать
  if new.status in ('review', 'active') and (
       new.status is distinct from old.status
       or (new.price_from_uzs, new.cap_max, new.district_code, new.description_ru, new.description_uz, new.attributes)
          is distinct from
          (old.price_from_uzs, old.cap_max, old.district_code, old.description_ru, old.description_uz, old.attributes)) then
    v_blockers := app.listing_publish_blockers(new, new.status);
    if cardinality(v_blockers) > 0 then
      raise exception 'publish_blocked' using errcode = 'BR004', detail = array_to_string(v_blockers, ',');
    end if;
  end if;

  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Витрины вендора в нескольких категориях
-- ════════════════════════════════════════════════════════════════════════════

-- Новая витрина существующему вендору — в другой (или той же) категории. Только
-- сотрудник (права проверяет API: listings.write); черновиком, с записью в журнал.
-- Адрес страницы подбирает API (свободный слаг)
create function app.staff_add_listing(p_vendor uuid, p_category text, p_name text, p_slug text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if app.actor_kind() is distinct from 'staff' or app.current_staff_role() is null then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if not exists (select 1 from app.vendor_accounts v where v.id = p_vendor) then
    raise exception 'not_found' using errcode = '42501';
  end if;
  if not exists (select 1 from app.categories c where c.code = p_category and c.enabled) then
    raise exception 'invalid_input' using errcode = '23514', detail = 'categoryCode';
  end if;
  insert into app.listings (vendor_id, slug, category_code, status, name)
  values (p_vendor, p_slug, p_category, 'draft', p_name)
  returning id into v_id;
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('vendor.listing_add', 'vendor', p_vendor::text,
          jsonb_build_object('listing_id', v_id, 'category', p_category), 'admin');
  return v_id;
end $$;

-- Категория витрины — только пока по ней нет заявок. Услуги прежней категории
-- удаляются (у опубликованной карточки — нельзя: она осталась бы без цены, сначала
-- приостановить), поля витрины очищаются, ссылки на видео — если новая категория их
-- не допускает. Версию карточки (оптимистичная блокировка) сверяет API под блокировкой строки
create function app.staff_set_listing_category(p_listing uuid, p_category text)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing  app.listings;
  v_category app.categories;
  v_version  int;
begin
  if app.actor_kind() is distinct from 'staff' or app.current_staff_role() is null then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  select l.* into v_listing from app.listings l where l.id = p_listing for update;
  if not found then
    raise exception 'not_found' using errcode = '42501';
  end if;
  select c.* into v_category from app.categories c where c.code = p_category and c.enabled;
  if not found then
    raise exception 'invalid_input' using errcode = '23514', detail = 'categoryCode';
  end if;
  if v_listing.category_code = p_category then
    return v_listing.version;
  end if;
  if exists (select 1 from app.requests r where r.listing_id = p_listing) then
    raise exception 'category_locked' using errcode = 'BR026', detail = 'requests';
  end if;
  delete from app.listing_services s where s.listing_id = p_listing;
  update app.listings
  set category_code = p_category,
      attributes = '{}'::jsonb,
      video_links = video_links[1:v_category.max_video_links]
  where id = p_listing
  returning version into v_version;
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('listing.category_change', 'listing', p_listing::text,
          jsonb_build_object('from', v_listing.category_code, 'to', p_category), 'admin');
  return v_version;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Фото: правило категории
-- ════════════════════════════════════════════════════════════════════════════

alter table app.photos
  add column people_consent_ack boolean not null default false,
  alter column no_faces_ack set default false,
  drop constraint photos_no_faces_ack_check,
  add constraint photos_ack check (no_faces_ack or people_consent_ack);

comment on column app.photos.people_consent_ack is
  'Загрузивший подтвердил согласие людей на фото — только у категорий с правилом portfolio';

-- no_people — «без лиц» обязательно; portfolio — «без лиц» или согласие людей на фото
create function app.photos_policy_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_policy app.photo_policy;
begin
  select c.photo_policy into v_policy
  from app.listings l join app.categories c on c.code = l.category_code
  where l.id = new.listing_id;
  if new.people_consent_ack and v_policy is distinct from 'portfolio' then
    raise exception 'photo_ack_required' using errcode = 'BR028', detail = 'no_faces';
  end if;
  if not new.no_faces_ack and not new.people_consent_ack then
    raise exception 'photo_ack_required' using errcode = 'BR028',
      detail = case when v_policy = 'portfolio' then 'people_consent' else 'no_faces' end;
  end if;
  return new;
end $$;
create trigger photos_policy_guard before insert on app.photos
  for each row execute function app.photos_policy_guard();

-- Заявка: поля категории и часть дня (их пишет API при подаче, дальше не меняются)
alter table app.requests
  alter column guests drop not null,
  add column details jsonb not null default '{}'::jsonb,
  add column day_part app.day_part,
  add constraint requests_details_object
    check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 16384);
-- договорённости по части дня — для занятости (app.listing_busy)
create index requests_listing_deals on app.requests (listing_id, event_date, day_part) where status = 'deal';

comment on column app.requests.details is
  'Поля формы заявки категории (packages/shared/src/categories): без ПДн и свободного текста, проверяет API';
comment on column app.requests.day_part is
  'Часть дня (режим занятости parts): API выводит её из времени начала в details';

-- ════════════════════════════════════════════════════════════════════════════
-- Занятость по частям дня
-- ════════════════════════════════════════════════════════════════════════════

-- Отметка «часть дня занята» (режим parts). Весь день — по-прежнему app.availability
create table app.availability_parts (
  listing_id uuid not null references app.listings on delete cascade,
  day        date not null,
  part       app.day_part not null,
  source     text not null default 'vendor' check (source in ('vendor', 'request_decline', 'staff')),
  request_id uuid references app.requests,
  created_by uuid default app.actor_id(),
  created_at timestamptz not null default now(),
  primary key (listing_id, day, part)
);
create index availability_parts_day on app.availability_parts (day, listing_id);

comment on table app.availability_parts is
  'Занятые части дня (утро, день, вечер) витрин с режимом занятости parts; весь день — app.availability';

-- Как app.availability_guard: прошлое не меняется; сотрудник закрыл — вендор не снимает;
-- отказ «занято» — ровно часть дня и дата заявки. Части дня — только у режима parts
create function app.availability_parts_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor app.actor_kind := app.effective_actor();
  v_today date := app.tashkent_today();
begin
  if tg_op = 'DELETE' then
    if old.day < v_today then
      -- удаление вместе с листингом (каскад) — не правка календаря
      if not exists (select 1 from app.listings l where l.id = old.listing_id) then
        return old;
      end if;
      raise exception 'date_out_of_range' using errcode = 'BR024', detail = 'прошедший день не меняется';
    end if;
    if v_actor = 'vendor_user' and old.source = 'staff' then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'часть дня закрыта сотрудником';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    raise exception 'immutable_column' using errcode = 'BR006', detail = 'отметку снимают и ставят заново';
  end if;
  if new.day < v_today then
    raise exception 'date_out_of_range' using errcode = 'BR024', detail = 'прошедший день не меняется';
  end if;
  if not exists (select 1 from app.listings l join app.categories c on c.code = l.category_code
                 where l.id = new.listing_id and c.availability_mode = 'parts') then
    raise exception 'invalid_input' using errcode = '23514', detail = 'части дня — только у режима parts';
  end if;
  new.created_by := app.actor_id();
  new.created_at := now();
  if v_actor = 'vendor_user' and new.source = 'staff' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'source staff ставит только сотрудник';
  end if;
  if new.source = 'request_decline' and not exists (
       select 1 from app.requests r
       where r.id = new.request_id and r.listing_id = new.listing_id and r.event_date = new.day
         and r.day_part = new.part and r.status = 'declined' and r.decline_reason = 'busy') then
    raise exception 'invalid_input' using errcode = '23514',
      detail = 'request_decline — только часть дня и дата заявки этого листинга с отказом «занято»';
  end if;
  return new;
end $$;
create trigger availability_parts_guard before insert or update or delete on app.availability_parts
  for each row execute function app.availability_parts_guard();
-- версия календаря — общая с app.availability
create trigger availability_bump_version after insert or update or delete on app.availability_parts
  for each row execute function app.availability_bump_version();
create trigger audit_staff after insert or delete on app.availability_parts
  for each row execute function app.audit_staff_change('listing', 'listing_id', 'availability_part', 'day');

-- Сколько заказов одновременно — часть календаря: смена поднимает его версию
create function app.listings_capacity_bump() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into app.availability_versions as v (listing_id, version)
  values (new.id, 1)
  on conflict (listing_id) do update set version = v.version + 1, updated_at = now();
  return null;
end $$;
create trigger listings_capacity_bump after update of parallel_capacity on app.listings
  for each row when (new.parallel_capacity is distinct from old.parallel_capacity)
  execute function app.listings_capacity_bump();

-- Сколько заказов одновременно — из кабинета (владелец и сотрудник площадки ведут
-- календарь) и из панели, от версии календаря, которую видел человек
create function app.listing_set_parallel_capacity(p_listing uuid, p_capacity int, p_version int) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_version int;
begin
  if p_capacity is null or p_capacity not between 1 and 50 then
    raise exception 'invalid_input' using errcode = '22023', detail = 'parallelCapacity';
  end if;
  perform app.availability_lock(p_listing, p_version);
  update app.listings set parallel_capacity = p_capacity
  where id = p_listing and parallel_capacity is distinct from p_capacity;
  select v.version into v_version from app.availability_versions v where v.listing_id = p_listing;
  return coalesce(v_version, 0);
end $$;

-- Занятость витрины по дням [p_from, p_to): дни, где что-то занято, и что именно —
-- {all} (весь день: отметка на день или заняты все части) или занятые части дня.
-- Часть занята — отметка вендора или сотрудника, или договорённостей (заявки deal)
-- на неё не меньше parallel_capacity. Без ПДн: только даты и части. Опубликованная
-- витрина — всем (публичный календарь), остальные — сотруднику и вендору-владельцу
create function app.listing_busy(p_listing uuid, p_from date, p_to date)
returns table (day date, parts text[])
language sql stable security definer set search_path = ''
as $$
  with l as (
    select l.id, l.parallel_capacity, c.availability_mode as mode
    from app.listings l
    join app.categories c on c.code = l.category_code
    where l.id = p_listing and (l.status = 'active' or app.is_privileged() or app.owns_listing(l.id))
      and p_to <= p_from + 400
  ),
  whole as (
    select a.day from app.availability a join l on a.listing_id = l.id
    where a.day >= p_from and a.day < p_to
  ),
  part_full as (
    select a.day, a.part from app.availability_parts a join l on a.listing_id = l.id
    where l.mode = 'parts' and a.day >= p_from and a.day < p_to
    union
    select r.event_date, r.day_part from app.requests r join l on r.listing_id = l.id
    where l.mode = 'parts' and r.status = 'deal' and r.day_part is not null
      and r.event_date >= p_from and r.event_date < p_to
    group by r.event_date, r.day_part, l.parallel_capacity
    having count(*) >= l.parallel_capacity
  ),
  by_day as (
    select f.day, array_agg(f.part order by f.part) as parts from part_full f group by f.day
  )
  select w.day, array['all']::text[] from whole w
  union all
  select d.day, case when cardinality(d.parts) = 3 then array['all']::text[] else d.parts::text[] end
  from by_day d
  where not exists (select 1 from whole w where w.day = d.day)
  order by 1
$$;

-- Загрузка витрины в день: free | partial (заняты не все части) | busy
create function app.listing_day_load(p_listing uuid, p_day date) returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce((select case when b.parts = array['all']::text[] then 'busy' else 'partial' end
                   from app.listing_busy(p_listing, p_day, p_day + 1) b), 'free')
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Заявки: поля категории и часть дня
-- ════════════════════════════════════════════════════════════════════════════


-- Часть дня — у заявок режима parts обязательна, у остальных её нет
create function app.requests_category_rules() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_mode app.availability_mode;
begin
  select c.availability_mode into v_mode
  from app.listings l join app.categories c on c.code = l.category_code
  where l.id = new.listing_id;
  if (v_mode = 'parts') <> (new.day_part is not null) then
    raise exception 'invalid_input' using errcode = '23514', detail = 'day_part';
  end if;
  return new;
end $$;
create trigger requests_category_rules before insert on app.requests
  for each row execute function app.requests_category_rules();

-- Как в 20260928120100_core.sql, плюс неизменные details и day_part
create or replace function app.requests_before_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor app.actor_kind := app.effective_actor();
begin
  if (new.id, new.public_no, new.client_id, new.listing_id, new.vendor_id, new.consent_id, new.occasion_code,
      new.event_date, new.guests, new.budget_min_uzs, new.budget_max_uzs, new.source, new.sla_due_at, new.created_at,
      new.details, new.day_part)
     is distinct from
     (old.id, old.public_no, old.client_id, old.listing_id, old.vendor_id, old.consent_id, old.occasion_code,
      old.event_date, old.guests, old.budget_min_uzs, old.budget_max_uzs, old.source, old.sla_due_at, old.created_at,
      old.details, old.day_part) then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;

  -- этапы SLA двигает только система и только вперёд
  if (new.sla_stage, new.sla_breached_at) is distinct from (old.sla_stage, old.sla_breached_at) then
    if v_actor <> 'system' then
      raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'sla';
    end if;
    if new.sla_stage < old.sla_stage then
      raise exception 'illegal_transition' using errcode = 'BR002', detail = 'sla_stage';
    end if;
  end if;

  if new.status is distinct from old.status then
    if not exists (select 1 from app.request_transitions t
                   where t.from_status = old.status and t.to_status = new.status and t.actor = v_actor) then
      raise exception 'illegal_transition' using errcode = 'BR002',
        detail = format('%s -> %s (%s)', old.status, new.status, v_actor);
    end if;
    if new.status = 'viewed' and old.first_viewed_at is null then
      new.first_viewed_at := now();
    end if;
    if new.status in ('contacted', 'declined', 'deal') and old.first_response_at is null then
      new.first_response_at := now();
      new.first_response_by := v_actor;
    end if;
    if new.status <> 'declined' then
      new.decline_reason := null;
      new.decline_note := null;
    end if;
  elsif (new.decline_reason, new.decline_note) is distinct from (old.decline_reason, old.decline_note) then
    raise exception 'immutable_column' using errcode = 'BR006', detail = 'причина меняется только вместе со статусом';
  end if;

  if (new.first_viewed_at, new.first_response_at, new.first_response_by)
     is distinct from (old.first_viewed_at, old.first_response_at, old.first_response_by)
     and new.status is not distinct from old.status then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;

  new.updated_at := now();
  return new;
end $$;

-- Как в 20261001010000_cabinet_integrity.sql; у заявки с частью дня отказ «занято»
-- занимает эту часть дня, а не весь день
create or replace function app.requests_decline_busy_day() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.status = 'declined' and new.status <> 'declined' then
    delete from app.availability a
    where a.request_id = new.id and a.source = 'request_decline' and a.day >= app.tashkent_today();
    delete from app.availability_parts a
    where a.request_id = new.id and a.source = 'request_decline' and a.day >= app.tashkent_today();
  end if;
  if new.status = 'declined' and new.decline_reason = 'busy'
     and old.status is distinct from 'declined' and new.event_date >= app.tashkent_today() then
    if new.day_part is not null then
      insert into app.availability_parts (listing_id, day, part, source, request_id)
      values (new.listing_id, new.event_date, new.day_part, 'request_decline', new.id)
      on conflict (listing_id, day, part) do nothing;
    else
      insert into app.availability (listing_id, day, source, request_id)
      values (new.listing_id, new.event_date, 'request_decline', new.id)
      on conflict (listing_id, day) do nothing;
    end if;
  end if;
  return null;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Правки карточки: поля витрины и ссылки на видео
-- ════════════════════════════════════════════════════════════════════════════

-- Как в 20260928120100_core.sql, плюс attributes и video_links. price_from_uzs,
-- price_unit и packages остаются, пока панель и кабинет v0.1 их шлют (цена «от»
-- теперь из услуг, пакеты зеркалятся в услуги зала)
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

-- ════════════════════════════════════════════════════════════════════════════
-- Переход залов на услуги
-- ════════════════════════════════════════════════════════════════════════════

-- Пакеты v0.1, которые пишет прежний код (панель, правки кабинета), — в услуги зала:
-- будни → banquet_weekday, выходные → banquet_weekend, произвольный → other с его
-- названием. Услуги зеркала — активные: пакеты прежний код пишет по своим правилам
-- (у опубликованной карточки — только тот, кто решает, — listing_packages_guard)
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

-- Данные: пакеты залов — в услуги (одним запросом: проверки готовности идут после
-- вставки всех строк). Прежняя цена «от» — в журнал действий: дальше её считают услуги
insert into app.audit_log (actor_kind, action, object_type, object_id, detail, source)
select 'system', 'listing.price_from_snapshot', 'listing', l.id::text,
       jsonb_build_object('price_from_uzs', l.price_from_uzs, 'price_unit', l.price_unit), 'system'
from app.listings l
where l.price_from_uzs is not null;

-- Зеркало пакетов, без проверок готовности на каждую строку: цену «от» пересчитываем
-- ниже одним запросом, без защиты публикации — карточки уже опубликованы по правилам v0.1
select set_config('app.services_sync', 'on', true);
alter table app.listing_services disable trigger listing_services_keep_ready;
insert into app.listing_services
  (listing_id, category_code, service_type, status, name_ru, name_uz, price_uzs, price_unit, sort, package_id,
   decision, decided_at, created_at)
select k.listing_id, 'hall',
       case k.kind when 'weekday' then 'banquet_weekday' when 'weekend' then 'banquet_weekend' else 'other' end,
       'active',
       case when k.kind = 'custom' then k.name_ru end,
       case when k.kind = 'custom' then k.name_uz end,
       k.price_uzs, k.price_unit, k.sort, k.id, 'approved', now(), k.created_at
from app.listing_packages k
join app.listings l on l.id = k.listing_id
where l.category_code = 'hall';
alter table app.listing_services enable trigger listing_services_keep_ready;
select set_config('app.services_sync', '', true);

alter table app.listings disable trigger listings_before_update;
update app.listings l
set price_from_uzs = (select f.price from app.listing_price_from(l.id, l.status) f),
    price_unit = coalesce((select f.unit from app.listing_price_from(l.id, l.status) f), l.price_unit);
alter table app.listings enable trigger listings_before_update;

create trigger listing_packages_sync after insert or update or delete on app.listing_packages
  for each row execute function app.listing_packages_sync();

-- ════════════════════════════════════════════════════════════════════════════
-- Уборка демо-данных staging: как в 20261001010000_cabinet_integrity.sql, плюс
-- части дня и оповещения о новых услугах демо-карточек (услуги уходят с карточкой)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function app.demo_purge() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_vendors  uuid[];
  v_listings uuid[];
  v_requests uuid[];
  v_users    uuid[];
  v_photos   int;
  v_result   jsonb;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;

  -- Демо-вендоры блокируются: параллельная правка из панели дождётся уборки
  select coalesce(array_agg(v.id), '{}') into v_vendors
  from (select v.id from app.vendor_accounts v
        where v.id::text like '00000000-0000-4000-8000-de%'
        for update) v;
  if cardinality(v_vendors) = 0 then
    return jsonb_build_object('vendors', 0, 'listings', 0, 'photos', 0, 'requests', 0, 'vendorUsers', 0);
  end if;

  select coalesce(array_agg(l.id), '{}') into v_listings
  from app.listings l where l.vendor_id = any (v_vendors);
  select coalesce(array_agg(r.id), '{}') into v_requests
  from app.requests r where r.vendor_id = any (v_vendors) or r.listing_id = any (v_listings);
  select coalesce(array_agg(u.id), '{}') into v_users
  from app.vendor_users u where u.vendor_id = any (v_vendors);
  select count(*) into v_photos from app.photos p where p.listing_id = any (v_listings);

  alter table app.request_status_log disable trigger request_status_log_append_only;
  alter table app.request_notes disable trigger request_notes_append_only;
  alter table app.consents disable trigger consents_append_only;
  alter table app.listing_status_log disable trigger listing_status_log_append_only;
  alter table app.availability disable trigger availability_guard;
  alter table app.availability_parts disable trigger availability_parts_guard;

  -- Уведомления: по заявкам, пользователям кабинета, правкам, фото и услугам демо-карточек
  delete from app.outbox o
  where o.request_id = any (v_requests)
     or (o.recipient_kind = 'vendor_user' and o.recipient_id = any (v_users))
     or (o.kind = 'ops.revision_submitted' and o.payload ->> 'revision_id' in (
           select r.id::text from app.listing_revisions r where r.listing_id = any (v_listings)))
     or (o.kind in ('ops.photos_submitted', 'ops.service_submitted')
         and o.payload ->> 'listing_id' = any (v_listings::text[]));
  -- Занятость ссылается на заявки (отказ «занято»); прошедшие дни уходят тоже — это
  -- уборка демо-карточки целиком, а не правка календаря
  delete from app.availability a where a.listing_id = any (v_listings);
  delete from app.availability_parts a where a.listing_id = any (v_listings);
  delete from app.request_notes n where n.request_id = any (v_requests);
  delete from app.request_status_log s where s.request_id = any (v_requests);
  delete from app.requests r where r.id = any (v_requests);
  delete from app.consents c where c.scope_listing_id = any (v_listings);
  delete from app.listing_status_log s where s.listing_id = any (v_listings);
  delete from app.sessions s where s.vendor_user_id = any (v_users);
  delete from app.vendor_users u where u.id = any (v_users);
  delete from app.listings l where l.id = any (v_listings);
  delete from app.vendor_accounts v where v.id = any (v_vendors);

  alter table app.request_status_log enable trigger request_status_log_append_only;
  alter table app.request_notes enable trigger request_notes_append_only;
  alter table app.consents enable trigger consents_append_only;
  alter table app.listing_status_log enable trigger listing_status_log_append_only;
  alter table app.availability enable trigger availability_guard;
  alter table app.availability_parts enable trigger availability_parts_guard;

  v_result := jsonb_build_object(
    'vendors', cardinality(v_vendors),
    'listings', cardinality(v_listings),
    'photos', v_photos,
    'requests', cardinality(v_requests),
    'vendorUsers', cardinality(v_users));
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('demo.reset', 'demo', 'staging', v_result, 'system');
  return v_result;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- RLS и права
-- ════════════════════════════════════════════════════════════════════════════

alter table app.service_types enable row level security;
alter table app.listing_services enable row level security;
alter table app.availability_parts enable row level security;

-- каталог услуг публичен, меняется миграциями
create policy service_types_read on app.service_types for select to bayramm_api using (true);
grant select on app.service_types to bayramm_api;

-- услуги: активные у опубликованной карточки видят все; свои — вендор; меняет владелец
-- кабинета или сотрудник (что именно — listing_services_guard)
create policy listing_services_read on app.listing_services for select to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id)
         or (status = 'active' and app.listing_is_public(listing_id)));
create policy listing_services_insert on app.listing_services for insert to bayramm_api
  with check ((select app.is_privileged()) or app.edits_listing(listing_id));
create policy listing_services_update on app.listing_services for update to bayramm_api
  using ((select app.is_privileged()) or app.edits_listing(listing_id))
  with check ((select app.is_privileged()) or app.edits_listing(listing_id));
create policy listing_services_delete on app.listing_services for delete to bayramm_api
  using ((select app.is_privileged()) or app.edits_listing(listing_id));
grant select, insert, delete on app.listing_services to bayramm_api;
grant update (status, name_ru, name_uz, price_uzs, price_unit, min_qty, lead_days, includes_ru, includes_uz,
  options, proposal, decision, decision_reason, decided_at, sort) on app.listing_services to bayramm_api;

-- части дня: как app.availability — календарь ведёт любой пользователь вендора
create policy availability_parts_read on app.availability_parts for select to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id) or app.listing_is_public(listing_id));
create policy availability_parts_write on app.availability_parts for all to bayramm_api
  using ((select app.is_privileged()) or app.owns_listing(listing_id))
  with check ((select app.is_privileged()) or app.owns_listing(listing_id));
grant select, insert, delete on app.availability_parts to bayramm_api;

-- карточка: поля витрины, ссылки на видео, одновременные заказы
grant update (attributes, video_links, parallel_capacity) on app.listings to bayramm_api;

-- заявка: поля категории и часть дня пишутся при подаче
-- (insert на app.requests уже выдан целиком)

revoke execute on all functions in schema app, pii from public;
grant execute on function
  app.video_link_ok(text),
  app.video_links_ok(text[]),
  app.attribute_present(jsonb),
  app.service_options_ok(jsonb),
  app.service_proposal_ok(jsonb),
  app.service_allowed(uuid, text, text),
  app.listing_price_from(uuid, app.listing_status),
  app.staff_add_listing(uuid, text, text, text),
  app.staff_set_listing_category(uuid, text),
  app.listing_set_parallel_capacity(uuid, int, int),
  app.listing_busy(uuid, date, date),
  app.listing_day_load(uuid, date)
  to bayramm_api;
