-- Уборка демо-данных staging (app.demo_purge): вендоры из демо-диапазона
-- 00000000-0000-4000-8000-de… — целиком, с заявками на их карточки и журналами,
-- которые на них ссылаются. Чужое не трогается, защита журналов после уборки на
-- месте, вызывает только актор system
begin;
\ir _fixtures.psql
select plan(16);

-- ════════════════════════════════════════════════════════════════════════════
-- Права и пустой прогон
-- ════════════════════════════════════════════════════════════════════════════
select ok(has_function_privilege('bayramm_api', 'app.demo_purge()', 'EXECUTE'),
  'API убирает демо-данные функцией базы');

set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok($$select app.demo_purge()$$, 'BR003', null, 'сотруднику (даже администратору) — нельзя');
select pg_temp.as_actor(null);
select throws_ok($$select app.demo_purge()$$, 'BR003', null, 'без актора — нельзя');

select pg_temp.as_actor('system');
select is(app.demo_purge(),
  '{"vendors": 0, "listings": 0, "photos": 0, "requests": 0, "vendorUsers": 0}'::jsonb,
  'демо-вендоров нет — нули');
reset role;
select is((select count(*)::int from app.audit_log where action = 'demo.reset'), 0,
  'пустой прогон в журнал не пишется');

-- ════════════════════════════════════════════════════════════════════════════
-- Демо-вендор со всем, что к нему успели привязать на показе
-- ════════════════════════════════════════════════════════════════════════════
-- Вендор D (диапазон …-de…), опубликованная карточка D1, партнёр с аккаунтом и сессией
-- кабинета, заявка клиента C1 с отказом «занято» (занятый день ссылается на заявку),
-- заметка сотрудника, уведомления, правка карточки
do $$
begin
  perform pg_temp.as_actor(null);
  insert into app.vendor_accounts (id, name, legal_form, contract_no, contract_signed_at, stir_verified_at,
                                   contacts_confirmed_at, pd_consent_signed_at, pd_consent_text_id)
  values ('00000000-0000-4000-8000-de0000000001', 'Демо-вендор', 'ooo', 'DEMO-1', now(), now(), now(), now(),
          'dddddddd-0000-0000-0000-000000000002');
  insert into pii.vendor_contacts (vendor_id, legal_name, contact_person, phone)
  values ('00000000-0000-4000-8000-de0000000001', 'Демо', 'Демо-контакт', '+998000000001');

  insert into app.accounts (id) values ('acacacac-0000-0000-0000-0000000000d1');
  insert into app.vendor_users (id, vendor_id, phone_hash, account_id)
  values ('11111111-0000-0000-0000-0000000000d1', '00000000-0000-4000-8000-de0000000001', sha256('demo-partner'),
          'acacacac-0000-0000-0000-0000000000d1');
  insert into pii.vendor_user_profiles (vendor_user_id, phone)
  values ('11111111-0000-0000-0000-0000000000d1', '+998000000011');
  insert into app.sessions (token_hash, account_id, vendor_user_id, via, expires_at)
  values (sha256('demo-session'), 'acacacac-0000-0000-0000-0000000000d1', '11111111-0000-0000-0000-0000000000d1',
          'tg_partner', now() + interval '1 hour');

  insert into app.listings (id, vendor_id, slug, category_code, name, district_code,
                            description_ru, description_uz, price_from_uzs, price_unit, cap_min, cap_max)
  values ('00000000-0000-4000-8000-de0000000101', '00000000-0000-4000-8000-de0000000001', 'demo-zal-test', 'hall',
          'Демо-зал', 'yunusobod', 'Описание', 'Tavsif', 150000, 'per_guest', 50, 300);
  insert into pii.listing_contacts (listing_id, public_phone)
  values ('00000000-0000-4000-8000-de0000000101', '+998000000001');
  insert into app.listing_packages (listing_id, kind, name_ru, name_uz, price_uzs) values
    ('00000000-0000-4000-8000-de0000000101', 'weekday', 'Будни', 'Ish kunlari', 150000),
    ('00000000-0000-4000-8000-de0000000101', 'weekend', 'Выходные', 'Dam olish kunlari', 180000);
  insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256, sort,
                          no_faces_ack)
  select '00000000-0000-4000-8000-de0000000101', 'ready', 'approved',
         pg_temp.photo_key('00000000-0000-4000-8000-de0000000101'), 'image/webp', 1000, 1280, 853,
         sha256(convert_to('demo/' || n, 'UTF8')), n, true
  from generate_series(1, 3) n;
  update app.listings set status = 'review' where id = '00000000-0000-4000-8000-de0000000101';
  update app.listings set status = 'active' where id = '00000000-0000-4000-8000-de0000000101';
  insert into app.availability (listing_id, day, source)
  values ('00000000-0000-4000-8000-de0000000101', current_date + 5, 'vendor');

  insert into app.consents (id, subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source)
  values ('ffffffff-0000-0000-0000-0000000000d1', 'client', 'cccccccc-0000-0000-0000-000000000001',
          'request_transfer', 'grant', 'dddddddd-0000-0000-0000-000000000001',
          '00000000-0000-4000-8000-de0000000101', 'tma');
  insert into app.requests (id, client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests,
                            source)
  values ('eeeeeeee-0000-0000-0000-0000000000d1', 'cccccccc-0000-0000-0000-000000000001',
          '00000000-0000-4000-8000-de0000000101', '00000000-0000-4000-8000-de0000000001',
          'ffffffff-0000-0000-0000-0000000000d1', 'toy', current_date + 40, 120, 'tma');
  insert into pii.request_contacts (request_id, contact_name, contact_phone)
  values ('eeeeeeee-0000-0000-0000-0000000000d1', 'Client1', '+998000000301');

  perform pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
  insert into app.request_notes (request_id, body) values ('eeeeeeee-0000-0000-0000-0000000000d1', 'Позвонить');
  perform pg_temp.as_actor('vendor_user', '11111111-0000-0000-0000-0000000000d1',
                           '00000000-0000-4000-8000-de0000000001');
  update app.requests set status = 'declined', decline_reason = 'busy'
  where id = 'eeeeeeee-0000-0000-0000-0000000000d1';
  insert into app.listing_revisions (id, listing_id, payload, base_version)
  select '99999999-0000-0000-0000-0000000000d1', id, '{"price_from_uzs": 170000}', version
  from app.listings where id = '00000000-0000-4000-8000-de0000000101';

  perform pg_temp.as_actor(null);
  insert into app.outbox (kind, recipient_kind, recipient_id, request_id, dedupe_key) values
    ('vendor.request_new', 'vendor_user', '11111111-0000-0000-0000-0000000000d1',
     'eeeeeeee-0000-0000-0000-0000000000d1', 'demo-test:request'),
    ('vendor.ops_reminder', 'vendor_user', '11111111-0000-0000-0000-0000000000d1', null, 'demo-test:user');
  insert into app.outbox (kind, recipient_kind, recipient_id, payload, dedupe_key) values
    ('ops.revision_submitted', 'staff', '00000000-0000-0000-0000-00000000a001',
     '{"revision_id": "99999999-0000-0000-0000-0000000000d1"}', 'demo-test:revision');
