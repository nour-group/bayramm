-- Пользователи кабинета вендора (20261011110000_vendor_user_invites.sql): приглашение по
-- телефону (ждёт входа или принято сразу — с чатом для уведомлений и «вас добавили»),
-- владелец у кабинета есть всегда, убрать пользователя — вместе с сессиями до аккаунтов,
-- неотправленными уведомлениями и профилем; в журнале — только id и коды
begin;
\ir _fixtures.psql
select plan(48);

-- ════════════════════════════════════════════════════════════════════════════
-- Права
-- ════════════════════════════════════════════════════════════════════════════
select ok(has_function_privilege('bayramm_api', 'app.staff_invite_vendor_user(uuid, bytea, text, text, text, app.locale)',
                                 'EXECUTE')
          and has_function_privilege('bayramm_api', 'app.staff_remove_vendor_user(uuid)', 'EXECUTE'),
  'API приглашает и убирает пользователей кабинета функциями базы');
select is_empty(
  $$select f from unnest(array['app.vendor_keep_owner()', 'app.vendor_users_bound()',
                               'app.enqueue_vendor_access_granted(uuid)', 'app.vendor_user_fill_telegram(uuid)']) f
    where has_function_privilege('bayramm_api', f, 'EXECUTE')$$,
  'триггерные и служебные функции API недоступны');
select ok(not has_table_privilege('bayramm_api', 'app.vendor_users', 'DELETE'),
  'удалить пользователя кабинета напрямую API не может');

-- Модератор …a003; вендор C — без пользователей
insert into app.staff (id, role) values ('00000000-0000-0000-0000-00000000a003', 'moderator');
insert into pii.staff_profiles (staff_id, display_name) values ('00000000-0000-0000-0000-00000000a003', 'Moderator');
insert into app.vendor_accounts (id) values ('cccccccc-0000-0000-0000-0000000000f1');

-- ════════════════════════════════════════════════════════════════════════════
-- Приглашение, которое ждёт входа
-- ════════════════════════════════════════════════════════════════════════════
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a003');
select throws_ok(
  $$select * from app.staff_invite_vendor_user('aaaaaaaa-0000-0000-0000-000000000001', sha256('vu-1'),
                                               '+998901110001', 'Dilshod', 'member', 'ru')$$,
  'BR003', 'forbidden_for_actor', 'модератор не приглашает');

select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok(
  $$select * from app.staff_invite_vendor_user('aaaaaaaa-0000-0000-0000-000000000001', sha256('vu-1'),
                                               '901110001', 'Dilshod', 'member', 'ru')$$,
  '22023', null, 'номер не в виде +998XXXXXXXXX — ошибка вызова');
select throws_ok(
  $$select * from app.staff_invite_vendor_user('aaaaaaaa-0000-0000-0000-000000000001', sha256('vu-1'),
                                               '+998901110001', 'Dilshod', 'boss', 'ru')$$,
  '22023', null, 'роль — только owner или member');
select throws_ok(
  $$select * from app.staff_invite_vendor_user('dddddddd-0000-0000-0000-0000000000ff', sha256('vu-1'),
                                               '+998901110001', 'Dilshod', 'member', 'ru')$$,
  '23503', null, 'нет такого вендора — как внешний ключ, а не ошибка про владельца');
select results_eq(
  $$select accepted from app.staff_invite_vendor_user('aaaaaaaa-0000-0000-0000-000000000001', sha256('vu-1'),
                                                      '+998901110001', '  Dilshod  ', 'member', 'ru')$$,
  $$values (false)$$,
  'менеджер приглашает сотрудника площадки: номер ещё ни у кого — ждёт входа');
select throws_ok(
  $$select * from app.staff_invite_vendor_user('aaaaaaaa-0000-0000-0000-000000000001', sha256('vu-1'),
                                               '+998901110001', null, 'owner', 'uz')$$,
  '23505', null, 'тот же номер у того же вендора — второй раз нельзя');
