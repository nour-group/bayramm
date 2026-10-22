-- Решения команды по витрине и по предложению изменений — владельцам кабинета в Telegram
-- (20261022090000_partner_decision_notices.sql)
begin;
\ir _fixtures.psql
select plan(16);

select is_empty(
  $$select f from unnest(array['app.listing_status_log_partner_notify()',
                               'app.listing_revisions_partner_notify()']) f
    where has_function_privilege('bayramm_api', f, 'EXECUTE')$$,
  'триггерные функции API недоступны');

-- Владелец A и сотрудник площадки A12 — с чатом бота; у вендора B чата нет
insert into app.vendor_users (id, vendor_id, phone_hash, role) values
  ('aaaaaaaa-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', sha256('vendor-a-member'), 'member');
insert into pii.vendor_user_profiles (vendor_user_id, phone) values
  ('aaaaaaaa-0000-0000-0000-000000000012', '+998000000112');
update app.vendor_users set tg_user_hash = sha256(convert_to('tg-' || id::text, 'UTF8')), tg_linked_at = now()
 where id in ('aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000012');
update pii.vendor_user_profiles set telegram_chat_id = 9101, telegram_user_id = 9101
 where vendor_user_id = 'aaaaaaaa-0000-0000-0000-000000000011';
update pii.vendor_user_profiles set telegram_chat_id = 9102, telegram_user_id = 9102
 where vendor_user_id = 'aaaaaaaa-0000-0000-0000-000000000012';

-- Витрина A3 вендора A: полная, на проверке
insert into app.listings (id, vendor_id, slug, category_code, name, district_code,
                          description_ru, description_uz, price_from_uzs, price_unit, cap_min, cap_max)
values ('aaaaaaaa-0000-0000-0000-000000000103', 'aaaaaaaa-0000-0000-0000-000000000001', 'test-a3', 'hall',
        'Test Hall A3', 'yunusobod', 'Описание', 'Tavsif', 150000, 'per_guest', 50, 300);
insert into pii.listing_contacts (listing_id, public_phone) values
  ('aaaaaaaa-0000-0000-0000-000000000103', '+998000000103');
insert into app.listing_services (listing_id, category_code, service_type, status, price_uzs, price_unit, sort) values
  ('aaaaaaaa-0000-0000-0000-000000000103', 'hall', 'banquet_weekday', 'active', 150000, 'per_guest', 1),
  ('aaaaaaaa-0000-0000-0000-000000000103', 'hall', 'banquet_weekend', 'active', 180000, 'per_guest', 2);
insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256, sort, no_faces_ack)
select 'aaaaaaaa-0000-0000-0000-000000000103', 'ready', 'approved',
       pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000103'), 'image/webp', 1000, 1600, 1200,
       sha256(convert_to('a3/' || n, 'UTF8')), n, true
from generate_series(1, 3) n;
update app.listings set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-000000000103';

create function pg_temp.decided(p_kind text, p_user uuid) returns bigint
language sql as $$
  select count(*) from app.outbox o where o.kind = p_kind and o.recipient_kind = 'vendor_user' and o.recipient_id = p_user
$$;

-- ── витрина ─────────────────────────────────────────────────────────────────

-- Партнёр отозвал с проверки и отправил снова — это не решение команды
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
update app.listings set status = 'draft' where id = 'aaaaaaaa-0000-0000-0000-000000000103';
update app.listings set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-000000000103';
select is(pg_temp.decided('vendor.listing_decided', 'aaaaaaaa-0000-0000-0000-000000000011'), 0::bigint,
  'шаги партнёра — без сообщения');

-- Команда вернула на доработку с комментарием
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select set_config('app.reason', 'Добавьте фото фасада', true);
update app.listings set status = 'draft' where id = 'aaaaaaaa-0000-0000-0000-000000000103';
select set_config('app.reason', '', true);
select is(pg_temp.decided('vendor.listing_decided', 'aaaaaaaa-0000-0000-0000-000000000011'), 1::bigint,
  'вернули на доработку — владельцу сообщение');
select results_eq(
  $$select o.payload ->> 'listing_id', s.to_status::text, s.reason
      from app.outbox o join app.listing_status_log s on s.id = (o.payload ->> 'log_id')::bigint
     where o.kind = 'vendor.listing_decided' and o.recipient_id = 'aaaaaaaa-0000-0000-0000-000000000011'$$,
  $$values ('aaaaaaaa-0000-0000-0000-000000000103'::text, 'draft'::text, 'Добавьте фото фасада'::text)$$,
  'в payload — витрина и шаг истории: статус и комментарий берутся при отправке');
