-- Структура: схемы, справочники, настройки, роль API, RLS и права
begin;
select plan(39);

-- ── схемы и справочники ─────────────────────────────────────────────────────
select has_schema('app');
select has_schema('pii');

select set_eq(
  'select code from app.categories',
  array['hall', 'car', 'studio', 'flowers', 'photo', 'cake', 'gifts', 'decor',
        'food', 'restaurant', 'attire', 'music', 'kids', 'zags'],
  '14 категорий с кодами продукта (packages/shared/src/categories)');
select set_eq(
  'select code from app.categories where enabled',
  array['hall', 'car', 'studio', 'flowers', 'photo', 'cake', 'gifts', 'decor'],
  'в v0.2 включены залы и семь приоритетных категорий');
select set_eq(
  'select code from app.occasions',
  array['toy', 'beshik', 'bd', 'corp', 'small'],
  '5 поводов');
select set_eq(
  'select code from app.districts',
  array['yunusobod', 'mirzo_ulugbek', 'chilonzor', 'yakkasaroy', 'shayxontohur', 'mirobod',
        'sergeli', 'uchtepa', 'olmazor', 'yashnobod', 'bektemir', 'yangihayot'],
  'все 12 районов Ташкента, по кодам');
select is_empty(
  $$select code from app.districts where name_uz ~ '[‘’`'']'$$,
  'в узбекских названиях районов нет прямых и «кавычечных» апострофов');

select is(app.setting_int('sla_hours'), 12, 'SLA — 12 часов');
select is(app.setting_int('min_photos'), 3, 'минимум фото — 3');
select throws_ok(
  $$update app.settings set value = '2' where key = 'min_photos'$$,
  '23514', null, 'min_photos нельзя опустить ниже 3');
select throws_ok(
  $$update app.settings set value = '"12"' where key = 'sla_hours'$$,
  '23514', null, 'sla_hours — только целое число');
select throws_ok(
  $$update app.settings set value = '100' where key = 'sla_hours'$$,
  '23514', null, 'sla_hours — не больше 72');

-- ── роль API ────────────────────────────────────────────────────────────────
select has_role('bayramm_api');
select is((select rolbypassrls from pg_roles where rolname = 'bayramm_api'), false, 'bayramm_api без BYPASSRLS');
select is((select rolsuper from pg_roles where rolname = 'bayramm_api'), false, 'bayramm_api не суперпользователь');

-- ── RLS везде ───────────────────────────────────────────────────────────────
select is_empty(
  $$select c.oid::regclass::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('app', 'pii') and c.relkind in ('r', 'p') and not c.relrowsecurity$$,
  'RLS включён на каждой таблице app и pii');
select is_empty(
  $$select c.oid::regclass::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('app', 'pii') and c.relkind = 'v'
      and not coalesce('security_invoker=true' = any (c.reloptions), false)$$,
  'представления работают с правами вызывающего (RLS не обходится)');

-- ── Data API и PUBLIC не имеют доступа ──────────────────────────────────────
select ok(not has_schema_privilege('anon', 'app', 'USAGE'), 'anon: нет доступа к app');
select ok(not has_schema_privilege('anon', 'pii', 'USAGE'), 'anon: нет доступа к pii');
select ok(not has_schema_privilege('authenticated', 'app', 'USAGE'), 'authenticated: нет доступа к app');
select ok(not has_schema_privilege('authenticated', 'pii', 'USAGE'), 'authenticated: нет доступа к pii');
select ok(not has_schema_privilege('service_role', 'pii', 'USAGE'), 'service_role: нет доступа к pii');
select is_empty(
  $$select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app', 'pii') and has_function_privilege('public', p.oid, 'EXECUTE')$$,
  'PUBLIC не исполняет ни одной функции app/pii');

-- ── телефоны не читаются SELECT-ом ──────────────────────────────────────────
select ok(not has_column_privilege('bayramm_api', 'pii.request_contacts', 'contact_phone', 'SELECT'),
  'API не читает телефон из заявки напрямую');
select ok(not has_column_privilege('bayramm_api', 'pii.client_profiles', 'phone', 'SELECT'),
  'API не читает телефон клиента напрямую');
select ok(not has_column_privilege('bayramm_api', 'pii.vendor_contacts', 'phone', 'SELECT'),
  'API не читает телефон вендора напрямую');
select ok(not has_column_privilege('bayramm_api', 'pii.vendor_user_profiles', 'phone', 'SELECT'),
  'API не читает телефон входа вендора напрямую');
select ok(not has_column_privilege('bayramm_api', 'pii.listing_contacts', 'public_phone', 'SELECT'),
  'API не читает телефон листинга напрямую');
select ok(has_function_privilege('bayramm_api', 'pii.read_request_phone(uuid, text)', 'EXECUTE'),
  'API читает телефон из заявки через журналируемую функцию');
select ok(not has_function_privilege('bayramm_api', 'app.log_pii_access(text, uuid, text, text)', 'EXECUTE'),
  'API не пишет в журнал доступа к ПДн в обход функций чтения');

-- ── журналы только на добавление ────────────────────────────────────────────
select ok(not has_table_privilege('bayramm_api', 'app.audit_log', 'UPDATE'), 'audit_log: нет UPDATE');
select ok(not has_table_privilege('bayramm_api', 'app.audit_log', 'DELETE'), 'audit_log: нет DELETE');
select ok(not has_table_privilege('bayramm_api', 'app.request_status_log', 'INSERT'),
  'request_status_log пишет только триггер');
select ok(not has_table_privilege('bayramm_api', 'app.request_status_log', 'UPDATE'), 'request_status_log: нет UPDATE');
select ok(not has_table_privilege('bayramm_api', 'app.request_status_log', 'DELETE'), 'request_status_log: нет DELETE');
select ok(not has_table_privilege('bayramm_api', 'app.pii_access_log', 'INSERT'),
  'pii_access_log пишут только функции чтения');
select ok(not has_table_privilege('bayramm_api', 'app.consents', 'UPDATE'), 'согласия не редактируются');
select ok(not has_table_privilege('bayramm_api', 'app.requests', 'DELETE'), 'заявки не удаляются');
select is_empty(
  $$select c.oid::regclass::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('app', 'pii') and c.relkind = 'r'
      and has_table_privilege('bayramm_api', c.oid, 'TRUNCATE')$$,
  'у API нет TRUNCATE');

select * from finish();
rollback;
