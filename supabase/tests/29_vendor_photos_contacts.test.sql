-- Партнёр сам ведёт фото и публичные контакты витрины (20261012100000_vendor_photos_contacts.sql):
-- обложка — только одобренное фото, «отозвать с проверки», контакты напрямую вне сайта и запросом
-- на сайте, решение команды, журнал без номеров, чтение значений в журнал доступа к ПДн
begin;
\ir _fixtures.psql
select plan(59);

-- ════════════════════════════════════════════════════════════════════════════
-- Права
-- ════════════════════════════════════════════════════════════════════════════
select ok(
  has_function_privilege('bayramm_api', 'app.vendor_submit_contact_change(uuid, text, text)', 'EXECUTE')
  and has_function_privilege('bayramm_api', 'app.vendor_withdraw_contact_change(uuid)', 'EXECUTE')
  and has_function_privilege('bayramm_api', 'app.staff_approve_contact_change(uuid)', 'EXECUTE')
  and has_function_privilege('bayramm_api', 'app.staff_decline_contact_change(uuid, text)', 'EXECUTE')
  and has_function_privilege('bayramm_api', 'pii.read_listing_contact_change(uuid, text)', 'EXECUTE')
  and has_function_privilege('bayramm_api', 'app.contact_change_state(uuid)', 'EXECUTE')
  and has_function_privilege('bayramm_api', 'app.staff_contact_changes(int, int)', 'EXECUTE'),
  'API: подать, отозвать, одобрить, отклонить, прочитать, состояние и очередь запросов');
select is_empty(
  $$select f from unnest(array['app.photos_vendor_guard()', 'app.listing_contacts_vendor_guard()',
                               'app.listing_contacts_vendor_audit()']) f
    where has_function_privilege('bayramm_api', f, 'EXECUTE')$$,
  'триггерные функции API недоступны');
select ok(not has_table_privilege('bayramm_api', 'pii.listing_contact_changes', 'SELECT')
          and not has_table_privilege('bayramm_api', 'pii.listing_contact_changes', 'INSERT')
          and not has_table_privilege('bayramm_api', 'pii.listing_contact_changes', 'UPDATE'),
  'таблицу запросов API не видит: только функции');

-- Сотрудник площадки (member) у вендора A, модератор …a003, чаты с ботом у команды и у владельца A
insert into app.vendor_users (id, vendor_id, phone_hash, role) values
  ('aaaaaaaa-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', sha256('vendor-a-member'), 'member');
insert into app.staff (id, role) values ('00000000-0000-0000-0000-00000000a003', 'moderator');
insert into pii.staff_profiles (staff_id, display_name) values ('00000000-0000-0000-0000-00000000a003', 'Moderator');
update pii.staff_profiles set telegram_chat_id = 9000 + right(staff_id::text, 1)::int
where staff_id in ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a002',
                   '00000000-0000-0000-0000-00000000a003');
update app.vendor_users set tg_user_hash = sha256('tg-vendor-a'), tg_linked_at = now()
 where id = 'aaaaaaaa-0000-0000-0000-000000000011';
update pii.vendor_user_profiles set telegram_chat_id = 9101, telegram_user_id = 9101
 where vendor_user_id = 'aaaaaaaa-0000-0000-0000-000000000011';

-- Витрина A3 вендора A: на проверке, с контактами и тремя одобренными фото; фото A1 — одобренные
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
-- и ждущее решения фото A1
insert into app.photos (id, listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256, sort, no_faces_ack)
values ('aaaaaaaa-0000-0000-0000-00000000f001', 'aaaaaaaa-0000-0000-0000-000000000101', 'ready', 'pending',
        pg_temp.photo_key('aaaaaaaa-0000-0000-0000-000000000101'), 'image/webp', 1000, 1600, 1200,
        sha256(convert_to('a1/pending', 'UTF8')), 9, true);
update app.listings set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-000000000103';

-- ════════════════════════════════════════════════════════════════════════════
-- Фото: порядок и обложка
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select lives_ok(
  $$update app.photos set sort = 10 + sort where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and moderation = 'approved'$$,
  'владелец меняет порядок одобренных фото');
select lives_ok(
  $$update app.photos set is_cover = true
    where id = (select id from app.photos where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'
                and moderation = 'approved' order by sort limit 1)$$,
  'владелец выбирает обложкой одобренное фото');
select throws_ok(
  $$update app.photos set is_cover = true where id = 'aaaaaaaa-0000-0000-0000-00000000f001'$$,
  'BR003', null, 'ждущее решения фото обложкой не стать (BR003)');

select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001');
update app.photos set sort = 77 where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101';
reset role;
select pg_temp.as_actor(null);
select is((select count(*)::int from app.photos where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and sort = 77),
  0, 'сотрудник площадки порядок не меняет: RLS отбрасывает правку');

