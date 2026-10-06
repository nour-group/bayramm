-- Причина отказа по фото — только у отклонённого; «Связаться» — открытия и за прошлый период
begin;
\ir _fixtures.psql
select plan(8);

select has_column('app', 'photos', 'moderation_reason', 'причина отказа по фото');

-- Четвёртое фото опубликованной A1: отклонить его можно, минимум фото останется
insert into app.photos (id, listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256, sort,
                        no_faces_ack)
values ('f0f0f0f0-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101', 'ready', 'pending',
        pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000101'), 'image/webp', 1000, 1600, 1200,
        sha256('photo-reason-4'), 4, true);

-- События «Связаться»: у A1 — сейчас и 40 дней назад, у B1 — только 40 дней назад
insert into app.contact_events (listing_id, action, source, signed_in, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000000101', 'open', 'web', false, now()),
  ('aaaaaaaa-0000-0000-0000-000000000101', 'open', 'tma', true, now() - interval '40 days'),
  ('bbbbbbbb-0000-0000-0000-000000000101', 'open', 'web', false, now() - interval '40 days');

set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');

select lives_ok(
  $$update app.photos set moderation = 'declined', moderation_reason = 'Размыто, нужен кадр при свете'
     where id = 'f0f0f0f0-0000-0000-0000-000000000001'$$,
  'модератор отклоняет фото с причиной');
select is(
  (select moderation_reason from app.photos where id = 'f0f0f0f0-0000-0000-0000-000000000001'),
  'Размыто, нужен кадр при свете', 'причина сохранена');
select throws_ok(
  $$update app.photos set moderation_reason = '   ' where id = 'f0f0f0f0-0000-0000-0000-000000000001'$$,
  '23514', null, 'пустая причина — нет');
update app.photos set moderation = 'approved' where id = 'f0f0f0f0-0000-0000-0000-000000000001';
select is(
  (select moderation_reason from app.photos where id = 'f0f0f0f0-0000-0000-0000-000000000001'),
  null, 'одобрили — причины больше нет');

select results_eq(
  $$select opens, opens_prev from app.metrics_contacts(30)
     where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  $$values (1, 1)$$,
  'открытия за период и за предыдущий такой же');
select is_empty(
  $$select * from app.metrics_contacts(30) where listing_id = 'bbbbbbbb-0000-0000-0000-000000000101'$$,
  'витрина без событий в периоде — не в списке');

select pg_temp.as_actor(null);
select throws_ok($$select * from app.metrics_contacts(30)$$, 'BR003', null, 'метрики гостю — нет');
reset role;

select * from finish();
rollback;