reset role;
select results_eq(
  $$select u.role, u.locale::text, u.account_id is null, u.tg_linked_at is null, p.full_name, p.phone
      from app.vendor_users u join pii.vendor_user_profiles p on p.vendor_user_id = u.id
     where u.vendor_id = 'aaaaaaaa-0000-0000-0000-000000000001' and u.phone_hash = sha256('vu-1')$$,
  $$values ('member'::text, 'ru'::text, true, true, 'Dilshod'::text, '+998901110001'::text)$$,
  'приглашение: роль, язык, имя без пробелов по краям, номер — в профиле ПДн; ещё не принято');
select results_eq(
  $$select a.action, a.actor_kind::text, a.detail from app.audit_log a
     join app.vendor_users u on u.id::text = a.object_id
    where u.phone_hash = sha256('vu-1') and a.action = 'vendor_user.invite'$$,
  $$values ('vendor_user.invite'::text, 'staff'::text,
            '{"vendor_id": "aaaaaaaa-0000-0000-0000-000000000001", "role": "member", "via": "phone",
              "accepted": false}'::jsonb)$$,
  'приглашение — в журнале: вендор, роль, способ, принято ли сразу');
select is_empty(
  $$select id from app.audit_log where detail::text like '%Dilshod%' or detail::text like '%901110001%'$$,
  'ни имени, ни номера в журнале');
select is((select count(*)::int from app.outbox where kind = 'vendor.access_granted'), 0,
  'ждущему входа — ничего не отправляем');

-- Сотрудник площадки — только при действующем владельце
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select throws_ok(
  $$select * from app.staff_invite_vendor_user('cccccccc-0000-0000-0000-0000000000f1', sha256('vu-2'),
                                               '+998901110002', null, 'member', 'uz')$$,
  'BR031', 'vendor_last_owner', 'у вендора нет владельца — сначала владелец');
select results_eq(
  $$select accepted from app.staff_invite_vendor_user('cccccccc-0000-0000-0000-0000000000f1', sha256('vu-2'),
                                                      '+998901110002', null, 'owner', null)$$,
  $$values (false)$$,
  'владельца — можно');
reset role;
select is((select locale::text from app.vendor_users where phone_hash = sha256('vu-2')), 'uz',
  'язык не выбран — узбекский');

-- ════════════════════════════════════════════════════════════════════════════
-- Номер уже подтверждён у аккаунта — принято сразу, с чатом и уведомлением
-- ════════════════════════════════════════════════════════════════════════════
-- Аккаунт K: телефон vu-3, Telegram tg-k (ID 7001); клиент, которому бот может писать
insert into app.accounts (id) values
  ('acacacac-0000-0000-0000-0000000000b1'), ('acacacac-0000-0000-0000-0000000000b2'),
  ('acacacac-0000-0000-0000-0000000000b3'), ('acacacac-0000-0000-0000-0000000000b4');
insert into app.account_identities (account_id, kind, value_hash) values
  ('acacacac-0000-0000-0000-0000000000b1', 'phone', sha256('vu-3')),
  ('acacacac-0000-0000-0000-0000000000b1', 'telegram', sha256('tg-k')),
  ('acacacac-0000-0000-0000-0000000000b2', 'phone', sha256('vu-4')),
  ('acacacac-0000-0000-0000-0000000000b2', 'telegram', sha256('tg-m')),
  ('acacacac-0000-0000-0000-0000000000b3', 'phone', sha256('vu-5')),
  ('acacacac-0000-0000-0000-0000000000b4', 'phone', sha256('vu-6')),
  ('acacacac-0000-0000-0000-0000000000b4', 'telegram', sha256('tg-n'));
insert into pii.account_profiles (account_id, telegram_id) values
  ('acacacac-0000-0000-0000-0000000000b1', 7001),
  ('acacacac-0000-0000-0000-0000000000b2', 7002),
  ('acacacac-0000-0000-0000-0000000000b4', 7004);
