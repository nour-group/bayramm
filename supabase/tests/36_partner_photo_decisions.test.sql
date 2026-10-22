-- Решения команды по фото партнёра — владельцам кабинета одним сообщением на витрину
-- (20261022090000_partner_decision_notices.sql)
begin;
\ir _fixtures.psql
select plan(11);

select is_empty(
  $$select f from unnest(array['app.photos_partner_notify()',
                               'app.enqueue_vendor_photos_notice(uuid, uuid, timestamptz)']) f
    where has_function_privilege('bayramm_api', f, 'EXECUTE')$$,
  'API не ставит сообщения о фото сам: только триггер');

-- Владелец A — с чатом бота
update app.vendor_users set tg_user_hash = sha256('tg-vendor-a'), tg_linked_at = now()
 where id = 'aaaaaaaa-0000-0000-0000-000000000011';
update pii.vendor_user_profiles set telegram_chat_id = 9101, telegram_user_id = 9101
 where vendor_user_id = 'aaaaaaaa-0000-0000-0000-000000000011';

-- Готовые фото, ждущие решения. Кто загрузил — uploaded_by = актор вставки: под актором system с
-- id партнёра — как фото партнёра после обработки (без шагов загрузки), с id сотрудника — его фото
create function pg_temp.photo(p_id uuid, p_listing uuid, p_uploader uuid) returns void
language plpgsql as $$
begin
  perform pg_temp.as_actor('system', p_uploader);
  insert into app.photos (id, listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256,
                          sort, no_faces_ack)
  values (p_id, p_listing, 'ready', 'pending', pg_temp.photo_key(p_listing), 'image/webp', 1000, 1600, 1200,
          sha256(convert_to(p_id::text, 'UTF8')), 20, true);
end $$;
select pg_temp.photo('aaaaaaaa-0000-0000-0000-00000000f001', 'aaaaaaaa-0000-0000-0000-000000000101',
                     'aaaaaaaa-0000-0000-0000-000000000011');
select pg_temp.photo('aaaaaaaa-0000-0000-0000-00000000f002', 'aaaaaaaa-0000-0000-0000-000000000101',
                     'aaaaaaaa-0000-0000-0000-000000000011');
select pg_temp.photo('aaaaaaaa-0000-0000-0000-00000000f003', 'aaaaaaaa-0000-0000-0000-000000000101',
                     'aaaaaaaa-0000-0000-0000-000000000011');
select pg_temp.photo('aaaaaaaa-0000-0000-0000-00000000f004', 'aaaaaaaa-0000-0000-0000-000000000101',
                     '00000000-0000-0000-0000-00000000a002');
select pg_temp.photo('aaaaaaaa-0000-0000-0000-00000000f005', 'aaaaaaaa-0000-0000-0000-000000000102',
                     'aaaaaaaa-0000-0000-0000-000000000011');
select pg_temp.photo('aaaaaaaa-0000-0000-0000-00000000f006', 'aaaaaaaa-0000-0000-0000-000000000102',
                     'aaaaaaaa-0000-0000-0000-000000000011');

create function pg_temp.notices(p_listing uuid) returns bigint
language sql as $$
  select count(*) from app.outbox o
  where o.kind = 'vendor.photos_decided' and o.recipient_id = 'aaaaaaaa-0000-0000-0000-000000000011'
    and o.payload ->> 'listing_id' = p_listing::text
$$;

-- Модератор одобрил фото опубликованной A1 — сообщение встаёт с паузой
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
update app.photos set moderation = 'approved' where id = 'aaaaaaaa-0000-0000-0000-00000000f001';
select is(pg_temp.notices('aaaaaaaa-0000-0000-0000-000000000101'), 1::bigint, 'одобрили фото на сайте — сообщение');
select ok(
  (select o.next_attempt_at >= now() + interval '119 seconds'
          and (o.payload ->> 'since')::timestamptz = p.moderated_at
     from app.outbox o, app.photos p
    where o.kind = 'vendor.photos_decided' and p.id = 'aaaaaaaa-0000-0000-0000-00000000f001'),
  'уходит через 2 минуты; решения считаются с первого (since)');

-- Ещё решения, пока сообщение не ушло, — в него же
update app.photos set moderation = 'declined', moderation_reason = 'Лицо в кадре'
 where id = 'aaaaaaaa-0000-0000-0000-00000000f002';
select is(pg_temp.notices('aaaaaaaa-0000-0000-0000-000000000101'), 1::bigint, 'второе решение — в то же сообщение');
-- Фото сотрудника — партнёру не о чем
update app.photos set moderation = 'declined', moderation_reason = 'Размыто'
 where id = 'aaaaaaaa-0000-0000-0000-00000000f004';
select is(pg_temp.notices('aaaaaaaa-0000-0000-0000-000000000101'), 1::bigint, 'фото сотрудника — без сообщения');

-- Сообщение ушло — следующее решение ставит новое
update app.outbox set status = 'sent', sent_at = now()
 where kind = 'vendor.photos_decided' and recipient_id = 'aaaaaaaa-0000-0000-0000-000000000011';
update app.photos set moderation = 'approved' where id = 'aaaaaaaa-0000-0000-0000-00000000f003';
select is(pg_temp.notices('aaaaaaaa-0000-0000-0000-000000000101'), 2::bigint, 'после отправки — новое сообщение');

-- Черновик A2: одобрение — без сообщения (о публикации скажет её решение), отказ — сообщение
update app.photos set moderation = 'approved' where id = 'aaaaaaaa-0000-0000-0000-00000000f005';
select is(pg_temp.notices('aaaaaaaa-0000-0000-0000-000000000102'), 0::bigint, 'одобрили фото черновика — без сообщения');
update app.photos set moderation = 'declined', moderation_reason = 'Не тот зал'
 where id = 'aaaaaaaa-0000-0000-0000-00000000f006';
select is(pg_temp.notices('aaaaaaaa-0000-0000-0000-000000000102'), 1::bigint, 'отклонили фото черновика — сообщение');

-- Не команда (система) — не решение
select pg_temp.photo('aaaaaaaa-0000-0000-0000-00000000f007', 'aaaaaaaa-0000-0000-0000-000000000101',
                     'aaaaaaaa-0000-0000-0000-000000000011');
update app.outbox set status = 'sent', sent_at = now()
 where kind = 'vendor.photos_decided' and recipient_id = 'aaaaaaaa-0000-0000-0000-000000000011';
select pg_temp.as_actor(null);
update app.photos set moderation = 'approved' where id = 'aaaaaaaa-0000-0000-0000-00000000f007';
select is(pg_temp.notices('aaaaaaaa-0000-0000-0000-000000000101'), 2::bigint, 'решение системы — без сообщения');

select is_empty(
  $$select 1 from app.outbox where kind = 'vendor.photos_decided' and recipient_id <> 'aaaaaaaa-0000-0000-0000-000000000011'$$,
  'только владельцу витрины');
select is_empty(
  $$select 1 from app.outbox where kind = 'vendor.photos_decided'
      and dedupe_key not like 'vendor.photos_decided:%'$$,
  'ключ — вид, витрина, получатель и время');

select * from finish();
rollback;
