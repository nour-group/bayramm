-- Кабинет партнёра и честность модерации: роли owner/member, фото из кабинета —
-- команде, прошедшие дни и версия календаря, правки опубликованной карточки
-- менеджером — только правкой, чистка строк удалённых фото
begin;
\ir _fixtures.psql
select plan(58);

-- ════════════════════════════════════════════════════════════════════════════
-- Права
-- ════════════════════════════════════════════════════════════════════════════
select ok(
  has_function_privilege('bayramm_api', 'app.availability_lock(uuid, int)', 'EXECUTE')
  and has_function_privilege('bayramm_api', 'app.purge_deleted_photos(uuid[])', 'EXECUTE')
  and has_function_privilege('bayramm_api', 'app.edits_listing(uuid)', 'EXECUTE')
  and has_function_privilege('bayramm_api', 'app.actor_is_vendor_owner()', 'EXECUTE'),
  'API: блокировка версии календаря, чистка фото и функции политик');
select is_empty(
  $$select f from unnest(array['app.staff_can_moderate()', 'app.actor_proposes()', 'app.photos_notify()',
                               'app.availability_bump_version()']) f
    where has_function_privilege('bayramm_api', f, 'EXECUTE')$$,
  'служебные и триггерные функции API недоступны');
select ok(not has_table_privilege('bayramm_api', 'app.availability_versions', 'INSERT')
          and not has_table_privilege('bayramm_api', 'app.availability_versions', 'UPDATE')
          and has_table_privilege('bayramm_api', 'app.availability_versions', 'SELECT'),
  'версию календаря API только читает: пишет триггер');

-- Сотрудник площадки (member) у вендора A; модератор …a003; у команды — чаты с ботом
insert into app.vendor_users (id, vendor_id, phone_hash, role) values
  ('aaaaaaaa-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', sha256('vendor-a-member'), 'member');
insert into app.staff (id, role) values ('00000000-0000-0000-0000-00000000a003', 'moderator');
insert into pii.staff_profiles (staff_id, display_name) values ('00000000-0000-0000-0000-00000000a003', 'Moderator');
update pii.staff_profiles set telegram_chat_id = 9000 + right(staff_id::text, 1)::int
where staff_id in ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a002',
                   '00000000-0000-0000-0000-00000000a003');

-- ════════════════════════════════════════════════════════════════════════════
-- Роли партнёра: карточку меняет владелец, календарь ведут оба
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001');
select ok(not app.actor_is_vendor_owner(), 'сотрудник площадки — не владелец');
select ok(app.owns_listing('aaaaaaaa-0000-0000-0000-000000000101')
          and not app.edits_listing('aaaaaaaa-0000-0000-0000-000000000101'),
  'свою площадку сотрудник видит, но не меняет');
select throws_ok(
  $$insert into app.listing_revisions (listing_id, payload, base_version)
    values ('aaaaaaaa-0000-0000-0000-000000000101', '{"price_from_uzs": 170000}', 1)$$,
  '42501', null, 'сотрудник площадки не предлагает правку карточки');