insert into app.clients (account_id, tg_id_hash, can_message) values
  ('acacacac-0000-0000-0000-0000000000b1', sha256('tg-k'), true);

set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select results_eq(
  $$select accepted from app.staff_invite_vendor_user('aaaaaaaa-0000-0000-0000-000000000001', sha256('vu-3'),
                                                      '+998901110003', 'Kamola', 'owner', 'uz')$$,
  $$values (true)$$,
  'номер уже подтверждён у аккаунта — приглашение принято сразу');
reset role;
select results_eq(
  $$select u.account_id, u.tg_user_hash = sha256('tg-k'), u.tg_linked_at is not null,
           p.telegram_user_id, p.telegram_chat_id
      from app.vendor_users u join pii.vendor_user_profiles p on p.vendor_user_id = u.id
     where u.phone_hash = sha256('vu-3')$$,
  $$values ('acacacac-0000-0000-0000-0000000000b1'::uuid, true, true, 7001::bigint, 7001::bigint)$$,
  'членство — у аккаунта, Telegram привязан, чат — клиента, которому бот уже может писать');
select results_eq(
  $$select o.recipient_id = u.id, o.payload, o.status::text, o.request_id is null
      from app.outbox o join app.vendor_users u on u.phone_hash = sha256('vu-3')
     where o.kind = 'vendor.access_granted'$$,
  $$values (true, '{"vendor_id": "aaaaaaaa-0000-0000-0000-000000000001"}'::jsonb, 'pending'::text, true)$$,
  'партнёру — «вас добавили в кабинет»; в payload только id вендора');
select results_eq(
  $$select a.action from app.audit_log a join app.vendor_users u on u.id::text = a.object_id
     where u.phone_hash = sha256('vu-3') order by a.id$$,
  $$values ('vendor_user.create'::text), ('vendor_user.account_bind'), ('vendor_user.invite')$$,
  'журнал: заведён, привязан к аккаунту (как при входе кодом), приглашён — без служебных правок полей');
select results_eq(
  $$select a.actor_kind::text, a.detail ->> 'accepted' from app.audit_log a
     join app.vendor_users u on u.id::text = a.object_id
    where u.phone_hash = sha256('vu-3') and a.action in ('vendor_user.account_bind', 'vendor_user.invite')
    order by a.id$$,
  $$values ('system'::text, null::text), ('staff', 'true')$$,
  'привязку пишет система, приглашение — сотрудник, с отметкой «принято сразу»');

-- Повторная привязка (отвязали и привязали снова) второго уведомления не шлёт
update app.vendor_users set account_id = null, tg_user_hash = null, tg_linked_at = null
 where phone_hash = sha256('vu-3') and vendor_id = 'aaaaaaaa-0000-0000-0000-000000000001';
select app.account_bind_phone('acacacac-0000-0000-0000-0000000000b1', sha256('vu-3'), 'web');
select is((select count(*)::int from app.outbox where kind = 'vendor.access_granted'), 1,
  '«вас добавили» — один раз на пользователя');

-- Чат другого кабинета того же человека: аккаунт M — партнёр вендора B с чатом
insert into app.vendor_users (id, vendor_id, phone_hash, role, account_id, tg_user_hash, tg_linked_at) values
  ('bbbbbbbb-0000-0000-0000-0000000000e1', 'bbbbbbbb-0000-0000-0000-000000000001', sha256('vu-4'), 'owner',
   'acacacac-0000-0000-0000-0000000000b2', sha256('tg-m'), now());
insert into pii.vendor_user_profiles (vendor_user_id, phone, telegram_user_id, telegram_chat_id) values
  ('bbbbbbbb-0000-0000-0000-0000000000e1', '+998901110004', 7002, 8002);
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select results_eq(
  $$select accepted from app.staff_invite_vendor_user('aaaaaaaa-0000-0000-0000-000000000001', sha256('vu-4'),
                                                      '+998901110004', null, 'member', 'ru')$$,
  $$values (true)$$,
  'партнёр другого вендора — принято сразу');
