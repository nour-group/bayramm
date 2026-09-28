-- Журналы только на добавление: ни API, ни владелец таблиц их не меняют
begin;
\ir _fixtures.psql
select plan(16);

insert into app.audit_log (actor_kind, action, object_type, object_id) values ('system', 'test.seed', 'test', '1');
select pg_temp.as_actor('staff', '00000000-0000-0000-0000-00000000a001');
select pii.read_request_phone('eeeeeeee-0000-0000-0000-0000000000a1', 'проверка журнала');
select pg_temp.as_actor(null);

-- ── владелец таблиц (миграции, ручной SQL): останавливает триггер ───────────
select throws_ok($$update app.audit_log set action = 'test.changed'$$,
  'BR001', 'append_only', 'audit_log: UPDATE запрещён даже владельцу');
select throws_ok($$delete from app.audit_log$$,
  'BR001', 'append_only', 'audit_log: DELETE запрещён даже владельцу');
select throws_ok($$truncate app.audit_log$$,
  'BR001', 'append_only', 'audit_log: TRUNCATE запрещён даже владельцу');
select throws_ok($$update app.request_status_log set reason = 'подмена'$$,
  'BR001', 'append_only', 'request_status_log: UPDATE запрещён даже владельцу');
select throws_ok($$delete from app.request_status_log$$,
  'BR001', 'append_only', 'request_status_log: DELETE запрещён даже владельцу');
select throws_ok($$update app.pii_access_log set reason = null$$,
  'BR001', 'append_only', 'pii_access_log: UPDATE запрещён даже владельцу');
select throws_ok($$delete from app.pii_access_log$$,
  'BR001', 'append_only', 'pii_access_log: DELETE запрещён даже владельцу');
select throws_ok($$update app.consents set action = 'withdraw'$$,
  'BR001', 'append_only', 'согласия: UPDATE запрещён даже владельцу');
select throws_ok($$delete from app.consents where id = 'ffffffff-0000-0000-0000-0000000000b1'$$,
  'BR001', 'append_only', 'согласия: DELETE запрещён даже владельцу');
select throws_ok($$delete from app.requests where id = 'eeeeeeee-0000-0000-0000-0000000000a1'$$,
  '23503', null, 'заявку с историей не удалить: журнал держит ссылку');
select throws_ok(
  $$update app.consent_texts set body = 'другой текст' where id = 'dddddddd-0000-0000-0000-000000000001'$$,
  'BR006', 'immutable_column', 'опубликованный текст согласия не редактируется');

-- ── роль API: нет прав ──────────────────────────────────────────────────────
set local role bayramm_api;
select pg_temp.as_actor('system');

select throws_ok($$update app.audit_log set action = 'test.changed'$$,
  '42501', null, 'API: UPDATE audit_log запрещён правами');
select throws_ok($$delete from app.audit_log$$,
  '42501', null, 'API: DELETE audit_log запрещён правами');
select throws_ok($$update app.request_status_log set reason = 'подмена'$$,
  '42501', null, 'API: UPDATE request_status_log запрещён правами');
select throws_ok($$delete from app.request_status_log$$,
  '42501', null, 'API: DELETE request_status_log запрещён правами');
select throws_ok(
  $$insert into app.request_status_log (request_id, to_status, actor_kind, source)
    values ('eeeeeeee-0000-0000-0000-0000000000a1', 'deal', 'system', 'system')$$,
  '42501', null, 'API: историю статусов нельзя дописать в обход триггера');

select * from finish();
rollback;