select throws_ok(
  $$insert into app.photos (listing_id, storage_key, no_faces_ack)
    values ('aaaaaaaa-0000-0000-0000-000000000101', pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000101'), true)$$,
  '42501', null, 'сотрудник площадки не загружает фото');
-- Правки фото и черновика сотрудником площадки RLS молча отбрасывает (0 строк)
update app.photos set sort = 42 where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101';
update app.listings set address_ru = 'Другой адрес' where id = 'aaaaaaaa-0000-0000-0000-000000000102';
select throws_ok(
  $$insert into app.listing_packages (listing_id, kind, name_ru, name_uz, price_uzs)
    values ('aaaaaaaa-0000-0000-0000-000000000102', 'weekday', 'Будни', 'Ish kuni', 1000)$$,
  '42501', null, 'пакеты черновика сотрудник площадки не меняет');
select lives_ok(
  $$insert into app.availability (listing_id, day) values ('aaaaaaaa-0000-0000-0000-000000000101', current_date + 40)$$,
  'календарь сотрудник площадки ведёт');
select lives_ok(
  $$update app.requests set status = 'viewed' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'и заявки тоже');

select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select ok(app.actor_is_vendor_owner() and app.edits_listing('aaaaaaaa-0000-0000-0000-000000000101'),
  'владелец кабинета меняет свою площадку');
select ok(not app.edits_listing('bbbbbbbb-0000-0000-0000-000000000101'), 'чужую — нет');
update app.listings set address_ru = 'Адрес владельца' where id = 'aaaaaaaa-0000-0000-0000-000000000102';
reset role;
select results_eq(
  $$select address_ru from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  $$values ('Адрес владельца'::text)$$,
  'черновик меняет владелец, правка сотрудника площадки не прошла');
select is(
  (select count(*)::int from app.photos where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and sort = 42),
  0, 'порядок фото сотрудник площадки не меняет');

-- Отключённый владелец — уже не владелец
select pg_temp.as_actor(null);
update app.vendor_users set disabled_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000011';
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select ok(not app.actor_is_vendor_owner(), 'отключённый пользователь — не владелец');
reset role;
select pg_temp.as_actor(null);
update app.vendor_users set disabled_at = null where id = 'aaaaaaaa-0000-0000-0000-000000000011';

-- ════════════════════════════════════════════════════════════════════════════
-- Фото из кабинета — команде
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select lives_ok(
  $$insert into app.photos (id, listing_id, storage_key, no_faces_ack)
    values ('f0f0f0f0-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101',
            pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000101'), true),
           ('f0f0f0f0-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000101',
            pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000101'), true)$$,
  'владелец загружает фото опубликованной площадки');
select lives_ok(
  $$insert into app.photos (id, listing_id, storage_key, no_faces_ack)
    values ('f0f0f0f0-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000102',
            pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000102'), true)$$,
  'и черновика');
reset role;
select results_eq(
  $$select recipient_id, payload from app.outbox where kind = 'ops.photos_submitted' order by recipient_id$$,
  $$values ('00000000-0000-0000-0000-00000000a001'::uuid, '{"listing_id": "aaaaaaaa-0000-0000-0000-000000000101"}'::jsonb),
           ('00000000-0000-0000-0000-00000000a003'::uuid, '{"listing_id": "aaaaaaaa-0000-0000-0000-000000000101"}'::jsonb)$$,
  'оповещение — администратору и модератору, одно в час на площадку; фото черновика — без оповещения');
select results_eq(
  $$select moderation::text from app.photos where id = 'f0f0f0f0-0000-0000-0000-000000000001'$$,
  $$values ('pending')$$,
  'фото из кабинета ждёт решения модератора');

set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select lives_ok(
  $$insert into app.photos (listing_id, storage_key, no_faces_ack)
    values ('bbbbbbbb-0000-0000-0000-000000000101', pg_temp.photo_key('bbbbbbbb-0000-0000-0000-000000000101'), true)$$,
  'администратор загружает фото опубликованной площадки');
reset role;
select is(
  (select count(*)::int from app.outbox where kind = 'ops.photos_submitted'
     and payload ->> 'listing_id' = 'bbbbbbbb-0000-0000-0000-000000000101'),
  0, 'фото от того, кто сам решает, команде не оповещается');

-- ════════════════════════════════════════════════════════════════════════════
-- Правки опубликованной карточки: менеджер — правкой, модератор и админ — сразу
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok(
  $$update app.listing_services set price_uzs = 999000 where listing_id = 'bbbbbbbb-0000-0000-0000-000000000101'$$,
  'BR005', 'moderated_field_requires_revision', 'менеджер не меняет цену опубликованной карточки сразу');
select throws_ok(
  $$update app.listings set description_uz = 'Boshqa' where id = 'bbbbbbbb-0000-0000-0000-000000000101'$$,
  'BR005', 'moderated_field_requires_revision', 'и описание');
select throws_ok(
  $$update app.listing_packages set price_uzs = 1 where listing_id = 'bbbbbbbb-0000-0000-0000-000000000101'$$,
  'BR005', 'moderated_field_requires_revision', 'и пакеты');
select lives_ok(
  $$update app.listings set cap_max = 260, address_ru = 'Новый адрес' where id = 'bbbbbbbb-0000-0000-0000-000000000101'$$,
  'адрес и вместимость — сразу');
select lives_ok(
  $$update app.listings set price_from_uzs = 777000 where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  'черновик менеджер правит сразу');
select lives_ok(
  $$insert into app.listing_revisions (listing_id, payload, base_version)
    select id, '{"price_from_uzs": 130000}', version from app.listings where id = 'bbbbbbbb-0000-0000-0000-000000000101'$$,
  'правку опубликованной карточки менеджер предлагает');
reset role;
select results_eq(
  $$select o.recipient_id from app.outbox o join app.listing_revisions r on o.payload ->> 'revision_id' = r.id::text
     where o.kind = 'ops.revision_submitted' and r.listing_id = 'bbbbbbbb-0000-0000-0000-000000000101'
     order by o.recipient_id$$,
  $$values ('00000000-0000-0000-0000-00000000a001'::uuid), ('00000000-0000-0000-0000-00000000a003'::uuid)$$,
  'правку менеджера получают те, кто решает: администратор и модератор');

set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'bbbbbbbb-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001');
select throws_ok(
  $$update app.listing_revisions set status = 'withdrawn' where listing_id = 'bbbbbbbb-0000-0000-0000-000000000101'$$,
  'BR003', 'forbidden_for_actor', 'правку команды партнёр не отзывает');

select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a003');
select lives_ok(
  $$update app.listings set price_from_uzs = 130000 where id = 'bbbbbbbb-0000-0000-0000-000000000101'$$,
  'модератор применяет цену сразу');
select lives_ok(
  $$update app.listing_revisions set status = 'approved' where listing_id = 'bbbbbbbb-0000-0000-0000-000000000101'$$,
  'и одобряет правку');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select lives_ok(
  $$update app.listing_packages set price_uzs = 190000
     where listing_id = 'bbbbbbbb-0000-0000-0000-000000000101' and kind = 'weekend'$$,
  'администратор меняет пакеты опубликованной карточки сразу');

-- Партнёр отзывает свою правку, как раньше
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select lives_ok(
  $$insert into app.listing_revisions (listing_id, payload, base_version)
    select id, '{"name": "Новое имя"}', version from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'владелец предлагает правку');
select lives_ok(
  $$update app.listing_revisions set status = 'withdrawn' where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'и отзывает свою');
reset role;

-- ════════════════════════════════════════════════════════════════════════════
-- Календарь: прошедшие дни неизменны
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$insert into app.availability (listing_id, day) values ('aaaaaaaa-0000-0000-0000-000000000101', app.tashkent_today() - 1)$$,
  'BR024', 'date_out_of_range', 'вендор не отмечает прошедший день');
select lives_ok(
  $$insert into app.availability (listing_id, day) values ('aaaaaaaa-0000-0000-0000-000000000101', app.tashkent_today())$$,
  'сегодня по Ташкенту — ещё можно');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok(
  $$insert into app.availability (listing_id, day, source) values ('aaaaaaaa-0000-0000-0000-000000000101', app.tashkent_today() - 3, 'staff')$$,
  'BR024', 'date_out_of_range', 'сотрудник тоже');
select pg_temp.as_actor('system');
select throws_ok(
  $$insert into app.availability (listing_id, day, source) values ('aaaaaaaa-0000-0000-0000-000000000101', app.tashkent_today() - 3, 'staff')$$,
  'BR024', 'date_out_of_range', 'и система');
reset role;

-- День, который стал прошедшим: отметка осталась с того времени, когда он был будущим
set local session_replication_role = replica;
insert into app.availability (listing_id, day, source) values
  ('aaaaaaaa-0000-0000-0000-000000000101', app.tashkent_today() - 2, 'vendor'),
  ('aaaaaaaa-0000-0000-0000-000000000102', app.tashkent_today() - 2, 'vendor');
set local session_replication_role = origin;

set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$delete from app.availability where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and day = app.tashkent_today() - 2$$,
  'BR024', 'date_out_of_range', 'прошедший день не освободить');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok(
  $$update app.availability set source = 'staff'
     where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and day = app.tashkent_today() - 2$$,
  'BR024', 'date_out_of_range', 'и не поправить');
reset role;
select pg_temp.as_actor(null);
select throws_ok(
  $$delete from app.availability where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and day = app.tashkent_today() - 2$$,
  'BR024', 'date_out_of_range', 'даже ручным SQL');
delete from app.photos where listing_id = 'aaaaaaaa-0000-0000-0000-000000000102';
select lives_ok(
  $$delete from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000102'$$,
  'удаление листинга уносит и прошедшие дни (каскад — не правка календаря)');
select is(
  (select count(*)::int from app.availability where listing_id = 'aaaaaaaa-0000-0000-0000-000000000102')
  + (select count(*)::int from app.availability_versions where listing_id = 'aaaaaaaa-0000-0000-0000-000000000102'),
  0, 'ни отметок, ни версии');

-- Отказ «занято» по прошедшей дате: заявка ещё открыта до ночного истечения
set local session_replication_role = replica;
update app.requests set event_date = app.tashkent_today() - 1 where id = 'eeeeeeee-0000-0000-0000-0000000000b1';
set local session_replication_role = origin;
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'bbbbbbbb-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001');
select lives_ok(
  $$update app.requests set status = 'declined', decline_reason = 'busy' where id = 'eeeeeeee-0000-0000-0000-0000000000b1'$$,
  'отказ «занято» по прошедшей дате проходит');