reset role;
select results_eq(
  $$select p.telegram_chat_id from app.vendor_users u join pii.vendor_user_profiles p on p.vendor_user_id = u.id
     where u.vendor_id = 'aaaaaaaa-0000-0000-0000-000000000001' and u.phone_hash = sha256('vu-4')$$,
  $$values (8002::bigint)$$,
  'чат — из другого кабинета того же человека');

-- Аккаунт без Telegram: принято, но писать некуда — уведомления нет
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select results_eq(
  $$select accepted from app.staff_invite_vendor_user('cccccccc-0000-0000-0000-0000000000f1', sha256('vu-5'),
                                                      '+998901110005', null, 'member', 'ru')$$,
  $$values (true)$$,
  'аккаунт без Telegram — принято сразу');
reset role;
select results_eq(
  $$select u.tg_linked_at is null, p.telegram_chat_id is null,
           not exists (select 1 from app.outbox o where o.recipient_id = u.id)
      from app.vendor_users u join pii.vendor_user_profiles p on p.vendor_user_id = u.id
     where u.phone_hash = sha256('vu-5')$$,
  $$values (true, true, true)$$,
  'без Telegram: ни привязки уведомлений, ни «вас добавили»');

-- Тот же человек уже в кабинете под другим номером — второе членство не принять
insert into app.vendor_users (vendor_id, phone_hash, account_id) values
  ('bbbbbbbb-0000-0000-0000-000000000001', sha256('vu-other'), 'acacacac-0000-0000-0000-0000000000b1');
set local role bayramm_api;
select throws_ok(
  $$select * from app.staff_invite_vendor_user('bbbbbbbb-0000-0000-0000-000000000001', sha256('vu-3'),
                                               '+998901110003', null, 'owner', 'ru')$$,
  'BR032', 'vendor_user_exists', 'человек уже в кабинете вендора под другим номером');
reset role;

-- ════════════════════════════════════════════════════════════════════════════
-- Принято позже: вход кодом на этот номер
-- ════════════════════════════════════════════════════════════════════════════
-- Аккаунт N: сотрудник команды с чатом бота; приглашение на его номер завели раньше
insert into app.staff (id, role, account_id, tg_id_hash, tg_linked_at) values
  ('00000000-0000-0000-0000-00000000a004', 'manager', 'acacacac-0000-0000-0000-0000000000b4', sha256('tg-n'), now());
insert into pii.staff_profiles (staff_id, display_name, telegram_chat_id) values
  ('00000000-0000-0000-0000-00000000a004', 'Staff N', 9004);
insert into app.vendor_users (id, vendor_id, phone_hash, role) values
  ('aaaaaaaa-0000-0000-0000-0000000000e2', 'aaaaaaaa-0000-0000-0000-000000000001', sha256('vu-6'), 'member');
insert into pii.vendor_user_profiles (vendor_user_id, phone) values
  ('aaaaaaaa-0000-0000-0000-0000000000e2', '+998901110006');
select app.account_bind_phone('acacacac-0000-0000-0000-0000000000b4', sha256('vu-6'), 'web');
select results_eq(
  $$select p.telegram_user_id, p.telegram_chat_id,
           exists (select 1 from app.outbox o where o.kind = 'vendor.access_granted' and o.recipient_id = u.id)
      from app.vendor_users u join pii.vendor_user_profiles p on p.vendor_user_id = u.id
     where u.id = 'aaaaaaaa-0000-0000-0000-0000000000e2'$$,
  $$values (7004::bigint, 9004::bigint, true)$$,
  'ждущее приглашение принято входом: чат — из роли сотрудника, партнёру — «вас добавили»');

