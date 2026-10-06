-- Категории и услуги (20261001120100_categories_services.sql): каталог услуг, услуги
-- витрины и их модерация, цена «от», готовность по категории, правило фото, части дня
-- и одновременные заказы, витрины вендора в нескольких категориях
begin;
\ir _fixtures.psql
select plan(67);

-- оповещения: администратору — чат с ботом, владельцу кабинета A — привязанный Telegram
update pii.staff_profiles set telegram_chat_id = 9001 where staff_id = '00000000-0000-0000-0000-00000000a001';
update app.vendor_users set tg_user_hash = sha256('tg-vendor-a'), tg_linked_at = now()
 where id = 'aaaaaaaa-0000-0000-0000-000000000011';
update pii.vendor_user_profiles set telegram_chat_id = 9101, telegram_user_id = 9101
 where vendor_user_id = 'aaaaaaaa-0000-0000-0000-000000000011';

-- ── категории и каталог услуг ───────────────────────────────────────────────
select results_eq(
  $$select code, availability_mode::text, photo_policy::text from app.categories
     where code in ('hall', 'car', 'studio', 'flowers', 'photo') order by sort$$,
  $$values ('hall', 'day', 'no_people'), ('car', 'parts', 'no_people'), ('studio', 'slot', 'portfolio'),
           ('flowers', 'lead', 'no_people'), ('photo', 'parts', 'portfolio')$$,
  'режим занятости и правило фото — из конфигурации');
select is_empty(
  $$select c.code from app.categories c
     where not exists (select 1 from app.service_types t where t.category_code = c.code and t.code = 'other' and t.free_name)$$,
  '«другая услуга» со свободным названием — в каждой категории');
select results_eq(
  $$select required_services from app.categories where code = 'hall'$$,
  $$values (array['banquet_weekday', 'banquet_weekend'])$$,
  'зал: банкеты будни и выходные обязательны, как пакеты v0.1');
select ok(app.service_allowed('aaaaaaaa-0000-0000-0000-000000000001', 'photo', 'drone'),
  'app.service_allowed — пока всегда да');

-- ── витрина фото и видео у вендора A ────────────────────────────────────────
insert into app.listings (id, vendor_id, slug, category_code, name, description_ru, description_uz)
values ('aaaaaaaa-0000-0000-0000-000000000201', 'aaaaaaaa-0000-0000-0000-000000000001', 'test-photo', 'photo',
        'Test Photo', 'Описание', 'Tavsif');
insert into pii.listing_contacts (listing_id, public_phone) values ('aaaaaaaa-0000-0000-0000-000000000201', '+998000000997');