select is(
  (select count(*)::int from app.availability where listing_id = 'bbbbbbbb-0000-0000-0000-000000000101'),
  0, 'и прошедший день не занимает');
select lives_ok(
  $$update app.requests set status = 'contacted' where id = 'eeeeeeee-0000-0000-0000-0000000000b1'$$,
  '«вернуть в активные» тоже проходит');
reset role;

-- ════════════════════════════════════════════════════════════════════════════
-- Версия календаря
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'bbbbbbbb-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001');
select is(app.availability_lock('bbbbbbbb-0000-0000-0000-000000000101', 0), 0,
  'календарь ещё не меняли — версия 0');
insert into app.availability (listing_id, day) values ('bbbbbbbb-0000-0000-0000-000000000101', current_date + 20);
select is(
  (select version from app.availability_versions where listing_id = 'bbbbbbbb-0000-0000-0000-000000000101'),
  1, 'отметка дня — версия 1');
select throws_ok(
  $$select app.availability_lock('bbbbbbbb-0000-0000-0000-000000000101', 0)$$,
  'BR025', 'calendar_conflict', 'правка от устаревшей версии — конфликт');
select is(app.availability_lock('bbbbbbbb-0000-0000-0000-000000000101', 1), 1, 'от текущей — проходит');
delete from app.availability where listing_id = 'bbbbbbbb-0000-0000-0000-000000000101' and day = current_date + 20;
select is(
  (select version from app.availability_versions where listing_id = 'bbbbbbbb-0000-0000-0000-000000000101'),
  2, 'снятие отметки — тоже новая версия');
