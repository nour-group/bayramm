-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — поиск по каталогу.
--
--   · pg_trgm — в схеме extensions (как остальные расширения Supabase). Роли API схема
--     extensions не нужна: триграммы считают только функции ниже (security definer);
--   · app.search_norm(text) — нормализация текста поиска, та же, что searchNorm из
--     @bayramm/shared/search: строчные, кириллица (русская и узбекская) → латиница, без
--     апострофов и диакритики, остаётся [a-z0-9 ]. Тело собирает
--     pnpm --filter @bayramm/shared search:sql (блок search-sql ниже; тест API сверяет его с
--     выводом скрипта, pgTAP — общие тест-векторы);
--   · app.listing_attrs_text — текстовые значения полей витрины по конфигурации категорий
--     (марка машины в автопарке, зоны студии); коды вариантов не ищутся;
--   · app.listing_search — документ поиска витрины, всё нормализовано: name — название;
--     doc — название, раздел ru/uz, район ru/uz, названия активных услуг (у «другой услуги» —
--     своё) и поля витрины; descr — описания ru и uz (меньший вес); body = doc + descr — по нему
--     совпадение, индекс GIN (триграммы). Поддерживают триггеры витрины, услуг, каталога услуг,
--     разделов и районов. Таблицу читают только функции поиска: у роли API прав на неё нет;
--   · app.search_words — словарь слов документов (doc, от четырёх букв): по нему слово запроса с
--     опечаткой или в другой записи находит слова витрин (similarity ≥ 0,3), а витрины с ними — уже
--     по индексу. Слова не удаляются: лишнее слово ничего не находит;
--   · app.catalog_search(запрос, раздел) — подходящие витрины (активные) и их оценка. Слово
--     запроса подходит, если word_similarity ≥ 0,6 (начало слова, почти точное) или — у слов от
--     четырёх букв — похоже на слово документа: similarity ≥ 0,3 («kartej» → «kortej»); витрина —
--     если подходят все слова. Оценка: слово начинает слово названия > похоже на название > раздел,
--     район, услуги, поля > описание; среднее по словам и +1, если название начинается с запроса.
--     Оплата в ней не участвует. Остальные правила выдачи (фото, цена, RLS) — у запроса каталога:
--     функция только сужает и упорядочивает;
--   · запрос поиска нигде не сохраняется и не пишется: в SQL он приходит параметром.
--
-- Откат: supabase/rollbacks/20261015090000_catalog_search.down.sql
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists pg_trgm with schema extensions;
-- Функции ниже задают пороги pg_trgm (SET pg_trgm.*): параметр должен быть уже известен сессии,
-- иначе роль без суперпользователя (postgres у Supabase) его не задаст. Расширение могло быть
-- включено и раньше — тогда create extension его не загрузил: загружаем вызовом
do $$ begin perform extensions.similarity('', ''); end $$;

-- ── нормализация и поля витрины (из TS) ─────────────────────────────────────
-- search-sql:begin (pnpm --filter @bayramm/shared search:sql)
create or replace function app.search_norm(p_text text)
returns text
language sql immutable strict parallel safe set search_path = ''
as $$
  select btrim(regexp_replace(lower(regexp_replace(normalize(translate(
    replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(p_text), 'ё', 'yo'), 'Ё', 'yo'), 'ц', 'ts'), 'Ц', 'ts'), 'ч', 'ch'), 'Ч', 'ch'), 'ш', 'sh'), 'Ш', 'sh'), 'щ', 'sh'), 'Щ', 'sh'), 'ю', 'yu'), 'Ю', 'yu'), 'я', 'ya'), 'Я', 'ya'),
    'аАбБвВгГдДеЕжЖзЗиИйЙкКлЛмМнНоОпПрРсСтТуУфФхХыЫэЭўЎқҚғҒҳҲъЪьЬʻʼ''`’‘´',
    'aabbvvggddeejjzziiyykkllmmnnoopprrssttuuffxxiieeooqqgghh'),
    NFKD), '[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]', '', 'g')), '[^a-z0-9]+', ' ', 'g'))
$$;