select is(
  pg_temp.error_detail($$update app.listings set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-000000000201'$$),
  'price,attributes,photos',
  'у фото и видео нет вместимости и района, но нужны услуга с ценой, поля витрины и фото');

-- фото с людьми: портфолио — с согласием людей на фото
select throws_ok(
  $$insert into app.photos (listing_id, storage_key, no_faces_ack, people_consent_ack)
    values ('aaaaaaaa-0000-0000-0000-000000000102', pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000102'), false, true)$$,
  'BR028', 'photo_ack_required', 'залу фото с людьми нельзя — только «без лиц»');
select throws_ok(
  $$insert into app.photos (listing_id, storage_key, no_faces_ack, people_consent_ack)
    values ('aaaaaaaa-0000-0000-0000-000000000201', pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000201'), false, false)$$,
  'BR028', 'photo_ack_required', 'без подтверждения фото не принимается и у портфолио');
insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256, sort,
                        no_faces_ack, people_consent_ack)
select 'aaaaaaaa-0000-0000-0000-000000000201', 'ready', 'approved',
       pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000201'), 'image/webp', 1000, 1600, 1200,
       sha256(convert_to('photo/' || n, 'UTF8')), n, false, true
from generate_series(1, 3) n;
select is((select count(*)::int from app.photos where listing_id = 'aaaaaaaa-0000-0000-0000-000000000201'), 3,
  'портфолио принимает фото с людьми при согласии');

update app.listings set attributes = '{"team": ["photographer", "drone_operator"], "delivery_days": 30}',
                        video_links = array['https://www.youtube.com/watch?v=dQw4w9WgXcQ']
 where id = 'aaaaaaaa-0000-0000-0000-000000000201';
select throws_ok(
  $$update app.listings set video_links = array['https://example.com/video']
     where id = 'aaaaaaaa-0000-0000-0000-000000000201'$$,
  '23514', null, 'ссылка на видео — только YouTube или Instagram в каноническом виде');
select throws_ok(
  $$update app.listings set video_links = array['https://www.youtube.com/watch?v=dQw4w9WgXcQ']
     where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  '23514', null, 'залу ссылки на видео не положены');

-- ── услуги: партнёр предлагает, модератор решает ───────────────────────────
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$insert into app.listing_services (listing_id, category_code, service_type, status, price_uzs, price_unit)
    values ('aaaaaaaa-0000-0000-0000-000000000201', 'photo', 'photo_shoot', 'active', 500000, 'per_hour')$$,
  'BR003', 'forbidden_for_actor', 'партнёр не публикует услугу сам');
select throws_ok(
  $$insert into app.listing_services (listing_id, category_code, service_type, status, price_uzs, price_unit)
    values ('aaaaaaaa-0000-0000-0000-000000000201', 'photo', 'photo_shoot', 'review', 500000, 'per_kg')$$,
  '23514', null, 'единица цены — из каталога типа услуги');
select throws_ok(
  $$insert into app.listing_services (listing_id, category_code, service_type, status, price_uzs, price_unit)
    values ('aaaaaaaa-0000-0000-0000-000000000201', 'photo', 'bride_car', 'review', 500000, 'per_hour')$$,
  '23514', null, 'тип услуги — из каталога категории витрины');
select throws_ok(
  $$insert into app.listing_services (listing_id, category_code, service_type, status, price_uzs, price_unit)
    values ('aaaaaaaa-0000-0000-0000-000000000201', 'photo', 'other', 'review', 500000, 'per_hour')$$,
  '23514', null, 'у другой услуги нужно название');
select lives_ok(
  $$insert into app.listing_services (id, listing_id, category_code, service_type, status, price_uzs, price_unit, options)
    values ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000201', 'photo', 'photo_shoot',
            'review', 500000, 'per_hour',
            '[{"id": "aaaaaaaa-0000-0000-0000-0000000000e1", "code": "extra_hour", "name_ru": "Ещё час",
               "name_uz": "Yana soat", "price_uzs": 400000, "price_unit": "per_hour"}]'),
           ('aaaaaaaa-0000-0000-0000-00000000c002', 'aaaaaaaa-0000-0000-0000-000000000201', 'photo', 'drone',
            'review', 800000, 'per_event', '[]'),
           ('aaaaaaaa-0000-0000-0000-00000000c003', 'aaaaaaaa-0000-0000-0000-000000000201', 'photo', 'photobook',
            'review', 100000, 'per_item', '[]')$$,
  'партнёр отправляет услуги на проверку');
select throws_ok(
  $$insert into app.listing_services (listing_id, category_code, service_type, status, price_uzs, price_unit, options)
    values ('aaaaaaaa-0000-0000-0000-000000000201', 'photo', 'drone', 'review', 1, 'per_event', '[{"name_ru": "x"}]')$$,
  '23514', null, 'опции — по форме: id, названия, цена, единица');
select results_eq(
  $$select price_from_uzs, price_unit::text from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000201'$$,
  $$values (500000::bigint, 'per_hour')$$,
  'цена «от» неопубликованной витрины — из услуг на проверке; фотокнига в «от» не входит');
select is(
  pg_temp.error_detail($$update app.listings set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-000000000201'$$),
  null, 'услуги на проверке — достаточно для отправки на проверку');

reset role;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select is(
  pg_temp.error_detail($$update app.listings set status = 'active' where id = 'aaaaaaaa-0000-0000-0000-000000000201'$$),
  'price', 'в каталог — только с одобренной услугой');
-- публикация одобряет услуги на проверке (как фото) — так делает API
update app.listing_services set status = 'active'
 where listing_id = 'aaaaaaaa-0000-0000-0000-000000000201' and status = 'review';
select lives_ok(
  $$update app.listings set status = 'active' where id = 'aaaaaaaa-0000-0000-0000-000000000201'$$,
  'одобренные услуги — витрину можно опубликовать');
select results_eq(
  $$select decision, decided_by from app.listing_services where id = 'aaaaaaaa-0000-0000-0000-00000000c001'$$,
  $$values ('approved', '00000000-0000-0000-0000-00000000a001'::uuid)$$,
  'одобрение записано: кто и что решил');
select is_empty(
  $$select id from app.outbox where kind = 'vendor.service_decided'$$,
  'одобрение вместе с публикацией карточки партнёру отдельно не оповещается');

-- опубликованная витрина: правка активной услуги — предложением
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$update app.listing_services set price_uzs = 450000 where id = 'aaaaaaaa-0000-0000-0000-00000000c001'$$,
  'BR005', 'moderated_field_requires_revision', 'цену активной услуги партнёр меняет предложением');