end $$;

-- Всё, что должно уйти: до уборки — есть
create function pg_temp.demo_rows() returns table (what text, n int)
language sql
as $$
  select 'vendors', count(*)::int from app.vendor_accounts where id::text like '00000000-0000-4000-8000-de%'
  union all select 'contacts', count(*)::int from pii.vendor_contacts
    where vendor_id = '00000000-0000-4000-8000-de0000000001'
  union all select 'users', count(*)::int from app.vendor_users
    where vendor_id = '00000000-0000-4000-8000-de0000000001'
  union all select 'sessions', count(*)::int from app.sessions where token_hash = sha256('demo-session')
  union all select 'listings', count(*)::int from app.listings
    where vendor_id = '00000000-0000-4000-8000-de0000000001'
  union all select 'listing_log', count(*)::int from app.listing_status_log
    where listing_id = '00000000-0000-4000-8000-de0000000101'
  union all select 'photos', count(*)::int from app.photos where listing_id = '00000000-0000-4000-8000-de0000000101'
  union all select 'busy', count(*)::int from app.availability
    where listing_id = '00000000-0000-4000-8000-de0000000101'
  union all select 'revisions', count(*)::int from app.listing_revisions
    where listing_id = '00000000-0000-4000-8000-de0000000101'
  union all select 'requests', count(*)::int from app.requests where id = 'eeeeeeee-0000-0000-0000-0000000000d1'
  union all select 'request_log', count(*)::int from app.request_status_log
    where request_id = 'eeeeeeee-0000-0000-0000-0000000000d1'
  union all select 'notes', count(*)::int from app.request_notes
    where request_id = 'eeeeeeee-0000-0000-0000-0000000000d1'
  union all select 'request_contacts', count(*)::int from pii.request_contacts
    where request_id = 'eeeeeeee-0000-0000-0000-0000000000d1'
  union all select 'consents', count(*)::int from app.consents
    where scope_listing_id = '00000000-0000-4000-8000-de0000000101'
  union all select 'outbox', count(*)::int from app.outbox where dedupe_key like 'demo-test:%'
