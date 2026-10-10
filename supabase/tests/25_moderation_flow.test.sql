-- То, что партнёр отправил на проверку, доходит до команды (20261011090000_moderation_flow.sql):
-- услуги и фото черновика — команде, без потерь за час; отправка витрины на проверку — тем,
-- кто публикует; оповещение, которое некому отправить, — в журнал; решение по услуге
-- черновика — партнёру только об отказе; услуги — в очередях команды
begin;
\ir _fixtures.psql
select plan(26);

-- ════════════════════════════════════════════════════════════════════════════
-- Права
-- ════════════════════════════════════════════════════════════════════════════
select is_empty(
  $$select f from unnest(array['app.log_alert_without_recipients(text, app.staff_role[], uuid)',
                               'app.enqueue_listing_alert(text, app.staff_role[], uuid)',
                               'app.listings_submitted_notify()']) f
    where has_function_privilege('bayramm_api', f, 'EXECUTE')$$,
  'служебные и триггерные функции API недоступны');
select ok(has_function_privilege('bayramm_api', 'app.metrics_ops_now()', 'EXECUTE'), 'API: очереди команды');

-- Модератор …a003; владелец кабинета A привязал Telegram (решения по услугам — ему).
-- Чатов с ботом у команды пока нет ни у кого
insert into app.staff (id, role) values ('00000000-0000-0000-0000-00000000a003', 'moderator');
insert into pii.staff_profiles (staff_id, display_name) values ('00000000-0000-0000-0000-00000000a003', 'Moderator');
update app.vendor_users set tg_user_hash = sha256('tg-vendor-a'), tg_linked_at = now()
 where id = 'aaaaaaaa-0000-0000-0000-000000000011';
update pii.vendor_user_profiles set telegram_chat_id = 9101, telegram_user_id = 9101
 where vendor_user_id = 'aaaaaaaa-0000-0000-0000-000000000011';

-- ════════════════════════════════════════════════════════════════════════════
-- Некому отправить — след в журнале
-- ════════════════════════════════════════════════════════════════════════════
-- A2 (…0102) — пустой черновик зала вендора A
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select lives_ok(
  $$insert into app.listing_services (id, listing_id, category_code, service_type, status, price_uzs, price_unit)
    values ('aaaaaaaa-0000-0000-0000-00000000d001', 'aaaaaaaa-0000-0000-0000-000000000102', 'hall',
            'banquet_weekday', 'review', 150000, 'per_guest')$$,
  'партнёр отправляет услугу черновика на проверку');
reset role;
select pg_temp.as_actor(null);
select is((select count(*)::int from app.outbox where kind = 'ops.service_submitted'), 0,
  'ни у кого из решающих нет чата с ботом — оповещения нет');
select results_eq(
  $$select actor_kind::text, object_type, object_id, detail from app.audit_log where action = 'outbox.no_recipients'$$,
  $$values ('vendor_user', 'listing', 'aaaaaaaa-0000-0000-0000-000000000102', '{"kind": "ops.service_submitted"}'::jsonb)$$,
  'но в журнале — что оповещение некому отправить: вид и витрина');
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
insert into app.listing_services (id, listing_id, category_code, service_type, status, price_uzs, price_unit, sort)
values ('aaaaaaaa-0000-0000-0000-00000000d002', 'aaaaaaaa-0000-0000-0000-000000000102', 'hall',
        'banquet_weekend', 'review', 180000, 'per_guest', 1);
reset role;
select pg_temp.as_actor(null);
select is((select count(*)::int from app.audit_log where action = 'outbox.no_recipients'), 1,
  'в журнал — не чаще раза в час на витрину и вид');

-- ════════════════════════════════════════════════════════════════════════════
-- Услуги черновика — команде, без потерь
-- ════════════════════════════════════════════════════════════════════════════
update pii.staff_profiles set telegram_chat_id = 9000 + right(staff_id::text, 1)::int
where staff_id in ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a002',
                   '00000000-0000-0000-0000-00000000a003');

set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
update app.listing_services set status = 'draft' where id = 'aaaaaaaa-0000-0000-0000-00000000d001';
update app.listing_services set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-00000000d001';
reset role;
select pg_temp.as_actor(null);
select results_eq(
  $$select recipient_id, payload from app.outbox where kind = 'ops.service_submitted' order by recipient_id$$,
  $$values ('00000000-0000-0000-0000-00000000a001'::uuid, '{"listing_id": "aaaaaaaa-0000-0000-0000-000000000102"}'::jsonb),
           ('00000000-0000-0000-0000-00000000a003'::uuid, '{"listing_id": "aaaaaaaa-0000-0000-0000-000000000102"}'::jsonb)$$,
  'услуга черновика — администратору и модератору (менеджер по услугам не решает)');

set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
update app.listing_services set status = 'draft' where id = 'aaaaaaaa-0000-0000-0000-00000000d002';
update app.listing_services set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-00000000d002';
reset role;
select pg_temp.as_actor(null);
select is((select count(*)::int from app.outbox where kind = 'ops.service_submitted'), 2,
  'пока оповещение не отправлено, второе не ставится: текст при отправке скажет о всех');

