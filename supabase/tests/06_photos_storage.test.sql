-- Фото в Supabase Storage: бакет, ключи объектов, «готово» только от сервера, права
begin;
\ir _fixtures.psql
select plan(19);

-- ── бакет ───────────────────────────────────────────────────────────────────
select is((select public from storage.buckets where id = 'listing-photos'), true,
  'бакет listing-photos читается публично (варианты отдаёт воркер media)');
select is((select file_size_limit from storage.buckets where id = 'listing-photos'), 10485760::bigint,
  'файл — не больше 10 МБ');
select set_eq(
  $$select unnest(allowed_mime_types) from storage.buckets where id = 'listing-photos'$$,
  array['image/webp', 'image/jpeg', 'image/png'],
  'только WebP, JPEG и PNG');
select is_empty(
  $$select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and cmd <> 'SELECT'
      and roles && array['anon', 'authenticated', 'public']::name[]$$,
  'из браузера и Data API в Storage не записать: пишет только API ключом service_role');
select ok(not has_table_privilege('bayramm_api', 'storage.objects', 'INSERT'),
  'роль API не пишет в storage.objects SQL-ом — только через Storage API');

-- ── app.photos ──────────────────────────────────────────────────────────────
select hasnt_column('app', 'photos', 'public_prefix', 'public_prefix (варианты в R2) больше нет');
select has_index('app', 'photos', 'photos_storage_key_uq', 'один объект — одна строка');

select throws_ok(
  $$insert into app.photos (listing_id, storage_key, no_faces_ack)
    values ('aaaaaaaa-0000-0000-0000-000000000102', 'test/a2/1.webp', true)$$,
  '23514', null, 'ключ не по формату listings/<листинг>/<uuid>.<расширение>');
select throws_ok(
  $$insert into app.photos (listing_id, storage_key, no_faces_ack)
    values ('aaaaaaaa-0000-0000-0000-000000000102', pg_temp.photo_key('bbbbbbbb-0000-0000-0000-000000000101'), true)$$,
  '23514', null, 'объект под чужим листингом не привязать');
select throws_ok(
  $$insert into app.photos (listing_id, storage_key, no_faces_ack)
    values ('aaaaaaaa-0000-0000-0000-000000000102',
            'listings/aaaaaaaa-0000-0000-0000-000000000102/aaaaaaaa-0000-0000-0000-00000000f201.gif', true)$$,
  '23514', null, 'расширение — только webp, jpg, png');
select throws_ok(
  $$insert into app.photos (listing_id, status, storage_key, no_faces_ack)
    values ('aaaaaaaa-0000-0000-0000-000000000102', 'ready', pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000102'), true)$$,
  '23514', null, 'готово — только с проверенным файлом (тип, размер, размеры, sha256)');
select throws_ok(
  $$insert into app.photos (listing_id, storage_key, bytes, no_faces_ack)
    values ('aaaaaaaa-0000-0000-0000-000000000102', pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000102'),
            10485761, true)$$,
  '23514', null, 'больше 10 МБ — как и в бакете — нельзя');

insert into app.photos (listing_id, storage_key, no_faces_ack)
values ('aaaaaaaa-0000-0000-0000-000000000102',
        'listings/aaaaaaaa-0000-0000-0000-000000000102/aaaaaaaa-0000-0000-0000-00000000f202.webp', true);
select throws_ok(
  $$insert into app.photos (listing_id, storage_key, no_faces_ack)
    values ('aaaaaaaa-0000-0000-0000-000000000102',
            'listings/aaaaaaaa-0000-0000-0000-000000000102/aaaaaaaa-0000-0000-0000-00000000f202.webp', true)$$,
  '23505', null, 'на один объект — одна строка');

-- ── путь API: вендор записывает загруженное, system отмечает проверенным ────
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');

select lives_ok(
  $$insert into app.photos (id, listing_id, storage_key, mime, bytes, width, height, sha256, no_faces_ack)
    values ('aaaaaaaa-0000-0000-0000-00000000f301', 'aaaaaaaa-0000-0000-0000-000000000102',
            'listings/aaaaaaaa-0000-0000-0000-000000000102/aaaaaaaa-0000-0000-0000-00000000f301.webp',
            'image/webp', 2048, 2560, 1920, sha256('photo-301'), true)$$,
  'вендор записывает загруженное фото (uploading) с его свойствами');
select throws_ok(
  $$update app.photos set status = 'ready' where id = 'aaaaaaaa-0000-0000-0000-00000000f301'$$,
  'BR003', 'forbidden_for_actor', 'вендор сам не отмечает фото проверенным');
select throws_ok(
  $$insert into app.photos (listing_id, storage_key, sha256, no_faces_ack)
    values ('aaaaaaaa-0000-0000-0000-000000000102', pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000102'),
            sha256('photo-301'), true)$$,
  '23505', null, 'тот же файл в листинг дважды не загрузить');

select pg_temp.as_actor('system');
select lives_ok(
  $$update app.photos set status = 'ready', processed_at = now() where id = 'aaaaaaaa-0000-0000-0000-00000000f301'$$,
  'system отмечает фото проверенным');
select is(
  (select uploaded_by from app.photos where id = 'aaaaaaaa-0000-0000-0000-00000000f301'),
  'aaaaaaaa-0000-0000-0000-000000000011'::uuid,
  'автор загрузки — вендор, а не system');

select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select lives_ok(
  $$update app.photos set deleted_at = now() where id = 'aaaaaaaa-0000-0000-0000-00000000f301'$$,
  'вендор удаляет своё фото из черновика');

reset role;
select * from finish();
rollback;