-- ════════════════════════════════════════════════════════════════════════════
-- «Отозвать с проверки»: review → draft разрешён партнёру, active → draft — нет
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$update app.listings set status = 'draft' where id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR002', null, 'опубликованную витрину в черновик не вернуть: такого перехода нет');
select lives_ok(
  $$update app.listings set status = 'draft' where id = 'aaaaaaaa-0000-0000-0000-000000000103'$$,
  'владелец отзывает витрину с проверки: review → draft');
select is((select status::text from app.listings where id = 'aaaaaaaa-0000-0000-0000-000000000103'), 'draft',
  'витрина — черновик, очередь проверки её больше не содержит');
reset role;
select pg_temp.as_actor(null);
select is((select count(*)::int from app.listings where status = 'review'), 0, 'на проверке витрин нет');

-- ════════════════════════════════════════════════════════════════════════════
-- Контакты на витрине вне сайта: напрямую
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select lives_ok(
  $$update pii.listing_contacts set public_phone = '+998000000104', public_telegram = 'lola_zali'
    where listing_id = 'aaaaaaaa-0000-0000-0000-000000000103'$$,
  'черновик: владелец меняет телефон и Telegram сразу');
select lives_ok(
  $$insert into pii.listing_contacts (listing_id, public_phone)
    values ('aaaaaaaa-0000-0000-0000-000000000102', '+998000000102')$$,
  'черновик без контактов: владелец вписывает телефон');
reset role;
select pg_temp.as_actor(null);
select results_eq(
  $$select action, object_id, detail from app.audit_log
    where actor_kind = 'vendor_user' and action like 'listing_contact.%' order by id$$,
  $$values ('listing_contact.update', 'aaaaaaaa-0000-0000-0000-000000000103', '{"fields": ["phone", "telegram"]}'::jsonb),
           ('listing_contact.create', 'aaaaaaaa-0000-0000-0000-000000000102', '{"fields": ["phone"]}'::jsonb)$$,
  'запись партнёра — в журнале: какие поля, без значений');

-- ════════════════════════════════════════════════════════════════════════════
-- Контакты на сайте: прямая запись закрыта, только запросом
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$update pii.listing_contacts set public_phone = '+998000000555'
    where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR036', null, 'опубликованная витрина: телефон напрямую не меняется (BR036)');