select ok(
  (select o.status = 'pending' and o.channel = 'telegram' from app.outbox o
    where o.kind = 'vendor.listing_decided' and o.recipient_id = 'aaaaaaaa-0000-0000-0000-000000000011'),
  'в очереди Telegram');

-- Команда отправила на проверку — не решение; публикация и приостановка — решения
update app.listings set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-000000000103';
select is(pg_temp.decided('vendor.listing_decided', 'aaaaaaaa-0000-0000-0000-000000000011'), 1::bigint,
  '«на проверку» от команды — без сообщения');
update app.listings set status = 'active' where id = 'aaaaaaaa-0000-0000-0000-000000000103';
select is(pg_temp.decided('vendor.listing_decided', 'aaaaaaaa-0000-0000-0000-000000000011'), 2::bigint,
  'опубликовали — сообщение');
update app.listings set status = 'suspended', status_reason = 'Ремонт фасада'
 where id = 'aaaaaaaa-0000-0000-0000-000000000103';
select is(pg_temp.decided('vendor.listing_decided', 'aaaaaaaa-0000-0000-0000-000000000011'), 3::bigint,
  'приостановили — сообщение');
select is(
  (select s.reason from app.outbox o join app.listing_status_log s on s.id = (o.payload ->> 'log_id')::bigint
    where o.kind = 'vendor.listing_decided' and o.recipient_id = 'aaaaaaaa-0000-0000-0000-000000000011'
    order by s.id desc limit 1),
  'Ремонт фасада', 'причина приостановки — в шаге истории');
update app.listings set status = 'active' where id = 'aaaaaaaa-0000-0000-0000-000000000103';
select is(pg_temp.decided('vendor.listing_decided', 'aaaaaaaa-0000-0000-0000-000000000011'), 4::bigint,
  'снова на сайте после паузы — сообщение');

select is(pg_temp.decided('vendor.listing_decided', 'aaaaaaaa-0000-0000-0000-000000000012'), 0::bigint,
  'сотруднику площадки (member) — нет: только владельцам');
select is_empty(
  $$select 1 from app.outbox where kind = 'vendor.listing_decided' and recipient_id = 'bbbbbbbb-0000-0000-0000-000000000011'$$,
  'другому вендору — нет');

-- Отклонили черновик A2 — тоже решение
update app.listings set status = 'rejected', status_reason = 'Не наш формат'
 where id = 'aaaaaaaa-0000-0000-0000-000000000102';
select is(pg_temp.decided('vendor.listing_decided', 'aaaaaaaa-0000-0000-0000-000000000011'), 5::bigint,
  'отклонили — сообщение');

-- ── предложение изменений ───────────────────────────────────────────────────

select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
insert into app.listing_revisions (listing_id, payload, base_version)
select id, '{"name": "Test Hall A1 New"}', version from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000101';
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
update app.listing_revisions set status = 'declined', decision_reason = 'Название не как на вывеске'
 where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and status = 'pending';
select results_eq(
  $$select o.payload ->> 'decision', rv.decision_reason
      from app.outbox o join app.listing_revisions rv on rv.id = (o.payload ->> 'revision_id')::uuid
     where o.kind = 'vendor.revision_decided' and o.recipient_id = 'aaaaaaaa-0000-0000-0000-000000000011'$$,
  $$values ('declined'::text, 'Название не как на вывеске'::text)$$,
  'предложение партнёра отклонили — владельцу сообщение с id предложения');

-- Предложение сотрудника — не партнёра: решение по нему партнёру не пишем
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
insert into app.listing_revisions (listing_id, payload, base_version)
select id, '{"description_ru": "Новое описание"}', version from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000101';
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
update app.listing_revisions set status = 'declined', decision_reason = 'Позже'
 where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and status = 'pending';
select is(pg_temp.decided('vendor.revision_decided', 'aaaaaaaa-0000-0000-0000-000000000011'), 1::bigint,
  'предложение сотрудника — без сообщения партнёру');

-- Решение без сотрудника (система) — не решение команды
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
insert into app.listing_revisions (listing_id, payload, base_version)
select id, '{"description_uz": "Yangi tavsif"}', version from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000101';
select pg_temp.as_actor(null);
update app.listing_revisions set status = 'declined', decision_reason = 'Служебно'
 where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and status = 'pending';
select is(pg_temp.decided('vendor.revision_decided', 'aaaaaaaa-0000-0000-0000-000000000011'), 1::bigint,
  'решение системы — без сообщения');

select * from finish();
rollback;
