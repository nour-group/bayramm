-- Индексы под списки панели (20261012110000_perf_indexes.sql): журнал — новые сверху по индексу
begin;
\ir _fixtures.psql
select plan(5);

select has_index('app', 'audit_log', 'audit_log_at_id', 'журнал: индекс по времени есть');
select is(
  pg_get_indexdef('app.audit_log_at_id'::regclass),
  'CREATE INDEX audit_log_at_id ON app.audit_log USING btree (at DESC, id DESC)',
  'порядок индекса совпадает с запросом панели: at desc, id desc');
select ok(
  not (select indisunique from pg_index where indexrelid = 'app.audit_log_at_id'::regclass),
  'индекс не уникальный: журнал только дописывается, а момент записи может совпасть');

-- Запрос страницы журнала (staff/audit.ts) идёт по индексу, а не сортирует всю таблицу
create function pg_temp.plan_of(p_query text)
returns text
language plpgsql
as $$
declare
  line text;
  result text := '';
begin
  for line in execute 'explain ' || p_query loop
    result := result || line || E'\n';
  end loop;
  return result;
end $$;

set local enable_seqscan = off;
select matches(
  pg_temp.plan_of('select a.id from app.audit_log a order by a.at desc, a.id desc limit 50'),
  'audit_log_at_id',
  'страница журнала без фильтров читается по индексу');
select matches(
  pg_temp.plan_of($$select a.id from app.audit_log a where a.at >= now() - interval '1 day' order by a.at desc, a.id desc limit 50$$),
  'audit_log_at_id',
  'и с отбором по дням');

select * from finish();
rollback;