-- ════════════════════════════════════════════════════════════════════════════
-- Владелец у кабинета есть всегда
-- ════════════════════════════════════════════════════════════════════════════
-- Вендор A: владельцы …0011 и vu-3, сотрудники площадки vu-1, vu-4, …e2
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select lives_ok(
  $$update app.vendor_users set role = 'member' where id = 'aaaaaaaa-0000-0000-0000-000000000011'$$,
  'одного из двух владельцев можно сделать сотрудником площадки');
select throws_ok(
  $$update app.vendor_users set role = 'member'
     where vendor_id = 'aaaaaaaa-0000-0000-0000-000000000001' and phone_hash = sha256('vu-3')$$,
  'BR031', 'vendor_last_owner', 'последнего владельца при действующих сотрудниках — нельзя');
select throws_ok(
  $$update app.vendor_users set disabled_at = now()
     where vendor_id = 'aaaaaaaa-0000-0000-0000-000000000001' and phone_hash = sha256('vu-3')$$,
  'BR031', 'vendor_last_owner', 'и отключить его — нельзя');
select throws_ok(
  $$select app.staff_remove_vendor_user(id) from app.vendor_users
     where vendor_id = 'aaaaaaaa-0000-0000-0000-000000000001' and phone_hash = sha256('vu-3')$$,
  'BR031', 'vendor_last_owner', 'и убрать из кабинета — нельзя');
select lives_ok(
  $$update app.vendor_users set role = 'owner', locale = 'uz' where id = 'aaaaaaaa-0000-0000-0000-000000000011'$$,
  'владельцем снова можно сделать любого');
select lives_ok(
  $$update app.vendor_users set disabled_at = now() where vendor_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  'отключить всех пользователей вендора разом — можно: действующих без владельца не осталось');
select throws_ok(
  $$update app.vendor_users set disabled_at = null
     where vendor_id = 'aaaaaaaa-0000-0000-0000-000000000001' and phone_hash = sha256('vu-1')$$,
  'BR031', 'vendor_last_owner', 'включить сотрудника площадки, пока владельцы отключены, — нельзя');
select lives_ok(
  $$update app.vendor_users set disabled_at = null where vendor_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  'включить всех вместе с владельцами — можно');
reset role;

-- Единственный пользователь вендора — владелец: его можно и отключить, и убрать
insert into app.vendor_accounts (id) values ('dddddddd-0000-0000-0000-0000000000f2');
insert into app.vendor_users (id, vendor_id, phone_hash) values
  ('dddddddd-0000-0000-0000-0000000000e1', 'dddddddd-0000-0000-0000-0000000000f2', sha256('vu-d1'));
insert into pii.vendor_user_profiles (vendor_user_id, phone) values ('dddddddd-0000-0000-0000-0000000000e1', '+998901110011');
set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select lives_ok(
  $$update app.vendor_users set disabled_at = now() where id = 'dddddddd-0000-0000-0000-0000000000e1'$$,
  'единственного пользователя вендора отключить можно: без владельца никто не остаётся');
select lives_ok(
  $$select app.staff_remove_vendor_user('dddddddd-0000-0000-0000-0000000000e1')$$,
  'и убрать из кабинета — тоже');
reset role;

-- Удаление вендора целиком: одним оператором или по шагам с app.deleting_vendor
select lives_ok(
  $$delete from app.vendor_users where vendor_id = 'cccccccc-0000-0000-0000-0000000000f1'$$,
  'все пользователи вендора одним оператором — проверка владельца не мешает');
insert into app.vendor_users (id, vendor_id, phone_hash, role) values
  ('cccccccc-0000-0000-0000-0000000000e1', 'cccccccc-0000-0000-0000-0000000000f1', sha256('vu-c1'), 'owner'),
  ('cccccccc-0000-0000-0000-0000000000e2', 'cccccccc-0000-0000-0000-0000000000f1', sha256('vu-c2'), 'member');