select throws_ok(
  $$select app.availability_lock('aaaaaaaa-0000-0000-0000-000000000101', 0)$$,
  '42501', null, 'чужой календарь не заблокировать');

-- Отказ «занято» по будущей дате — тоже правка календаря (RA: C1 → A1, через 60 дней)
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select is(
  (select version from app.availability_versions where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  2, 'отметки сотрудника площадки и владельца — две правки, отказы базы версию не трогают');
select lives_ok(
  $$update app.requests set status = 'declined', decline_reason = 'busy' where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'отказ «занято» по будущей дате');
select is(
  (select version from app.availability_versions where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  3, 'отказ занял дату — версия выросла: открытый календарь в кабинете получит конфликт');
reset role;

-- ════════════════════════════════════════════════════════════════════════════
-- Чистка строк удалённых фото
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_actor(null);
update app.photos set deleted_at = now() - interval '40 days' where id = 'f0f0f0f0-0000-0000-0000-000000000001';
update app.photos set deleted_at = now() - interval '10 days' where id = 'f0f0f0f0-0000-0000-0000-000000000002';
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$select app.purge_deleted_photos(array['f0f0f0f0-0000-0000-0000-000000000001']::uuid[])$$,
  'BR003', 'forbidden_for_actor', 'чистит только система');
select pg_temp.as_actor('system');
select is(
  app.purge_deleted_photos(array['f0f0f0f0-0000-0000-0000-000000000001', 'f0f0f0f0-0000-0000-0000-000000000002',
                                 'f0f0f0f0-0000-0000-0000-000000000003']::uuid[]),
  1, 'удалена только строка, удалённая больше 30 дней назад');
reset role;
select results_eq(
  $$select id from app.photos where id in ('f0f0f0f0-0000-0000-0000-000000000001', 'f0f0f0f0-0000-0000-0000-000000000002')$$,
  $$values ('f0f0f0f0-0000-0000-0000-000000000002'::uuid)$$,
  'недавно удалённая строка осталась');

select * from finish();
rollback;