$$;

select is_empty($$select what from pg_temp.demo_rows() where n = 0$$,
  'до уборки: вендор, карточка, заявка и всё, что к ним привязано, — на месте');

-- Чужое: снимок до уборки
create temp table others as
  select (select count(*) from app.vendor_accounts where id::text not like '00000000-0000-4000-8000-de%') as vendors,
         (select count(*) from app.listings where vendor_id::text not like '00000000-0000-4000-8000-de%') as listings,
         (select count(*) from app.requests where id <> 'eeeeeeee-0000-0000-0000-0000000000d1') as requests,
         (select count(*) from app.request_status_log
           where request_id <> 'eeeeeeee-0000-0000-0000-0000000000d1') as status_log,
         (select count(*) from app.consents where scope_listing_id is distinct from
                                                  '00000000-0000-4000-8000-de0000000101') as consents,
         (select count(*) from app.photos where listing_id <> '00000000-0000-4000-8000-de0000000101') as photos;

-- ════════════════════════════════════════════════════════════════════════════
-- Уборка
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('system');
select is(app.demo_purge(),
  '{"vendors": 1, "listings": 1, "photos": 3, "requests": 1, "vendorUsers": 1}'::jsonb,
  'уборка: сколько вендоров, карточек, фото, заявок и пользователей кабинета убрано');
reset role;

select is_empty($$select what from pg_temp.demo_rows() where n <> 0$$,
  'после уборки от демо-вендора не осталось ничего');

select results_eq(
  $$select (select count(*) from app.vendor_accounts where id::text not like '00000000-0000-4000-8000-de%'),
           (select count(*) from app.listings where vendor_id::text not like '00000000-0000-4000-8000-de%'),
           (select count(*) from app.requests),
           (select count(*) from app.request_status_log),
           (select count(*) from app.consents),
           (select count(*) from app.photos)$$,
  $$select vendors, listings, requests, status_log, consents, photos from others$$,
  'чужие вендоры, карточки, заявки, журналы и фото не тронуты');

select ok(exists (select 1 from app.accounts where id = 'acacacac-0000-0000-0000-0000000000d1'),
  'аккаунт партнёра остаётся — убрана только его роль в демо-вендоре');
select ok(exists (select 1 from app.clients where id = 'cccccccc-0000-0000-0000-000000000001'),
  'клиент, подавший заявку на демо-карточку, остаётся');

select is(
  (select array_agg(tgenabled::text order by tgname) from pg_trigger
    where tgname in ('request_status_log_append_only', 'request_notes_append_only', 'consents_append_only',
                     'listing_status_log_append_only')),
  array['O', 'O', 'O', 'O'],
  'защита журналов после уборки снова включена');
select throws_ok(
  $$delete from app.request_status_log where request_id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  'BR001', null, 'журнал статусов чужой заявки удалить по-прежнему нельзя');
select throws_ok(
  $$delete from app.consents where id = 'ffffffff-0000-0000-0000-0000000000a1'$$,
  'BR001', null, 'журнал согласий — по-прежнему только на добавление');

select results_eq(
  $$select actor_kind::text, actor_id, object_type, object_id, detail, source::text
      from app.audit_log where action = 'demo.reset'$$,
  $$values ('system', null::uuid, 'demo', 'staging',
            '{"vendors": 1, "listings": 1, "photos": 3, "requests": 1, "vendorUsers": 1}'::jsonb, 'system')$$,
  'в журнал действий — одна запись: кто (system) и сколько, без id и ПДн');

set local role bayramm_api;
select pg_temp.as_actor('system');
select is(app.demo_purge()->>'vendors', '0', 'повторная уборка ничего не находит');
reset role;

select * from finish();
rollback;