comment on function app.search_norm(text) is
  'Текст для поиска: строчные, кириллица → латиница, без апострофов и диакритики, [a-z0-9 ] (= searchNorm из @bayramm/shared/search)';

create or replace function app.listing_attrs_text(p_category text, p_attributes jsonb)
returns text
language sql immutable parallel safe set search_path = ''
as $$
  select coalesce(string_agg(v.value #>> '{}', ' ' order by p.ord, v.n), '')
  from (values
    (1, 'car', '$."fleet"[*]."model"'),
    (2, 'studio', '$."zones".*'),
    (3, 'flowers', '$."working_hours"'),
    (4, 'attire', '$."size_range"'),
    (5, 'attire', '$."working_hours"'),
    (6, 'zags', '$."working_hours"')
  ) as p(ord, category, path)
  cross join lateral jsonb_path_query(p_attributes, p.path::jsonpath) with ordinality as v(value, n)
  where p.category = p_category and jsonb_typeof(v.value) = 'string'
$$;

comment on function app.listing_attrs_text(text, jsonb) is
  'Текстовые значения полей витрины категории одной строкой (= listingAttrText из @bayramm/shared/search)';
-- search-sql:end

-- Подходит ли запрос тексту (все слова) — те же правила, что у app.catalog_search; для проверок
create function app.search_matches(p_query text, p_text text)
returns boolean
language sql stable set search_path = ''
set pg_trgm.word_similarity_threshold = '0.6'
set pg_trgm.strict_word_similarity_threshold = '0.3'
as $$
  select coalesce(bool_and(
           b.body operator(extensions.%>) t or (length(t) >= 4 and b.body operator(extensions.%>>) t)), false)
  from (select app.search_norm(p_text) as body) b,
       unnest(string_to_array(app.search_norm(p_query), ' ')) t
  where length(t) >= 2
$$;

comment on function app.search_matches(text, text) is
  'Подходит ли запрос тексту по правилам поиска каталога (все слова от двух символов); для проверок';

-- ── документ поиска витрины ─────────────────────────────────────────────────
create table app.listing_search (
  listing_id uuid primary key references app.listings on delete cascade,
  name       text not null,
  doc        text not null,
  descr      text not null,
  body       text generated always as (doc || ' ' || descr) stored
);

alter table app.listing_search enable row level security;

comment on table app.listing_search is
  'Документ поиска витрины (нормализованный, app.search_norm). Пишут триггеры, читает app.catalog_search; у роли API прав нет';
comment on column app.listing_search.name is 'Название';
comment on column app.listing_search.doc is
  'Название, раздел ru/uz, район ru/uz, названия активных услуг, текстовые поля витрины';
comment on column app.listing_search.descr is 'Описания ru и uz — меньший вес в порядке';
comment on column app.listing_search.body is 'doc и descr вместе — по нему совпадение (индекс триграмм)';

create index listing_search_body on app.listing_search using gin (body extensions.gin_trgm_ops);

create table app.search_words (
  word text primary key check (word ~ '^[a-z0-9]{4,40}$')
);

alter table app.search_words enable row level security;

comment on table app.search_words is
  'Слова документов поиска (doc, 4–40 знаков): по ним app.catalog_search находит слово с опечаткой. У роли API прав нет';

create index search_words_trgm on app.search_words using gin (word extensions.gin_trgm_ops);

-- Пересобрать документы витрин; неизменившиеся не перезаписываются
create function app.listing_search_refresh(p_ids uuid[])
returns void
language sql security definer set search_path = ''
as $$
  insert into app.listing_search as ls (listing_id, name, doc, descr)
  select l.id,
         app.search_norm(l.name),
         app.search_norm(concat_ws(' ', l.name, c.name_ru, c.name_uz, d.name_ru, d.name_uz, sv.names,
                                   app.listing_attrs_text(l.category_code, l.attributes))),
         app.search_norm(concat_ws(' ', l.description_ru, l.description_uz))
  from app.listings l
  join app.categories c on c.code = l.category_code
  left join app.districts d on d.code = l.district_code
  left join lateral (
    select string_agg(case when s.name_ru is not null and s.name_uz is not null
                           then s.name_ru || ' ' || s.name_uz
                           else t.name_ru || ' ' || t.name_uz end,
                      ' ' order by s.sort, s.created_at, s.id) as names
    from app.listing_services s
    join app.service_types t on t.category_code = s.category_code and t.code = s.service_type
    where s.listing_id = l.id and s.status = 'active'
  ) sv on true
  where l.id = any (p_ids)
  on conflict (listing_id) do update
    set name = excluded.name, doc = excluded.doc, descr = excluded.descr
    where (ls.name, ls.doc, ls.descr) is distinct from (excluded.name, excluded.doc, excluded.descr);

  insert into app.search_words (word)
  select distinct w.word
  from app.listing_search s
  cross join lateral unnest(string_to_array(s.doc, ' ')) as w(word)
  where s.listing_id = any (p_ids) and w.word ~ '^[a-z0-9]{4,40}$' and w.word !~ '^[0-9]+$'
  on conflict (word) do nothing;
$$;

comment on function app.listing_search_refresh(uuid[]) is
  'Пересобрать документы поиска витрин (app.listing_search) и дополнить словарь слов; зовут триггеры';

-- Витрина: название, раздел, район, поля, описания
create function app.listing_search_on_listing()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.listing_search_refresh(array[new.id]);
  return null;
end $$;

create trigger listings_search
  after insert or update of name, category_code, district_code, attributes, description_ru, description_uz
  on app.listings
  for each row execute function app.listing_search_on_listing();

-- Услуга: появилась, одобрена, снята, переименована, удалена
create function app.listing_search_on_service()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform app.listing_search_refresh(array[new.listing_id]);
  elsif tg_op = 'DELETE' then
    perform app.listing_search_refresh(array[old.listing_id]);
  else
    perform app.listing_search_refresh(array[old.listing_id, new.listing_id]);
  end if;
  return null;
end $$;

create trigger listing_services_search
  after insert or delete or update of listing_id, service_type, name_ru, name_uz, status
  on app.listing_services
  for each row execute function app.listing_search_on_service();

-- Справочники: название раздела, района или типа услуги
create function app.listing_search_on_dictionary()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'categories' then
    perform app.listing_search_refresh(array(select l.id from app.listings l where l.category_code = new.code));
  elsif tg_table_name = 'districts' then
    perform app.listing_search_refresh(array(select l.id from app.listings l where l.district_code = new.code));
  else
    perform app.listing_search_refresh(array(
      select distinct s.listing_id from app.listing_services s
      where s.category_code = new.category_code and s.service_type = new.code));
  end if;
  return null;
end $$;

create trigger categories_search after update of name_ru, name_uz on app.categories
  for each row when (old.name_ru is distinct from new.name_ru or old.name_uz is distinct from new.name_uz)
  execute function app.listing_search_on_dictionary();
create trigger districts_search after update of name_ru, name_uz on app.districts
  for each row when (old.name_ru is distinct from new.name_ru or old.name_uz is distinct from new.name_uz)
  execute function app.listing_search_on_dictionary();
create trigger service_types_search after update of name_ru, name_uz on app.service_types
  for each row when (old.name_ru is distinct from new.name_ru or old.name_uz is distinct from new.name_uz)
  execute function app.listing_search_on_dictionary();

-- Документы витрин, что уже есть
do $$ begin perform app.listing_search_refresh(array(select l.id from app.listings l)); end $$;

-- ── поиск ───────────────────────────────────────────────────────────────────
-- Подходящие активные витрины (раздел: null или 'all' — все) и оценка (больше — выше). Слова —
-- различные, от двух символов, первые шесть; в SQL — параметрами ($1[i], похожие слова — $4[k]),
-- а не текстом запроса.
--
-- Каждое условие — по индексу listing_search_body: слово (word_similarity) или похожее слово из
-- словаря. Похожесть на длинный документ стоит десятки микросекунд на строку, а планировщик
-- считает операторы pg_trgm дешёвыми (их стоимость задаёт расширение) и выбирает перебор таблицы
-- или первичного ключа с фильтром: на 2000 витрин — 130–200 мс против единиц мс по индексу.
-- Поэтому внутри функции — только битовые карты индексов (enable_seqscan, enable_indexscan,
-- enable_indexonlyscan = off): к документам — по триграммам, к витринам — по своим индексам. Оценка
-- — сначала дешёвое (короткое название), длинные doc и descr — по одной похожести и только если
-- до них дошло
create function app.catalog_search(p_query text, p_category text default null)
returns table (listing_id uuid, score real)
language plpgsql stable security definer set search_path = ''
set pg_trgm.word_similarity_threshold = '0.6'
set pg_trgm.strict_word_similarity_threshold = '0.3'
set pg_trgm.similarity_threshold = '0.3'
set enable_seqscan = off
set enable_indexscan = off
set enable_indexonlyscan = off
as $$
declare
  v_text text := app.search_norm(left(p_query, 200));
  v_tokens text[];
  v_alts text[] := '{}';
  v_match text[] := '{}';
  v_score text[] := '{}';
  v_cond text;
  v_fuzzy text;
  v_word text;
begin
  if v_text is null or length(v_text) < 2 then
    return;
  end if;
  select array_agg(x.t order by x.n) into v_tokens
  from (select u.t, min(u.n) as n
        from unnest(string_to_array(v_text, ' ')) with ordinality as u(t, n)
        where length(u.t) >= 2
        group by u.t
        order by min(u.n)
        limit 6) x;
  if v_tokens is null then
    return;
  end if;

  for i in 1 .. array_length(v_tokens, 1) loop
    v_cond := format('s.body operator(extensions.%%>) $1[%s]', i);
    v_fuzzy := '';
    -- От четырёх букв — и с опечаткой: похожие слова документов, каждое — условием по индексу
    if length(v_tokens[i]) >= 4 then
      v_fuzzy := format(' or %%s operator(extensions.%%%%>>) $1[%s]', i);
      for v_word in
        select w.word from app.search_words w
        where w.word operator(extensions.%) v_tokens[i] and w.word <> v_tokens[i]
        order by extensions.similarity(w.word, v_tokens[i]) desc, w.word
        limit 8
      loop
        v_alts := v_alts || v_word;
        v_cond := v_cond || format(' or s.body operator(extensions.%%>) $4[%s]', array_length(v_alts, 1));
      end loop;
    end if;
    v_match := v_match || ('(' || v_cond || ')');
    v_score := v_score || format(
      $f$(case
            when (' ' || s.name) like ('%% ' || $1[%1$s] || '%%')
              then 3 + extensions.word_similarity($1[%1$s], s.name)
            when s.name operator(extensions.%%>) $1[%1$s]%2$s
              then 2 + greatest(extensions.word_similarity($1[%1$s], s.name),
                                extensions.strict_word_similarity($1[%1$s], s.name))
            when s.doc operator(extensions.%%>) $1[%1$s]%3$s
              then 1 + extensions.word_similarity($1[%1$s], s.doc)
            else extensions.word_similarity($1[%1$s], s.descr)
          end)$f$,
      i, format(v_fuzzy, 's.name'), format(v_fuzzy, 's.doc'));
  end loop;

  return query execute format(
    $q$select s.listing_id,
              ((%1$s) / %2$s + case when left(s.name, length($2)) = $2 then 1 else 0 end)::real
       from app.listing_search s
       join app.listings l on l.id = s.listing_id
       where l.status = 'active'
         and ($3::text is null or $3 = 'all' or l.category_code = $3)
         and %3$s$q$,
    array_to_string(v_score, ' + '), array_length(v_tokens, 1), array_to_string(v_match, ' and '))
  using v_tokens, v_text, p_category, v_alts;
end $$;

comment on function app.catalog_search(text, text) is
  'Поиск по каталогу: активные витрины раздела (null, all — все), где подходят все слова запроса, и оценка для порядка «по похожести». Запрос не сохраняется';

-- ── права ───────────────────────────────────────────────────────────────────
revoke execute on all functions in schema app, pii from public;
grant execute on function app.catalog_search(text, text) to bayramm_api;