select lives_ok(
  $$update app.listing_services set proposal = '{"price_uzs": 450000}' where id = 'aaaaaaaa-0000-0000-0000-00000000c001'$$,
  'партнёр предлагает новую цену');
select throws_ok(
  $$update app.listing_services set proposal = '{"price_uzs": 450000, "color": "red"}'
     where id = 'aaaaaaaa-0000-0000-0000-00000000c001'$$,
  '23514', null, 'в предложении — только поля услуги');
select throws_ok(
  $$update app.listing_services set decision = 'approved', decided_at = clock_timestamp()
     where id = 'aaaaaaaa-0000-0000-0000-00000000c001'$$,
  'BR003', 'forbidden_for_actor', 'партнёр не решает по своей услуге');
select lives_ok(
  $$insert into app.listing_services (id, listing_id, category_code, service_type, status, price_uzs, price_unit)
    values ('aaaaaaaa-0000-0000-0000-00000000c004', 'aaaaaaaa-0000-0000-0000-000000000201', 'photo', 'videography',
            'review', 900000, 'per_event')$$,
  'новая услуга опубликованной витрины — на проверку');
reset role;
select is(
  (select count(*)::int from app.outbox where kind = 'ops.service_submitted'
     and payload ->> 'listing_id' = 'aaaaaaaa-0000-0000-0000-000000000201'),
  1, 'команде — одно оповещение в час на витрину, сколько бы ни пришло');
select results_eq(
  $$select price_from_uzs from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000201'$$,
  $$values (500000::bigint)$$,
  'пока предложение ждёт, клиент видит прежнюю цену; услуга на проверке в «от» опубликованной витрины не входит');

-- модератор: одобрить предложение (так делает API) и отклонить новую услугу
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
update app.listing_services set price_uzs = 450000, proposal = null, decision = 'approved', decision_reason = null,
                                decided_at = clock_timestamp()
 where id = 'aaaaaaaa-0000-0000-0000-00000000c001';
update app.listing_services set status = 'rejected', decision = 'declined', decision_reason = 'Нужна цена за час'
 where id = 'aaaaaaaa-0000-0000-0000-00000000c004';
select results_eq(
  $$select price_from_uzs from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000201'$$,
  $$values (450000::bigint)$$,
  'одобренная цена — сразу в цене «от»');
select results_eq(
  $$select payload ->> 'decision', recipient_id from app.outbox where kind = 'vendor.service_decided' order by payload ->> 'decision'$$,
  $$values ('approved', 'aaaaaaaa-0000-0000-0000-000000000011'::uuid),
           ('declined', 'aaaaaaaa-0000-0000-0000-000000000011'::uuid)$$,
  'решения по услугам опубликованной витрины — владельцу кабинета, в payload только id и решение');
select is_empty(
  $$select id from app.outbox where kind = 'vendor.service_decided' and payload::text like '%цена%'$$,
  'причины отказа в payload нет — текст собирается при отправке');

-- витрина не остаётся без цены
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select lives_ok(
  $$update app.listing_services set status = 'paused'
     where id in ('aaaaaaaa-0000-0000-0000-00000000c002', 'aaaaaaaa-0000-0000-0000-00000000c003')$$,
  'партнёр снимает услуги с витрины');
select throws_ok(
  $$update app.listing_services set status = 'paused' where id = 'aaaaaaaa-0000-0000-0000-00000000c001'$$,
  'BR004', 'publish_blocked', 'последнюю услугу с ценой опубликованной витрины снять нельзя');
select throws_ok(
  $$update app.listing_services set status = 'active' where id = 'aaaaaaaa-0000-0000-0000-00000000c002'$$,
  'BR003', 'forbidden_for_actor', 'вернуть на витрину — через проверку');
select lives_ok(
  $$update app.listing_services set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-00000000c002'$$,
  'снятую услугу партнёр отправляет на проверку снова');