select throws_ok(
  $$update pii.listing_contacts set public_telegram = 'hacker_name'
    where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR036', null, 'и Telegram — тоже');
select throws_ok(
  $$delete from pii.listing_contacts where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  'BR036', null, 'и убрать контакты нельзя');
select throws_ok(
  $$select app.vendor_submit_contact_change('aaaaaaaa-0000-0000-0000-000000000102', '+998000000200', null)$$,
  'BR038', null, 'запрос подают только на проверке или на сайте: у черновика контакты сохраняются сразу (BR038)');

-- Подать запрос: владелец
select isnt(
  app.vendor_submit_contact_change('aaaaaaaa-0000-0000-0000-000000000101', '+998000000555', 'lola_zali'),
  null, 'владелец подаёт запрос на смену контактов опубликованной витрины');
select is(
  app.vendor_submit_contact_change('aaaaaaaa-0000-0000-0000-000000000101', '+998000000999', null),
  null, 'те же значения, что сейчас, — запрос не нужен (null)');
select throws_ok(
  $$select app.vendor_submit_contact_change('aaaaaaaa-0000-0000-0000-000000000101', null, 'lola_zali')$$,
  '22023', null, 'телефон обязателен');
select throws_ok(
  $$select app.vendor_submit_contact_change('aaaaaaaa-0000-0000-0000-000000000101', '+99890', null)$$,
  '23514', null, 'телефон не нормального вида — проверка таблицы');
select throws_ok(
  $$select app.vendor_submit_contact_change('aaaaaaaa-0000-0000-0000-000000000101', '+998000000555', 'x')$$,
  '23514', null, 'Telegram не по правилам — проверка таблицы');
reset role;
select pg_temp.as_actor(null);
select is((select count(*)::int from pii.listing_contact_changes
           where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and status = 'pending'), 1,
  'ждущий запрос один');

-- Другой вендор, сотрудник площадки
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001');
select throws_ok(
  $$select app.vendor_submit_contact_change('aaaaaaaa-0000-0000-0000-000000000101', '+998000000556', null)$$,
  'BR003', null, 'сотрудник площадки запрос не подаёт');
select pg_temp.as_actor('vendor_user', 'bbbbbbbb-0000-0000-0000-000000000011', 'bbbbbbbb-0000-0000-0000-000000000001');
select throws_ok(
  $$select app.vendor_submit_contact_change('aaaaaaaa-0000-0000-0000-000000000101', '+998000000556', null)$$,
  'BR003', null, 'чужой вендор запрос на чужую витрину не подаёт');
select is((select count(*)::int from app.contact_change_state('aaaaaaaa-0000-0000-0000-000000000101')), 0,
  'и состояния чужого запроса не видит');
select is((select count(*)::int from pii.read_listing_contact_change('aaaaaaaa-0000-0000-0000-000000000101')), 0,
  'и значений не читает');

-- Подать ещё раз — заменяет ждущий
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select isnt(
  app.vendor_submit_contact_change('aaaaaaaa-0000-0000-0000-000000000101', '+998000000557', 'lola_zali'),
  null, 'новая отправка заменяет ждущий запрос');
select results_eq(
  $$select status, phone_changed, telegram_changed from app.contact_change_state('aaaaaaaa-0000-0000-0000-000000000101')$$,
  $$values ('pending'::text, true, true)$$,
  'состояние: ждёт, меняются телефон и Telegram (значений нет)');
reset role;
select pg_temp.as_actor(null);
select results_eq(
  $$select status, public_phone, public_telegram from pii.listing_contact_changes
    where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' order by created_at$$,
  $$values ('pending'::text, '+998000000557'::text, 'lola_zali'::text)$$,
  'в таблице — одна ждущая строка с новыми значениями');
select results_eq(
  $$select recipient_id, payload from app.outbox where kind = 'ops.contact_change_submitted' order by recipient_id$$,
  $$values ('00000000-0000-0000-0000-00000000a001'::uuid, '{"listing_id": "aaaaaaaa-0000-0000-0000-000000000101"}'::jsonb),
           ('00000000-0000-0000-0000-00000000a003'::uuid, '{"listing_id": "aaaaaaaa-0000-0000-0000-000000000101"}'::jsonb)$$,
  'команде — администратору и модератору, в payload только id витрины (второе ждущее не дублируется)');
-- change_id — случайный uuid: в его последней части бывает девять цифр подряд, номер это не он
select is((select count(*)::int from app.audit_log
           where action = 'listing_contact_change.submit'
             and (detail - 'change_id')::text ~ '[0-9]{9}|lola_zali'), 0,
  'в журнале подачи — ни номеров, ни имени Telegram');
select results_eq(
  $$select detail ->> 'fields' from app.audit_log where action = 'listing_contact_change.submit' order by id limit 1$$,
  $$values ('["phone", "telegram"]')$$,
  'в журнале — какие поля меняются');

-- Чтение значений: сотрудник — в журнал доступа к ПДн
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
set local role bayramm_api;
select throws_ok(
  $$select * from pii.read_listing_contact_change('aaaaaaaa-0000-0000-0000-000000000101')$$,
  'BR003', null, 'менеджер значений запроса не читает');
select throws_ok(
  $$select app.staff_approve_contact_change('aaaaaaaa-0000-0000-0000-000000000101')$$,
  'BR003', null, 'менеджер запрос не решает');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select results_eq(
  $$select phone, telegram from pii.read_listing_contact_change('aaaaaaaa-0000-0000-0000-000000000101', 'проверка')$$,
  $$values ('+998000000557'::text, 'lola_zali'::text)$$,
  'администратор читает значения запроса');
select results_eq(
  $$select count(*)::int from app.contact_change_state('aaaaaaaa-0000-0000-0000-000000000101')$$,
  $$values (1)$$, 'и состояние');
select results_eq(
  $$select listing_id, vendor_code, phone_changed, telegram_changed, total from app.staff_contact_changes()$$,
  $$values ('aaaaaaaa-0000-0000-0000-000000000101'::uuid, (select public_code from app.vendor_accounts
            where id = 'aaaaaaaa-0000-0000-0000-000000000001'), true, true, 1::bigint)$$,
  'очередь ждущих запросов — без значений');
reset role;
select pg_temp.as_actor(null);
select results_eq(
  $$select actor_kind::text, subject_kind, subject_id, purpose, reason from app.pii_access_log
    where subject_kind = 'listing_contact' and purpose = 'staff_contact_change'$$,
  $$values ('staff', 'listing_contact', 'aaaaaaaa-0000-0000-0000-000000000101'::uuid, 'staff_contact_change', 'проверка')$$,
  'чтение значений — в журнал доступа к ПДн');

-- Владелец читает свой запрос — тоже в журнал
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select results_eq(
  $$select phone from pii.read_listing_contact_change('aaaaaaaa-0000-0000-0000-000000000101')$$,
  $$values ('+998000000557'::text)$$, 'владелец видит свой ждущий запрос');
reset role;
select pg_temp.as_actor(null);
select is((select count(*)::int from app.pii_access_log where purpose = 'self_contact_change'), 1,
  'и это — в журнале');

-- Отозвать
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select lives_ok($$select app.vendor_withdraw_contact_change('aaaaaaaa-0000-0000-0000-000000000101')$$,
  'владелец отзывает ждущий запрос');
select throws_ok($$select app.vendor_withdraw_contact_change('aaaaaaaa-0000-0000-0000-000000000101')$$,
  'BR037', null, 'второй раз — ждущего запроса нет (BR037)');
reset role;
select pg_temp.as_actor(null);
select results_eq(
  $$select status, public_phone, public_telegram from pii.listing_contact_changes
    where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'$$,
  $$values ('withdrawn'::text, null::text, null::text)$$,
  'отозванный запрос — без значений');

-- Одобрить
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select isnt(app.vendor_submit_contact_change('aaaaaaaa-0000-0000-0000-000000000101', '+998000000600', 'zal_lola'), null,
  'после отзыва — новый запрос');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a003');
select lives_ok($$select app.staff_approve_contact_change('aaaaaaaa-0000-0000-0000-000000000101')$$,
  'модератор одобряет запрос');
select throws_ok($$select app.staff_approve_contact_change('aaaaaaaa-0000-0000-0000-000000000101')$$,
  'BR037', null, 'второй раз — решать нечего');
reset role;
select pg_temp.as_actor(null);
select results_eq(
  $$select (select public_phone from pii.listing_contacts where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
           (select public_telegram from pii.listing_contacts where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101')$$,
  $$values ('+998000000600'::text, 'zal_lola'::text)$$,
  'одобрено: контакты витрины — новые');
select results_eq(
  $$select status, public_phone, decided_by is not null, decided_at is not null from pii.listing_contact_changes
    where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101' and status = 'approved'$$,
  $$values ('approved'::text, null::text, true, true)$$,
  'запрос закрыт: кто решил и когда, значений нет');
select results_eq(
  $$select recipient_id, payload from app.outbox where kind = 'vendor.contact_change_decided'$$,
  $$values ('aaaaaaaa-0000-0000-0000-000000000011'::uuid,
            '{"listing_id": "aaaaaaaa-0000-0000-0000-000000000101", "decision": "approved"}'::jsonb)$$,
  'владельцу кабинета — решение (id витрины и решение)');
select is((select count(*)::int from app.audit_log
           where action like 'listing_contact_change.%'
             and (detail - 'change_id')::text ~ '[0-9]{9}|zal_lola|lola_zali'), 0,
  'в журнале решений номеров нет');

-- Отклонить — только с причиной
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select isnt(app.vendor_submit_contact_change('aaaaaaaa-0000-0000-0000-000000000101', '+998000000700', null), null,
  'ещё один запрос');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok($$select app.staff_decline_contact_change('aaaaaaaa-0000-0000-0000-000000000101', '  ')$$,
  'BR010', null, 'отказ без причины не принимается');
select lives_ok($$select app.staff_decline_contact_change('aaaaaaaa-0000-0000-0000-000000000101', 'Номер не принадлежит залу')$$,
  'администратор отклоняет с причиной');
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select results_eq(
  $$select status, reason, phone_changed from app.contact_change_state('aaaaaaaa-0000-0000-0000-000000000101')$$,
  $$values ('declined'::text, 'Номер не принадлежит залу'::text, false)$$,
  'партнёр видит последний ответ: отказ с причиной');
reset role;
select pg_temp.as_actor(null);
select is((select public_phone from pii.listing_contacts where listing_id = 'aaaaaaaa-0000-0000-0000-000000000101'),
  '+998000000600', 'после отказа у витрины прежние контакты');

-- Витрина вышла с сайта (A3 — черновик после отзыва с проверки): ждущий запрос уходит
update app.listings set status = 'review' where id = 'aaaaaaaa-0000-0000-0000-000000000103';
set local role bayramm_api;
select pg_temp.as_actor('vendor_user', 'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001');
select isnt(app.vendor_submit_contact_change('aaaaaaaa-0000-0000-0000-000000000103', '+998000000900', null), null,
  'витрина на проверке: запрос принят');
update app.listings set status = 'draft' where id = 'aaaaaaaa-0000-0000-0000-000000000103';
update pii.listing_contacts set public_phone = '+998000000901' where listing_id = 'aaaaaaaa-0000-0000-0000-000000000103';
reset role;
select pg_temp.as_actor(null);
select is((select status from pii.listing_contact_changes
           where listing_id = 'aaaaaaaa-0000-0000-0000-000000000103'), 'withdrawn',
  'отозвала с проверки и поправила напрямую — ждущий запрос закрыт, значения стёрты');

select * from finish();
rollback;