-- Первое ушло сразу (outboxKick) — следующая услуга в тот же час уже не теряется
update app.outbox set status = 'sent', sent_at = now() where kind = 'ops.service_submitted';
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
update app.listing_services set status = 'draft' where id = 'aaaaaaaa-0000-0000-0000-00000000d002';
update app.listing_services set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-00000000d002';
reset role;
select pg_temp.as_actor(null);
select results_eq(
  $$select status::text, count(*)::int from app.outbox where kind = 'ops.service_submitted' group by status order by 1$$,
  $$values ('pending', 2), ('sent', 2)$$,
  'отправленное новому не мешает: в тот же час — новое оповещение');

-- Взятое на отправку (sending) — его текст, может быть, уже собран: новое ставится
update app.outbox set status = 'sending', enqueued_at = now()
 where kind = 'ops.service_submitted' and status = 'pending';
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
update app.listing_services set status = 'draft' where id = 'aaaaaaaa-0000-0000-0000-00000000d002';
update app.listing_services set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-00000000d002';
reset role;
select pg_temp.as_actor(null);
select is((select count(*)::int from app.outbox where kind = 'ops.service_submitted' and status = 'pending'), 2,
  'строка в отправке не глушит новую');
-- Неудачная попытка — строка ещё уйдёт (и соберёт текст заново): новое не ставится
update app.outbox set status = 'failed' where kind = 'ops.service_submitted' and status = 'pending';
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
update app.listing_services set status = 'draft' where id = 'aaaaaaaa-0000-0000-0000-00000000d002';
update app.listing_services set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-00000000d002';
reset role;
select pg_temp.as_actor(null);
select is((select count(*)::int from app.outbox where kind = 'ops.service_submitted'), 6,
  'после неудачной попытки нового не ставится — повтор скажет и о нём');

-- Предложение правки опубликованной витрины A1 — команде (новая витрина — своё оповещение)
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
update app.listing_services set proposal = '{"price_uzs": 160000}'
 where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and service_type = 'banquet_weekday';
reset role;
select pg_temp.as_actor(null);
select is((select count(*)::int from app.outbox where kind = 'ops.service_submitted'
             and payload ->> 'listing_id' = 'aaaaaaaa-0000-0000-0000-000000000101'), 2,
  'предложение правки опубликованной витрины — команде');