select throws_ok(
  $$delete from app.listing_services where id = 'aaaaaaaa-0000-0000-0000-00000000c001'$$,
  'BR005', 'moderated_field_requires_revision', 'активную услугу опубликованной витрины партнёр не удаляет');

-- чужие и гостевые
select pg_temp.as_actor('vendor_user', 'bbbbbbbb-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001');
select is_empty(
  $$select id from app.listing_services where listing_id = 'aaaaaaaa-0000-0000-0000-000000000201'
     and status <> 'active'$$,
  'чужие услуги на проверке не видны');
select throws_ok(
  $$insert into app.listing_services (listing_id, category_code, service_type, status, price_uzs, price_unit)
    values ('aaaaaaaa-0000-0000-0000-000000000201', 'photo', 'drone', 'review', 1, 'per_event')$$,
  '42501', null, 'в чужую витрину услугу не добавить');
select pg_temp.as_actor(null);
select set_eq(
  $$select id from app.listing_services where listing_id = 'aaaaaaaa-0000-0000-0000-000000000201'$$,
  array['aaaaaaaa-0000-0000-0000-00000000c001']::uuid[],
  'гость видит только активные услуги опубликованной витрины');
reset role;

-- ── поля витрины ────────────────────────────────────────────────────────────
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok(
  $$update app.listings set attributes = '{"team": []}' where id = 'aaaaaaaa-0000-0000-0000-000000000201'$$,
  'BR004', 'publish_blocked', 'обязательное поле витрины у опубликованной карточки не убрать');
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$update app.listings set attributes = attributes || '{"styles": ["cinematic"]}'
     where id = 'aaaaaaaa-0000-0000-0000-000000000201'$$,
  'BR005', 'moderated_field_requires_revision', 'поля витрины партнёр меняет правкой');
select lives_ok(
  $$insert into app.listing_revisions (listing_id, payload, base_version)
    select id, '{"attributes": {"styles": ["cinematic"]}}', version from app.listings
     where id = 'aaaaaaaa-0000-0000-0000-000000000201'$$,
  'правка карточки принимает поля витрины');
reset role;

-- ── части дня и одновременные заказы ────────────────────────────────────────
select pg_temp.as_actor(null);
select throws_ok(
  $$insert into app.availability_parts (listing_id, day, part)
    values ('aaaaaaaa-0000-0000-0000-000000000101', current_date + 10, 'morning')$$,
  '23514', null, 'части дня — только у режима parts (зал — весь день)');

insert into app.consents (id, subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source) values
  ('ffffffff-0000-0000-0000-0000000000c1', 'client', 'cccccccc-0000-0000-0000-000000000001', 'request_transfer',
   'grant', 'dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000201', 'tma');
select throws_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, source, sla_due_at)
    values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000201',
            'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000c1', 'toy',
            current_date + 20, 'tma', now())$$,
  '23514', null, 'заявке режима parts нужна часть дня');
insert into app.requests (id, client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, source, sla_due_at,
                          day_part, details)
values ('eeeeeeee-0000-0000-0000-0000000000c1', 'cccccccc-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000201', 'aaaaaaaa-0000-0000-0000-000000000001',
        'ffffffff-0000-0000-0000-0000000000c1', 'toy', current_date + 20, 'tma', now(),
        'evening', '{"start_time": "18:00", "coverage": ["photo"]}');
select is((select guests from app.requests where id = 'eeeeeeee-0000-0000-0000-0000000000c1'), null,
  'число гостей фото и видео не обязательно');
select throws_ok(
  $$insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source,
                              sla_due_at, day_part)
    values ('cccccccc-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000101',
            'bbbbbbbb-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000b1', 'toy',
            current_date + 21, 50, 'tma', now(), 'evening')$$,
  '23514', null, 'у зала части дня нет');

select is_empty(
  $$select * from app.listing_busy('aaaaaaaa-0000-0000-0000-000000000201', current_date + 20, current_date + 21)$$,
  'новая заявка часть дня не занимает');
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000c1';
update app.requests set status = 'deal' where id = 'eeeeeeee-0000-0000-0000-0000000000c1';
select results_eq(
  $$select parts from app.listing_busy('aaaaaaaa-0000-0000-0000-000000000201', current_date + 20, current_date + 21)$$,
  $$values (array['evening'])$$,
  'договорённость занимает свою часть дня, когда мест столько же (parallel_capacity = 1)');
select is(app.listing_day_load('aaaaaaaa-0000-0000-0000-000000000201', current_date + 20), 'partial',
  'день занят частично');