select throws_ok(
  $$delete from app.vendor_users where id = 'cccccccc-0000-0000-0000-0000000000e1'$$,
  'BR031', 'vendor_last_owner', 'по шагам без отметки — владельца первым не удалить');
select lives_ok(
  $$select set_config('app.deleting_vendor', 'cccccccc-0000-0000-0000-0000000000f1', true);
    delete from app.vendor_users where id = 'cccccccc-0000-0000-0000-0000000000e1';
    delete from app.vendor_users where id = 'cccccccc-0000-0000-0000-0000000000e2';
    select set_config('app.deleting_vendor', '', true)$$,
  'функция удаления вендора ставит app.deleting_vendor — по шагам можно');

-- ════════════════════════════════════════════════════════════════════════════
-- Убрать из кабинета
-- ════════════════════════════════════════════════════════════════════════════
-- У принятого vu-4 — сессия до аккаунтов и уведомления: ждущее и отправленное
insert into app.sessions (token_hash, vendor_user_id, via, expires_at)
select sha256('vu-4-session'), u.id, 'tg_partner', now() + interval '1 hour'
from app.vendor_users u where u.vendor_id = 'aaaaaaaa-0000-0000-0000-000000000001' and u.phone_hash = sha256('vu-4');
insert into app.outbox (kind, recipient_kind, recipient_id, request_id, status, dedupe_key)
select 'vendor.request_new', 'vendor_user', u.id, 'eeeeeeee-0000-0000-0000-0000000000a1', s.status::app.outbox_status,
       'test:vu-4:' || s.status
from app.vendor_users u, (values ('pending'), ('sent')) s (status)
where u.vendor_id = 'aaaaaaaa-0000-0000-0000-000000000001' and u.phone_hash = sha256('vu-4');
create temp table removed as
select id, account_id from app.vendor_users
where vendor_id = 'aaaaaaaa-0000-0000-0000-000000000001' and phone_hash in (sha256('vu-1'), sha256('vu-4'));
grant select on removed to bayramm_api;

set local role bayramm_api;
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a003');
select throws_ok(
  $$select app.staff_remove_vendor_user(id) from removed limit 1$$,
  'BR003', 'forbidden_for_actor', 'модератор пользователей не убирает');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a002');
select throws_ok(
  $$delete from app.vendor_users where id in (select id from removed)$$,
  '42501', null, 'напрямую API не удаляет — только функцией');
select lives_ok(
  $$select app.staff_remove_vendor_user(id) from removed$$,
  'менеджер убирает и ждущего входа, и принятого');
reset role;
select is_empty(
  $$select id from app.vendor_users where id in (select id from removed)
    union all select vendor_user_id from pii.vendor_user_profiles where vendor_user_id in (select id from removed)
    union all select vendor_user_id from app.sessions where vendor_user_id in (select id from removed)$$,
  'ни строки, ни профиля с номером, ни сессий до аккаунтов');
select results_eq(
  $$select status::text from app.outbox where recipient_id in (select id from removed) order by status$$,
  $$values ('sent'::text)$$,
  'неотправленное ему — удалено, отправленное — осталось в истории');
select is((select count(*)::int from app.accounts where id = 'acacacac-0000-0000-0000-0000000000b2'), 1,
  'аккаунт человека остаётся (и его кабинет у вендора B)');
select results_eq(
  $$select a.actor_kind::text, a.detail from app.audit_log a
     where a.action = 'vendor_user.remove' and a.object_id in (select id::text from removed)
     order by (a.detail ->> 'had_account')$$,
  $$values ('staff'::text, '{"vendor_id": "aaaaaaaa-0000-0000-0000-000000000001", "role": "member", "had_account": false}'::jsonb),
           ('staff'::text, '{"vendor_id": "aaaaaaaa-0000-0000-0000-000000000001", "role": "member", "had_account": true}'::jsonb)$$,
  'в журнале — вендор, роль и был ли аккаунт; без имени и номера');

select * from finish();
rollback;