-- ════════════════════════════════════════════════════════════════════════════
-- Фото черновика — команде; у отклонённой витрины — ничего
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select lives_ok(
  $$insert into app.photos (id, listing_id, storage_key, no_faces_ack)
    values ('f0f0f0f0-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000102',
            pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000102'), true)$$,
  'партнёр загружает фото черновика');
reset role;
select pg_temp.as_actor(null);
select results_eq(
  $$select recipient_id from app.outbox where kind = 'ops.photos_submitted' order by recipient_id$$,
  $$values ('00000000-0000-0000-0000-00000000a001'::uuid), ('00000000-0000-0000-0000-00000000a003'::uuid)$$,
  'новое фото черновика — тем, кто решает по фото');
update app.photos set status = 'ready', mime = 'image/webp', bytes = 1000, width = 1600, height = 1200,
                      sha256 = sha256('draft-photo'), processed_at = now()
 where id = 'f0f0f0f0-0000-0000-0000-0000000000d1';

-- A3 — отклонённая витрина вендора A
insert into app.listings (id, vendor_id, slug, category_code, name)
values ('aaaaaaaa-0000-0000-0000-000000000103', 'aaaaaaaa-0000-0000-0000-000000000001', 'test-a3', 'hall', 'Test Hall A3');
update app.listings set status = 'rejected', status_reason = 'Не тот формат'
 where id = 'aaaaaaaa-0000-0000-0000-000000000103';
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
insert into app.listing_services (listing_id, category_code, service_type, status, price_uzs, price_unit)
values ('aaaaaaaa-0000-0000-0000-000000000103', 'hall', 'banquet_weekday', 'review', 100000, 'per_guest');
insert into app.photos (id, listing_id, storage_key, no_faces_ack)
values ('f0f0f0f0-0000-0000-0000-0000000000d2', 'aaaaaaaa-0000-0000-0000-000000000103',
        pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000103'), true);
reset role;
select pg_temp.as_actor(null);
update app.photos set status = 'ready', mime = 'image/webp', bytes = 1000, width = 1600, height = 1200,
                      sha256 = sha256('rejected-photo'), processed_at = now()
 where id = 'f0f0f0f0-0000-0000-0000-0000000000d2';
select is_empty(
  $$select id from app.outbox where payload ->> 'listing_id' = 'aaaaaaaa-0000-0000-0000-000000000103'$$,
  'у отклонённой витрины услуги и фото команде не оповещаются');

-- ════════════════════════════════════════════════════════════════════════════
-- Партнёр отправляет витрину на проверку
-- ════════════════════════════════════════════════════════════════════════════
-- A2 готова: вместимость, район, описания, телефон, фото (команда заполнила своё)
update app.listings set cap_min = 50, cap_max = 200, district_code = 'yunusobod',
                        description_ru = 'Описание', description_uz = 'Tavsif'
 where id = 'aaaaaaaa-0000-0000-0000-000000000102';
insert into pii.listing_contacts (listing_id, public_phone) values ('aaaaaaaa-0000-0000-0000-000000000102', '+998000000998');
insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256, sort, no_faces_ack)
select 'aaaaaaaa-0000-0000-0000-000000000102', 'ready', 'approved',
       pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000102'), 'image/webp', 1000, 1600, 1200,
       sha256(convert_to('a2/' || n, 'UTF8')), n, true
from generate_series(1, 3) n;

set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select lives_ok(
  $$update app.listings set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  'владелец кабинета отправляет готовый черновик на проверку (услуги — на проверке)');
reset role;
select pg_temp.as_actor(null);
select results_eq(
  $$select recipient_id, payload from app.outbox where kind = 'ops.listing_submitted' order by recipient_id$$,
  $$values ('00000000-0000-0000-0000-00000000a001'::uuid, '{"listing_id": "aaaaaaaa-0000-0000-0000-000000000102"}'::jsonb),
           ('00000000-0000-0000-0000-00000000a003'::uuid, '{"listing_id": "aaaaaaaa-0000-0000-0000-000000000102"}'::jsonb)$$,
  'витрина на проверке — тем, кто публикует; в payload — только id');

-- Администратор возвращает в черновик и отправляет снова: сам решает — себе не оповещает
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
update app.listings set status = 'draft' where id = 'aaaaaaaa-0000-0000-0000-000000000102';
update app.listings set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-000000000102';
update app.listings set status = 'draft' where id = 'aaaaaaaa-0000-0000-0000-000000000102';
reset role;
select pg_temp.as_actor(null);
select is((select count(*)::int from app.outbox where kind = 'ops.listing_submitted'), 2,
  'отправка на проверку тем, кто сам решает, не оповещает');

-- Менеджер отправляет — модератору нужно знать
update app.outbox set status = 'sent', sent_at = now() where kind = 'ops.listing_submitted';
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
update app.listings set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-000000000102';
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
update app.listings set status = 'draft' where id = 'aaaaaaaa-0000-0000-0000-000000000102';
reset role;
select pg_temp.as_actor(null);
select is((select count(*)::int from app.outbox where kind = 'ops.listing_submitted' and status = 'pending'), 2,
  'витрину отправил менеджер — оповещение тем, кто публикует');

-- ════════════════════════════════════════════════════════════════════════════
-- Решение по услуге черновика: партнёру — только отказ
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a003');
update app.listing_services set status = 'active', decision = 'approved', decision_reason = null,
                                decided_at = clock_timestamp()
 where id = 'aaaaaaaa-0000-0000-0000-00000000d001';
reset role;
select pg_temp.as_actor(null);
select is_empty($$select id from app.outbox where kind = 'vendor.service_decided'$$,
  'одобрение услуги черновика партнёру отдельно не оповещается');
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a003');
update app.listing_services set status = 'rejected', decision = 'declined', decision_reason = 'Цена без НДС?',
                                decided_at = clock_timestamp()
 where id = 'aaaaaaaa-0000-0000-0000-00000000d002';
reset role;
select pg_temp.as_actor(null);
select results_eq(
  $$select recipient_id, payload ->> 'decision' from app.outbox where kind = 'vendor.service_decided'$$,
  $$values ('aaaaaaaa-0000-0000-0000-000000000011'::uuid, 'declined')$$,
  'отказ по услуге черновика — владельцу кабинета: причину надо прочесть');

-- ════════════════════════════════════════════════════════════════════════════
-- Что ждёт команду
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select results_eq(
  $$select services_pending, photos_pending from app.metrics_ops_now()$$,
  $$values (1, 1)$$,
  'услуги: предложение правки A1 (у отклонённой A3 — не в счёт); фото черновика A2 — тоже ждёт');
select results_eq(
  $$select listings_review, revisions_pending from app.metrics_ops_now()$$,
  $$values (0, 0)$$,
  'остальные очереди — как раньше');

set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok($$select * from app.metrics_ops_now()$$, 'BR003', 'forbidden_for_actor',
  'партнёру очереди команды не видны');
reset role;
select pg_temp.as_actor(null);

-- Правка карточки, которую некому отправить, — тоже в журнал
update pii.staff_profiles set telegram_chat_id = null;
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
insert into app.listing_revisions (listing_id, payload, base_version)
values ('aaaaaaaa-0000-0000-0000-000000000101', '{"name": "Новое имя"}', 1);
reset role;
select pg_temp.as_actor(null);
select results_eq(
  $$select object_id, detail ->> 'kind' from app.audit_log
     where action = 'outbox.no_recipients' and detail ->> 'kind' = 'ops.revision_submitted'$$,
  $$values ('aaaaaaaa-0000-0000-0000-000000000101', 'ops.revision_submitted')$$,
  'правка карточки, которую некому отправить, — в журнале с витриной');
select is((select count(*)::int from app.outbox where kind = 'ops.revision_submitted'), 0,
  'а в очереди уведомлений её нет');

select * from finish();
rollback;