select throws_ok(
  $$update app.requests set details = '{}' where id = 'eeeeeeee-0000-0000-0000-0000000000c1'$$,
  'BR006', 'immutable_column', 'поля заявки после подачи не меняются');

-- два экипажа: вечер снова свободен; вендор отмечает утро и день — день занят целиком
select is(app.listing_set_parallel_capacity('aaaaaaaa-0000-0000-0000-000000000201', 2, 0), 1,
  'сколько заказов одновременно — от версии календаря; версия растёт');
select throws_ok(
  $$select app.listing_set_parallel_capacity('aaaaaaaa-0000-0000-0000-000000000201', 3, 0)$$,
  'BR025', 'calendar_conflict', 'устаревшая версия календаря — конфликт');
select is_empty(
  $$select * from app.listing_busy('aaaaaaaa-0000-0000-0000-000000000201', current_date + 20, current_date + 21)$$,
  'при двух экипажах одна договорённость часть дня не занимает');
insert into app.availability_parts (listing_id, day, part) values
  ('aaaaaaaa-0000-0000-0000-000000000201', current_date + 20, 'morning'),
  ('aaaaaaaa-0000-0000-0000-000000000201', current_date + 20, 'day');
select results_eq(
  $$select parts from app.listing_busy('aaaaaaaa-0000-0000-0000-000000000201', current_date + 20, current_date + 21)$$,
  $$values (array['morning', 'day'])$$,
  'отметки вендора по частям дня — в занятости');
select is((select version from app.availability_versions where listing_id = 'aaaaaaaa-0000-0000-0000-000000000201'), 3,
  'отметки частей дня поднимают ту же версию календаря');
select throws_ok(
  $$insert into app.availability_parts (listing_id, day, part)
    values ('aaaaaaaa-0000-0000-0000-000000000201', current_date - 1, 'morning')$$,
  'BR024', 'date_out_of_range', 'прошедший день не меняется');
insert into app.availability (listing_id, day) values ('aaaaaaaa-0000-0000-0000-000000000201', current_date + 20);
select results_eq(
  $$select parts from app.listing_busy('aaaaaaaa-0000-0000-0000-000000000201', current_date + 20, current_date + 21)$$,
  $$values (array['all'])$$,
  'отметка на весь день — день занят');
select pg_temp.as_actor('client', 'cccccccc-0000-0000-0000-000000000001');
select is(app.listing_day_load('aaaaaaaa-0000-0000-0000-000000000201', current_date + 20), 'busy',
  'публичная занятость видна всем — без ПДн');
select is_empty(
  $$select * from app.listing_busy('aaaaaaaa-0000-0000-0000-000000000102', current_date, current_date + 30)$$,
  'занятость неопубликованной витрины — только владельцу и сотрудникам');

-- ── витрины в нескольких категориях ─────────────────────────────────────────
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$select app.staff_add_listing('aaaaaaaa-0000-0000-0000-000000000001', 'cake', 'Cake', 'test-cake')$$,
  'BR003', 'forbidden_for_actor', 'витрину добавляет только сотрудник');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select lives_ok(
  $$select app.staff_add_listing('aaaaaaaa-0000-0000-0000-000000000001', 'cake', 'Cake', 'test-cake')$$,
  'менеджер добавляет вендору витрину в другой категории');
select results_eq(
  $$select l.category_code, l.status::text, a.action from app.listings l
     join app.audit_log a on a.detail ->> 'listing_id' = l.id::text
    where l.slug = 'test-cake'$$,
  $$values ('cake', 'draft', 'vendor.listing_add')$$,
  'черновиком, с записью в журнале вендора');
select throws_ok(
  $$select app.staff_add_listing('aaaaaaaa-0000-0000-0000-000000000001', 'music', 'Music', 'test-music')$$,
  '23514', null, 'только во включённой категории');
select throws_ok(
  $$select app.staff_set_listing_category('aaaaaaaa-0000-0000-0000-000000000201', 'decor')$$,
  'BR026', 'category_locked', 'категорию витрины с заявками не сменить');
select lives_ok(
  $$select app.staff_set_listing_category((select id from app.listings where slug = 'test-cake'), 'gifts')$$,
  'категорию черновика без заявок сотрудник меняет');
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$update app.listings set category_code = 'cake' where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  'BR006', 'immutable_column', 'партнёр категорию витрины не меняет');

select * from finish();
rollback;
