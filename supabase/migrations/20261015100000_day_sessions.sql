-- ════════════════════════════════════════════════════════════════════════════
-- Несколько мероприятий в день: «Время работы» витрины, части дня заявки, поводы.
--
--   · все категории с календарём — модель занятости parts (зал, студия и ЗАГС — тоже: сид
--     категорий ниже; значения day и slot перечисления app.availability_mode остались, но не
--     используются). Категории со сроком заказа (lead) — как были;
--   · «Время работы» витрины (app.listings): part_mode — whole (одно мероприятие в день: любая
--     договорённость или отметка занимает весь день) или parts (несколько: по частям дня);
--     day_parts — части, в которых витрина работает (непустые, без повторов, по порядку);
--     part_windows — свои окна частей поверх окон категории (формат «ЧЧ:ММ», начало раньше
--     конца, до 24:00, по порядку и без пересечений — между собой; окна категории — в
--     конфигурации, их с рабочими частями сверяет API); parallel_capacity — как было. По
--     умолчанию — несколько мероприятий, все три части, окна категории. Меняют владелец
--     кабинета и сотрудник — app.listing_set_day_sessions: сразу, без модерации, от версии
--     календаря (версия растёт, как у числа заказов одновременно). Часть, на которую есть
--     будущие заявки (новые, просмотренные, «связались», договорённости), не убирается —
--     part_in_use (в DETAIL — «часть:число»); перейти на одно мероприятие в день можно всегда;
--   · заявка (app.requests): day_parts — части дня (пусто — весь день) вместо одной day_part;
--     прежняя часть переносится массивом из неё одной, заявки без части — весь день. Части —
--     только рабочие части витрины в режиме parts (у whole и у категорий без календаря —
--     пусто; триггер requests_category_rules), после подачи не меняются. Отказ «занято»
--     занимает части заявки (весь день — день);
--   · занятость — одни правила у app.listing_busy, app.listing_day_load и
--     app.catalog_day_load (общая app.listing_load_days): часть занята — отметкой части,
--     отметкой дня или договорённостями (deal), занимающими часть, не меньше parallel_capacity;
--     договорённость без частей и любая договорённость витрины whole занимает все части; у
--     whole любая занятая часть — весь день. День: busy — заняты все рабочие части, partial —
--     часть из них. Залы, студии и ЗАГС теперь тоже считают договорённости (раньше их день
--     занимала только отметка). app.catalog_day_load отдаёт и занятые рабочие части — для
--     фильтра каталога «Время»; по-прежнему одним запросом на категорию;
--   · поводы (app.occasions): default_parts — части дня, которые форма заявки отмечает сама;
--     новые поводы и порядок — как в packages/shared/src/categories/occasions.ts (интеграционный
--     тест API сверяет).
--
-- Коды ошибок (продолжение списка): BR039 part_in_use
--
-- Откат: supabase/rollbacks/20261015100000_day_sessions.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── категории: у всех с календарём — части дня ──────────────────────────────
-- categories-seed:begin (pnpm --filter @bayramm/shared categories:sql)
insert into app.categories (code, name_ru, name_uz, enabled, sort, availability_mode, photo_policy,
                            min_photos, max_video_links, required_fields, required_attributes,
                            required_services) values
  ('hall', 'Тойхона', 'Toʻyxona', true, 2, 'parts'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, array['guest_capacity', 'district']::text[], '{}'::text[], array['banquet_weekday', 'banquet_weekend']::text[]),
  ('car', 'Кортеж', 'Kortej', true, 3, 'parts'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], array['fleet', 'service_area']::text[], '{}'::text[]),
  ('studio', 'Студия', 'Studiya', true, 5, 'parts'::app.availability_mode, 'portfolio'::app.photo_policy, 3, 3, array['district']::text[], array['area_m2', 'zones_count']::text[], '{}'::text[]),
  ('flowers', 'Цветы', 'Gul doʻkoni', true, 7, 'lead'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], array['flower_kinds', 'lead_days']::text[], '{}'::text[]),
  ('photo', 'Фото и видео', 'Foto va video', true, 4, 'parts'::app.availability_mode, 'portfolio'::app.photo_policy, 3, 3, '{}'::text[], array['team', 'delivery_days']::text[], '{}'::text[]),
  ('cake', 'Торты и сладости', 'Tort va shirinliklar', true, 11, 'lead'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], array['cake_kinds', 'lead_days']::text[], '{}'::text[]),
  ('gifts', 'Подарки', 'Sovgʻalar', true, 9, 'lead'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], array['gift_kinds', 'min_batch', 'lead_days']::text[], '{}'::text[]),
  ('decor', 'Декор / Оформление', 'Dekor / Bezak', true, 12, 'parts'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], array['styles']::text[], '{}'::text[]),
  ('food', 'Кейтеринг', 'Katering', true, 10, 'parts'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], array['cuisine', 'min_guests', 'service_area']::text[], '{}'::text[]),
  ('restaurant', 'Ресторан', 'Restoran', true, 6, 'parts'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, array['guest_capacity', 'district']::text[], array['cuisine', 'events']::text[], array['banquet_menu']::text[]),
  ('attire', 'Свадебные наряды', 'Toʻy kiyimlari', true, 8, 'lead'::app.availability_mode, 'portfolio'::app.photo_policy, 3, 3, array['district']::text[], array['attire_for', 'deal_kinds', 'lead_days']::text[], '{}'::text[]),
  ('music', 'Музыка / Ведущий', 'Musiqa / Boshlovchi', false, 13, 'parts'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], '{}'::text[], '{}'::text[]),
  ('kids', 'Аниматоры', 'Animatorlar', false, 14, 'parts'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, '{}'::text[], '{}'::text[], '{}'::text[]),
  ('zags', 'ЗАГС', 'FHDYo', true, 1, 'parts'::app.availability_mode, 'no_people'::app.photo_policy, 3, 0, array['district']::text[], array['zags_kind']::text[], '{}'::text[])
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
  ('food', 'banquet_catering', 'Банкет с обслуживанием', 'Xizmat koʻrsatish bilan banket', array['per_guest']::app.price_unit[], 'base'::app.service_tier, true, false, 1, '[{"code":"waiters","name_ru":"Официанты","name_uz":"Ofitsiantlar","unit":"per_event"},{"code":"furniture","name_ru":"Столы, стулья и посуда","name_uz":"Stol, stul va idish-tovoq","unit":"per_guest"},{"code":"drinks","name_ru":"Напитки","name_uz":"Ichimliklar","unit":"per_guest"}]'::jsonb),
  ('food', 'morning_plov', 'Утренний плов (нахорги ош)', 'Nahorgi osh', array['per_guest', 'per_kg']::app.price_unit[], 'base'::app.service_tier, true, false, 2, '[{"code":"waiters","name_ru":"Официанты","name_uz":"Ofitsiantlar","unit":"per_event"},{"code":"furniture","name_ru":"Столы, стулья и посуда","name_uz":"Stol, stul va idish-tovoq","unit":"per_guest"},{"code":"tent","name_ru":"Шатёр","name_uz":"Chodir","unit":"per_event"}]'::jsonb),
  ('food', 'buffet', 'Фуршет', 'Furshet', array['per_guest']::app.price_unit[], 'extra'::app.service_tier, true, false, 3, '[]'::jsonb),
  ('food', 'fotiha_table', 'Стол на фотиху', 'Fotiha dasturxoni', array['per_guest', 'per_table']::app.price_unit[], 'extra'::app.service_tier, true, false, 4, '[]'::jsonb),
  ('food', 'waiter_service', 'Официанты', 'Ofitsiantlar xizmati', array['per_hour', 'per_event']::app.price_unit[], 'extra'::app.service_tier, false, false, 5, '[]'::jsonb),
  ('food', 'equipment_rent', 'Столы, стулья и посуда напрокат', 'Stol, stul va idish-tovoq ijarasi', array['per_guest', 'per_event']::app.price_unit[], 'extra'::app.service_tier, false, false, 6, '[]'::jsonb),
  ('food', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_guest', 'per_event', 'per_kg']::app.price_unit[], 'extra'::app.service_tier, false, true, 7, '[]'::jsonb),
  ('restaurant', 'banquet_menu', 'Банкетное меню', 'Banket menyusi', array['per_guest']::app.price_unit[], 'base'::app.service_tier, true, false, 1, '[{"code":"extra_dish","name_ru":"Дополнительное блюдо","name_uz":"Qoʻshimcha taom","unit":"per_guest"},{"code":"drinks","name_ru":"Напитки","name_uz":"Ichimliklar","unit":"per_guest"},{"code":"cake","name_ru":"Торт","name_uz":"Tort","unit":"per_event"},{"code":"music","name_ru":"Живая музыка","name_uz":"Jonli musiqa","unit":"per_event"}]'::jsonb),
  ('restaurant', 'fotiha_menu', 'Стол на фотиху', 'Fotiha dasturxoni', array['per_guest', 'per_table']::app.price_unit[], 'extra'::app.service_tier, true, false, 2, '[]'::jsonb),
  ('restaurant', 'girls_party', 'Девичник (киз базми)', 'Qiz bazmi', array['per_guest', 'per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 3, '[{"code":"decor","name_ru":"Оформление","name_uz":"Bezak","unit":"per_event"},{"code":"music","name_ru":"Живая музыка","name_uz":"Jonli musiqa","unit":"per_event"}]'::jsonb),
  ('restaurant', 'private_room', 'Отдельный зал или кабинка', 'Alohida zal yoki kabina', array['per_hour', 'per_event']::app.price_unit[], 'extra'::app.service_tier, false, false, 4, '[{"code":"decor","name_ru":"Оформление","name_uz":"Bezak","unit":"per_event"},{"code":"sound","name_ru":"Звук","name_uz":"Ovoz tizimi","unit":"per_event"}]'::jsonb),
  ('restaurant', 'kids_menu', 'Детское меню', 'Bolalar menyusi', array['per_guest']::app.price_unit[], 'extra'::app.service_tier, false, false, 5, '[]'::jsonb),
  ('restaurant', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_guest', 'per_event', 'per_hour']::app.price_unit[], 'extra'::app.service_tier, false, true, 6, '[]'::jsonb),
  ('attire', 'dress_rent', 'Свадебное платье напрокат', 'Kelinlik koʻylagi ijaraga', array['per_item']::app.price_unit[], 'base'::app.service_tier, true, false, 1, '[{"code":"veil","name_ru":"Фата","name_uz":"Fata","unit":"per_item"},{"code":"alterations","name_ru":"Подгонка по фигуре","name_uz":"Qomatga moslash","unit":"per_item"},{"code":"shoes","name_ru":"Обувь","name_uz":"Poyabzal","unit":"per_item"}]'::jsonb),
  ('attire', 'dress_sale', 'Свадебное платье — продажа', 'Kelinlik koʻylagi — sotuv', array['per_item']::app.price_unit[], 'base'::app.service_tier, true, false, 2, '[{"code":"veil","name_ru":"Фата","name_uz":"Fata","unit":"per_item"},{"code":"alterations","name_ru":"Подгонка по фигуре","name_uz":"Qomatga moslash","unit":"per_item"}]'::jsonb),
  ('attire', 'suit_rent', 'Костюм жениха напрокат', 'Kuyov kostyumi ijaraga', array['per_set']::app.price_unit[], 'extra'::app.service_tier, true, false, 3, '[{"code":"shoes","name_ru":"Обувь","name_uz":"Poyabzal","unit":"per_item"}]'::jsonb),
  ('attire', 'suit_sale', 'Костюм жениха — продажа', 'Kuyov kostyumi — sotuv', array['per_set']::app.price_unit[], 'extra'::app.service_tier, true, false, 4, '[{"code":"alterations","name_ru":"Подгонка по фигуре","name_uz":"Qomatga moslash","unit":"per_item"}]'::jsonb),
  ('attire', 'national_outfit', 'Национальный наряд (келин салом)', 'Milliy libos (kelin salom)', array['per_item', 'per_set']::app.price_unit[], 'extra'::app.service_tier, true, false, 5, '[]'::jsonb),
  ('attire', 'tailoring', 'Пошив на заказ', 'Buyurtma asosida tikish', array['per_item']::app.price_unit[], 'extra'::app.service_tier, true, false, 6, '[]'::jsonb),
  ('attire', 'accessories', 'Фата, обувь и аксессуары', 'Fata, poyabzal va aksessuarlar', array['per_item']::app.price_unit[], 'extra'::app.service_tier, false, false, 7, '[]'::jsonb),
  ('attire', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_item', 'per_set', 'per_event']::app.price_unit[], 'extra'::app.service_tier, false, true, 8, '[]'::jsonb),
  ('music', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_hour', 'per_event']::app.price_unit[], 'extra'::app.service_tier, false, true, 1, '[]'::jsonb),
  ('kids', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_hour', 'per_event']::app.price_unit[], 'extra'::app.service_tier, false, true, 1, '[]'::jsonb),
  ('zags', 'solemn_ceremony', 'Торжественная регистрация', 'Tantanali nikoh marosimi', array['per_event']::app.price_unit[], 'base'::app.service_tier, true, false, 1, '[{"code":"music","name_ru":"Живая музыка","name_uz":"Jonli musiqa","unit":"per_event"},{"code":"photographer","name_ru":"Фотограф","name_uz":"Fotograf","unit":"per_event"},{"code":"champagne","name_ru":"Шампанское и вода","name_uz":"Shampan va suv","unit":"per_item"}]'::jsonb),
  ('zags', 'simple_registration', 'Регистрация без церемонии', 'Marosimsiz roʻyxatdan oʻtkazish', array['per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 2, '[]'::jsonb),
  ('zags', 'offsite_ceremony', 'Выездная церемония', 'Koʻchma nikoh marosimi', array['per_event']::app.price_unit[], 'extra'::app.service_tier, true, false, 3, '[{"code":"arch","name_ru":"Арка","name_uz":"Arka","unit":"per_item"},{"code":"decor","name_ru":"Оформление","name_uz":"Bezak","unit":"per_event"},{"code":"music","name_ru":"Живая музыка","name_uz":"Jonli musiqa","unit":"per_event"}]'::jsonb),
  ('zags', 'documents_help', 'Подготовка документов', 'Hujjatlarni tayyorlash', array['per_event']::app.price_unit[], 'extra'::app.service_tier, false, false, 4, '[]'::jsonb),
  ('zags', 'date_appointment', 'Запись на дату и время', 'Sana va vaqtga yozdirish', array['per_event']::app.price_unit[], 'extra'::app.service_tier, false, false, 5, '[]'::jsonb),
  ('zags', 'foreign_registration', 'Регистрация с иностранным гражданином', 'Chet el fuqarosi bilan nikohni roʻyxatdan oʻtkazish', array['per_event']::app.price_unit[], 'extra'::app.service_tier, false, false, 6, '[]'::jsonb),
  ('zags', 'other', 'Другая услуга', 'Boshqa xizmat', array['per_event']::app.price_unit[], 'extra'::app.service_tier, false, true, 7, '[]'::jsonb)
on conflict (category_code, code) do update set
  name_ru = excluded.name_ru, name_uz = excluded.name_uz, units = excluded.units,
  tier = excluded.tier, in_price_from = excluded.in_price_from, free_name = excluded.free_name,
  sort = excluded.sort, options = excluded.options, enabled = true;
-- categories-seed:end

alter table app.categories alter column availability_mode set default 'parts';

-- ════════════════════════════════════════════════════════════════════════════
-- «Время работы» витрины
-- ════════════════════════════════════════════════════════════════════════════
create type app.part_mode as enum ('whole', 'parts');

-- Набор частей дня: без пустых и повторов, не меньше p_min
create function app.day_parts_ok(p_parts app.day_part[], p_min int) returns boolean
language sql immutable parallel safe set search_path = ''
as $$
  select p_parts is not null
     and cardinality(p_parts) between p_min and 3
     and array_position(p_parts, null) is null
     and (select count(distinct p) from unnest(p_parts) p) = cardinality(p_parts)
$$;

-- Свои окна частей: { "<часть>": { "from": "ЧЧ:ММ", "to": "ЧЧ:ММ" } } — начало раньше конца,
-- конец до 24:00 включительно, окна идут по порядку частей и не пересекаются
create function app.part_windows_ok(p_windows jsonb) returns boolean
language sql immutable parallel safe set search_path = ''
as $$
  select p_windows is null or (
    jsonb_typeof(p_windows) = 'object'
    and not exists (
      select 1 from jsonb_each(p_windows) w
      where w.key not in ('morning', 'day', 'evening')
         or jsonb_typeof(w.value) <> 'object'
         or (select count(*) from jsonb_object_keys(w.value) k) <> 2
         or jsonb_typeof(w.value -> 'from') is distinct from 'string'
         or jsonb_typeof(w.value -> 'to') is distinct from 'string'
         or (w.value ->> 'from') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or (w.value ->> 'to') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
         or (w.value ->> 'from') >= (w.value ->> 'to'))
    -- «ЧЧ:ММ» с ведущим нулём сравниваются как строки
    and coalesce((p_windows #>> '{morning,to}') <= (p_windows #>> '{day,from}'), true)
    and coalesce((p_windows #>> '{day,to}') <= (p_windows #>> '{evening,from}'), true)
    and coalesce((p_windows #>> '{morning,to}') <= (p_windows #>> '{evening,from}'), true))
$$;

alter table app.listings
  add column part_mode    app.part_mode not null default 'parts',
  add column day_parts    app.day_part[] not null default '{morning,day,evening}',
  add column part_windows jsonb,
  add constraint listings_day_parts check (app.day_parts_ok(day_parts, 1)),
  add constraint listings_part_windows check (app.part_windows_ok(part_windows));

comment on column app.listings.part_mode is
  'Время работы: whole — одно мероприятие в день (любая договорённость или отметка — весь день), parts — несколько, по частям дня';
comment on column app.listings.day_parts is
  'Части дня, в которых витрина работает (режим parts): непустые, по порядку';
comment on column app.listings.part_windows is
  'Свои окна частей дня поверх окон категории ({ часть: { from, to } }); null — окна категории (packages/shared/src/categories)';
comment on column app.listings.parallel_capacity is
  'Сколько заказов витрина берёт одновременно — в каждой части дня (в режиме whole — в день): залы, экипажи, машины';

-- Время работы — часть календаря: смена поднимает его версию (как заказов одновременно)
drop trigger listings_capacity_bump on app.listings;
create trigger listings_capacity_bump after update of parallel_capacity, part_mode, day_parts, part_windows
  on app.listings
  for each row when ((new.parallel_capacity, new.part_mode, new.day_parts, new.part_windows)
                     is distinct from (old.parallel_capacity, old.part_mode, old.day_parts, old.part_windows))
  execute function app.listings_capacity_bump();

-- Время работы витрины — из кабинета (только владелец) и из панели, от версии календаря,
-- которую видел человек. Часть с будущими заявками не убирается (part_in_use, в DETAIL —
-- «часть:число» через запятую); на одно мероприятие в день — всегда. Возвращает новую версию
create function app.listing_set_day_sessions(
  p_listing uuid, p_mode app.part_mode, p_parts app.day_part[], p_windows jsonb, p_capacity int, p_version int
) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_parts   app.day_part[];
  v_old     app.day_part[];
  v_in_use  text;
  v_version int;
begin
  if p_listing is null or not (app.is_privileged() or app.owns_listing(p_listing)) then
    raise exception 'not_found' using errcode = '42501';
  end if;
  -- Сотрудник площадки (member) календарь ведёт, а время работы меняет владелец
  if not app.edits_listing(p_listing) then
    raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'время работы меняет владелец';
  end if;
  if p_mode is null then
    raise exception 'invalid_input' using errcode = '22023', detail = 'mode';
  end if;
  if not app.day_parts_ok(p_parts, 1) then
    raise exception 'invalid_input' using errcode = '22023', detail = 'parts';
  end if;
  if not app.part_windows_ok(p_windows) then
    raise exception 'invalid_input' using errcode = '22023', detail = 'windows';
  end if;
  if p_capacity is null or p_capacity not between 1 and 50 then
    raise exception 'invalid_input' using errcode = '22023', detail = 'parallelCapacity';
  end if;
  v_parts := array(select p from unnest(p_parts) p order by p);

  perform app.availability_lock(p_listing, p_version);
  select l.day_parts into v_old from app.listings l where l.id = p_listing for update;

  if p_mode = 'parts' then
    select string_agg(x.part::text || ':' || x.n, ',' order by x.part) into v_in_use
    from (
      select p.part, count(*) as n
      from app.requests r
      cross join lateral unnest(r.day_parts) as p(part)
      where r.listing_id = p_listing
        and r.event_date >= app.tashkent_today()
        and r.status in ('new', 'viewed', 'contacted', 'deal')
        and p.part = any (v_old)
        and not p.part = any (v_parts)
      group by p.part
    ) x;
    if v_in_use is not null then
      raise exception 'part_in_use' using errcode = 'BR039', detail = v_in_use;
    end if;
  end if;

  update app.listings
  set part_mode = p_mode, day_parts = v_parts, part_windows = p_windows, parallel_capacity = p_capacity
  where id = p_listing
    and (part_mode, day_parts, part_windows, parallel_capacity)
        is distinct from (p_mode, v_parts, p_windows, p_capacity);
  select v.version into v_version from app.availability_versions v where v.listing_id = p_listing;
  return coalesce(v_version, 0);
end $$;

-- Журнал правок партнёра — как в 20261012090000_vendor_listing_facts.sql, плюс время работы
create or replace function app.audit_vendor_listing() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_fields text[];
begin
  if app.actor_kind() is distinct from 'vendor_user' then
    return null;
  end if;
  select coalesce(array_agg(n.key order by n.key), '{}') into v_fields
  from jsonb_each(to_jsonb(new)) n
  where n.key in ('name', 'description_ru', 'description_uz', 'attributes', 'video_links',
                  'cap_min', 'cap_max', 'district_code', 'address_ru', 'address_uz',
                  'part_mode', 'day_parts', 'part_windows')
    and n.value is distinct from to_jsonb(old) -> n.key;
  if cardinality(v_fields) = 0 then
    return null;
  end if;
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('listing.vendor_update', 'listing', new.id::text,
          jsonb_build_object('fields', to_jsonb(v_fields), 'vendor_id', new.vendor_id),
          coalesce(nullif(current_setting('app.source', true), '')::app.source, 'vendor_cabinet'));
  return null;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Заявки: несколько частей дня
-- ════════════════════════════════════════════════════════════════════════════
alter table app.requests
  add column day_parts app.day_part[] not null default '{}',
  add constraint requests_day_parts check (app.day_parts_ok(day_parts, 0));

comment on column app.requests.day_parts is
  'Части дня заявки (рабочие части витрины на момент подачи); пусто — весь день';

-- Перенос: прежняя часть — массивом из неё одной. Без триггеров: строки заявок не меняются,
-- кроме нового столбца (неизменность, журнал и уведомления тут ни при чём)
alter table app.requests disable trigger user;
update app.requests set day_parts = array[day_part] where day_part is not null;
alter table app.requests enable trigger user;

-- Части заявки — рабочие части витрины в режиме parts; у whole и у категорий без календаря —
-- весь день (пусто). Хранятся по порядку
create or replace function app.requests_category_rules() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_calendar boolean;
  v_mode     app.part_mode;
  v_working  app.day_part[];
begin
  select c.availability_mode = 'parts', l.part_mode, l.day_parts
    into v_calendar, v_mode, v_working
  from app.listings l join app.categories c on c.code = l.category_code
  where l.id = new.listing_id;
  new.day_parts := coalesce(new.day_parts, '{}');
  if cardinality(new.day_parts) > 0
     and (not coalesce(v_calendar, false) or v_mode = 'whole' or not new.day_parts <@ v_working) then
    raise exception 'invalid_input' using errcode = '23514', detail = 'day_parts';
  end if;
  new.day_parts := array(select p from unnest(new.day_parts) p order by p);
  return new;
end $$;

-- Как в 20261001120100_categories_services.sql: неизменные details и части дня (day_parts)
create or replace function app.requests_before_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor app.actor_kind := app.effective_actor();
begin
  if (new.id, new.public_no, new.client_id, new.listing_id, new.vendor_id, new.consent_id, new.occasion_code,
      new.event_date, new.guests, new.budget_min_uzs, new.budget_max_uzs, new.source, new.sla_due_at, new.created_at,
      new.details, new.day_parts)
     is distinct from
     (old.id, old.public_no, old.client_id, old.listing_id, old.vendor_id, old.consent_id, old.occasion_code,
      old.event_date, old.guests, old.budget_min_uzs, old.budget_max_uzs, old.source, old.sla_due_at, old.created_at,
      old.details, old.day_parts) then
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

-- Как в 20261001120100_categories_services.sql: отказ «занято» занимает части заявки, заявка
-- на весь день — день
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
    if cardinality(new.day_parts) > 0 then
      insert into app.availability_parts (listing_id, day, part, source, request_id)
      select new.listing_id, new.event_date, p, 'request_decline', new.id from unnest(new.day_parts) p
      on conflict (listing_id, day, part) do nothing;
    else
      insert into app.availability (listing_id, day, source, request_id)
      values (new.listing_id, new.event_date, 'request_decline', new.id)
      on conflict (listing_id, day) do nothing;
    end if;
  end if;
  return null;
end $$;

-- Как в 20261001120100_categories_services.sql; отказ «занято» — одна из частей заявки
create or replace function app.availability_parts_guard() returns trigger
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
    raise exception 'invalid_input' using errcode = '23514', detail = 'части дня — только у категорий с календарём';
  end if;
  new.created_by := app.actor_id();
  new.created_at := now();
  if v_actor = 'vendor_user' and new.source = 'staff' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003', detail = 'source staff ставит только сотрудник';
  end if;
  if new.source = 'request_decline' and not exists (
       select 1 from app.requests r
       where r.id = new.request_id and r.listing_id = new.listing_id and r.event_date = new.day
         and new.part = any (r.day_parts) and r.status = 'declined' and r.decline_reason = 'busy') then
    raise exception 'invalid_input' using errcode = '23514',
      detail = 'request_decline — только часть дня и дата заявки этого листинга с отказом «занято»';
  end if;
  return new;
end $$;

-- Прежний столбец и индексы по нему (договорённости дня — для занятости)
alter table app.requests drop column day_part;
create index requests_listing_deals on app.requests (listing_id, event_date) where status = 'deal';
create index requests_deals_day on app.requests (event_date, listing_id) where status = 'deal';

-- ════════════════════════════════════════════════════════════════════════════
-- Занятость: одни правила для витрины и выдачи
-- ════════════════════════════════════════════════════════════════════════════

-- Занятость витрин по дням [p_from, p_to): только дни, где что-то занято. load — busy (день
-- отмечен, заняты все рабочие части или у whole занята хоть одна) или partial; parts — занятые
-- рабочие части (у busy — все рабочие). Часть занята — отметкой или договорённостями (deal),
-- занимающими её, не меньше parallel_capacity: договорённость без частей и любая у whole —
-- во всех частях. Без ПДн. Права не проверяет — только для функций ниже
create function app.listing_load_days(p_listings uuid[], p_from date, p_to date)
returns table (listing_id uuid, day date, load text, parts app.day_part[])
language sql stable set search_path = ''
as $$
  with l as (
    select l.id, l.parallel_capacity as cap, l.part_mode, l.day_parts as working,
           c.availability_mode = 'parts' as calendar
    from app.listings l
    join app.categories c on c.code = l.category_code
    where l.id = any (p_listings)
  ),
  whole_day as (
    select a.listing_id, a.day from app.availability a join l on l.id = a.listing_id
    where a.day >= p_from and a.day < p_to
  ),
  deals as (
    select r.listing_id, r.event_date as day, p.part, count(*) as n
    from app.requests r
    join l on l.id = r.listing_id
    cross join lateral unnest(
      case when l.part_mode = 'whole' or cardinality(r.day_parts) = 0
           then enum_range(null::app.day_part) else r.day_parts end) as p(part)
    where l.calendar and r.status = 'deal' and r.event_date >= p_from and r.event_date < p_to
    group by r.listing_id, r.event_date, p.part
  ),
  busy_part as (
    select a.listing_id, a.day, a.part from app.availability_parts a join l on l.id = a.listing_id
    where l.calendar and a.day >= p_from and a.day < p_to
    union
    select d.listing_id, d.day, d.part from deals d join l on l.id = d.listing_id
    where d.n >= l.cap
  ),
  by_day as (
    select b.listing_id, b.day,
           coalesce(array_agg(b.part order by b.part) filter (where b.part = any (l.working)), '{}') as parts
    from busy_part b join l on l.id = b.listing_id
    group by b.listing_id, b.day
  )
  select w.listing_id, w.day, 'busy'::text, l.working
  from whole_day w join l on l.id = w.listing_id
  union all
  select d.listing_id, d.day,
         case when l.part_mode = 'whole' or cardinality(d.parts) >= cardinality(l.working)
              then 'busy' else 'partial' end,
         case when l.part_mode = 'whole' then l.working else d.parts end
  from by_day d join l on l.id = d.listing_id
  where (l.part_mode = 'whole' or cardinality(d.parts) > 0)
    and not exists (select 1 from whole_day w where w.listing_id = d.listing_id and w.day = d.day)
$$;

comment on function app.listing_load_days(uuid[], date, date) is
  'Занятость витрин по дням (busy, partial и занятые рабочие части) — общие правила app.listing_busy и app.catalog_day_load';

-- Занятость витрины по дням [p_from, p_to): дни, где что-то занято, и что именно — {all}
-- (весь день) или занятые рабочие части. Без ПДн: только даты и части. Опубликованная
-- витрина — всем (публичный календарь), остальные — сотруднику и вендору-владельцу
create or replace function app.listing_busy(p_listing uuid, p_from date, p_to date)
returns table (day date, parts text[])
language sql stable security definer set search_path = ''
as $$
  select x.day, case when x.load = 'busy' then array['all']::text[] else x.parts::text[] end
  from app.listings l
  cross join lateral app.listing_load_days(array[l.id], p_from, p_to) x
  where l.id = p_listing and (l.status = 'active' or app.is_privileged() or app.owns_listing(l.id))
    and p_to <= p_from + 400
  order by 1
$$;

-- Загрузка на день p_day опубликованных витрин категории — одним запросом на всю выдачу, по
-- тем же правилам, что app.listing_busy: busy или partial и занятые рабочие части (фильтр
-- «Время»). Свободных в ответе нет. Без ПДн: только id витрины, загрузка и части
drop function app.catalog_day_load(text, date);
create function app.catalog_day_load(p_category text, p_day date)
returns table (listing_id uuid, load text, parts app.day_part[])
language sql stable security definer set search_path = ''
as $$
  select x.listing_id, x.load, x.parts
  from app.listing_load_days(
    array(select l.id from app.listings l where l.category_code = p_category and l.status = 'active'),
    p_day, p_day + 1) x
$$;

comment on function app.catalog_day_load(text, date) is
  'Загрузка на день опубликованных витрин категории (busy, partial и занятые рабочие части; свободных нет в ответе) — одним запросом для выдачи';

-- ════════════════════════════════════════════════════════════════════════════
-- Поводы: части дня по умолчанию
-- ════════════════════════════════════════════════════════════════════════════
alter table app.occasions
  add column default_parts app.day_part[] not null default '{}',
  add constraint occasions_default_parts check (app.day_parts_ok(default_parts, 0));

comment on column app.occasions.default_parts is
  'Части дня, которые форма заявки отмечает сама, когда выбран этот повод (клиент меняет)';

-- Как packages/shared/src/categories/occasions.ts
insert into app.occasions (code, name_ru, name_uz, sort, default_parts) values
  ('toy',         'Свадьба',       'Toʻy',          1,  '{evening}'),
  ('nahorgi_osh', 'Нахорги ош',    'Nahorgi osh',   2,  '{morning}'),
  ('nikoh',       'Никах (ЗАГС)',  'Nikoh (FHDYo)', 3,  '{day}'),
  ('fotiha',      'Фотиха-той',    'Fotiha toʻyi',  4,  '{day}'),
  ('qiz_bazmi',   'Девичник',      'Qiz bazmi',     5,  '{evening}'),
  ('kelin_salom', 'Келин салом',   'Kelin salom',   6,  '{morning}'),
  ('sunnat',      'Суннат-той',    'Sunnat toʻyi',  7,  '{morning}'),
  ('beshik',      'Бешик-той',     'Beshik toʻyi',  8,  '{day}'),
  ('bd',          'День рождения', 'Tugʻilgan kun', 9,  '{evening}'),
  ('yubiley',     'Юбилей',        'Yubiley',       10, '{evening}'),
  ('corp',        'Корпоратив',    'Korporativ',    11, '{evening}'),
  ('small',       'Частное',       'Yopiq davra',   12, '{evening}')
on conflict (code) do update
  set name_ru = excluded.name_ru, name_uz = excluded.name_uz, sort = excluded.sort,
      default_parts = excluded.default_parts;

-- ════════════════════════════════════════════════════════════════════════════
-- Права
-- ════════════════════════════════════════════════════════════════════════════
revoke execute on all functions in schema app, pii from public;
grant execute on function
  app.listing_set_day_sessions(uuid, app.part_mode, app.day_part[], jsonb, int, int),
  app.catalog_day_load(text, date),
  app.day_parts_ok(app.day_part[], int),
  app.part_windows_ok(jsonb)
to bayramm_api;
