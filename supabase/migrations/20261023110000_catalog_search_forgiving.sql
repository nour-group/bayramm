-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — поиск по каталогу прощает лишние слова.
--
--   · app.search_query_words(текст) — слова запроса, те же, что searchTokens из
--     @bayramm/shared/search: различные, от двух символов, первые шесть; без слов о цене
--     («недорогой», «дешёвый», «arzon» — они меняют порядок, его выбирает API) и без служебных
--     («на», «для», «uchun»), если в запросе есть другие слова (одно «за» — начало «ЗАГС» — ищется).
--     Списки — из TS: блок search-sql ниже (pnpm --filter @bayramm/shared search:sql);
--   · app.catalog_search — слова из app.search_query_words. По всем словам вместе ничего нет —
--     ещё раз без слов, которые сами по себе ничего в разделе не находят («katta zal» → «zal»);
--     ничего не нашло ни одно слово или каждое находит, но не вместе, — пусто. Новый столбец
--     dropped — пропущенные слова (одинаков у всех строк; пусто — все слова нашли): по нему клиент
--     пишет «Показаны результаты по «зал» — «katta» не нашли». Оценка и правила совпадения — прежние;
--     оплата в них не участвует;
--   · app.search_matches (для проверок) — по тем же словам;
--   · запрос по-прежнему нигде не сохраняется: в SQL он приходит параметром.
--
-- Откат: supabase/rollbacks/20261023110000_catalog_search_forgiving.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- Функции ниже задают пороги pg_trgm (SET pg_trgm.*): параметр должен быть известен сессии
do $$ begin perform extensions.similarity('', ''); end $$;

-- ── слова запроса, нормализация и поля витрины (из TS) ──────────────────────
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

create or replace function app.search_query_words(p_text text)
returns text[]
language sql immutable strict parallel safe set search_path = ''
as $$
  with w as (
    select u.t, min(u.n) as n, u.t = any ('{na,vo,dlya,so,po,ko,ob,ot,iz,za,do,bez,pod,pri,pro,ili,no,uchun,va,bilan,ham,yoki}'::text[]) as stop
    from unnest(string_to_array(app.search_norm(p_text), ' ')) with ordinality as u(t, n)
    where length(u.t) >= 2 and u.t !~ '^(deshe|deshyo|dyoshe|nedorog|byudjet|ekonom|arzon|hamyonbop)'
    group by u.t
  )
  select coalesce(array_agg(x.t order by x.n), '{}')
  from (select w.t, w.n from w
        where not w.stop or not exists (select 1 from w o where not o.stop)
        order by w.n
        limit 6) x
$$;

comment on function app.search_query_words(text) is
  'Слова запроса поиска: различные, от двух символов, без слов о цене и служебных (если есть другие), первые шесть (= searchTokens из @bayramm/shared/search)';

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

-- Подходит ли запрос тексту (все слова запроса) — те же правила, что у app.catalog_search; для проверок
create or replace function app.search_matches(p_query text, p_text text)
returns boolean
language sql stable set search_path = ''
set pg_trgm.word_similarity_threshold = '0.6'
set pg_trgm.strict_word_similarity_threshold = '0.3'
as $$
  select coalesce(bool_and(
           b.body operator(extensions.%>) t or (length(t) >= 4 and b.body operator(extensions.%>>) t)), false)
  from (select app.search_norm(p_text) as body) b,
       unnest(app.search_query_words(p_query)) t
$$;

-- ── поиск ───────────────────────────────────────────────────────────────────
-- Возвращает ещё и пропущенные слова — у функции другой тип результата: пересоздаём
drop function app.catalog_search(text, text);

-- Подходящие активные витрины (раздел: null или 'all' — все), оценка (больше — выше) и пропущенные
-- слова. Слова — app.search_query_words; в SQL — параметрами ($1[i], похожие слова — $4[k]), а не
-- текстом запроса. Внутри — только битовые карты индексов (почему — 20261015090000_catalog_search)
create function app.catalog_search(p_query text, p_category text default null)
returns table (listing_id uuid, score real, dropped text[])
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
  v_kept_match text[] := '{}';
  v_kept_score text[] := '{}';
  v_dropped text[] := '{}';
  v_cond text;
  v_fuzzy text;
  v_word text;
  v_hit boolean;
  -- Выдача по условиям слов: %1 — сумма оценок, %2 — сколько слов, %3 — совпадение всех
  v_sql constant text := $q$select s.listing_id,
              ((%1$s) / %2$s + case when left(s.name, length($2)) = $2 then 1 else 0 end)::real,
              $5::text[]
       from app.listing_search s
       join app.listings l on l.id = s.listing_id
       where l.status = 'active'
         and ($3::text is null or $3 = 'all' or l.category_code = $3)
         and %3$s$q$;
begin
  if v_text is null or length(v_text) < 2 then
    return;
  end if;
  v_tokens := app.search_query_words(v_text);
  if cardinality(v_tokens) = 0 then
    return;
  end if;

  for i in 1 .. cardinality(v_tokens) loop
    v_cond := format('s.body operator(extensions.%%>) $1[%s]', i);
    v_fuzzy := '';
    -- От четырёх букв — и с опечаткой: похожие слова документов, каждое — условием по индексу
    if length(v_tokens[i]) >= 4 then
      v_fuzzy := format(
        $f$
            when s.name operator(extensions.%%>>) $1[%1$s]
              then extensions.strict_word_similarity($1[%1$s], s.name)
            when s.doc operator(extensions.%%>>) $1[%1$s]
              then extensions.strict_word_similarity($1[%1$s], s.doc) / 2$f$, i);
      for v_word in
        select w.word from app.search_words w
        where w.word operator(extensions.%) v_tokens[i] and w.word <> v_tokens[i]
        order by extensions.similarity(w.word, v_tokens[i]) desc, w.word
        limit 8
      loop
        v_alts := v_alts || v_word;
        v_cond := v_cond || format(' or s.body operator(extensions.%%>) $4[%s]', cardinality(v_alts));
      end loop;
    end if;
    v_match := v_match || ('(' || v_cond || ')');
    -- Оценка слова: почти точное — по месту (начало слова названия, название, doc, описание),
    -- с опечаткой — ниже любого почти точного (название, затем doc)
    v_score := v_score || format(
      $f$(case
            when (' ' || s.name) like ('%% ' || $1[%1$s] || '%%')
              then 3 + extensions.word_similarity($1[%1$s], s.name)
            when s.name operator(extensions.%%>) $1[%1$s]
              then 2 + extensions.word_similarity($1[%1$s], s.name)
            when s.doc operator(extensions.%%>) $1[%1$s]
              then 1 + extensions.word_similarity($1[%1$s], s.doc)
            when s.descr operator(extensions.%%>) $1[%1$s]
              then 0.5 + extensions.word_similarity($1[%1$s], s.descr) / 2%2$s
            else 0
          end)$f$,
      i, v_fuzzy);
  end loop;

  return query execute format(v_sql,
    array_to_string(v_score, ' + '), cardinality(v_tokens), array_to_string(v_match, ' and '))
  using v_tokens, v_text, p_category, v_alts, '{}'::text[];
  if found or cardinality(v_tokens) < 2 then
    return;
  end if;

  -- По всем словам вместе — ничего: без слов, которые сами по себе ничего в разделе не находят
  for i in 1 .. cardinality(v_tokens) loop
    execute format(
      $q$select exists (select 1 from app.listing_search s
                        join app.listings l on l.id = s.listing_id
                        where l.status = 'active'
                          and ($3::text is null or $3 = 'all' or l.category_code = $3)
                          and %s)$q$, v_match[i])
      into v_hit
      using v_tokens, v_text, p_category, v_alts;
    if v_hit then
      v_kept_match := v_kept_match || v_match[i];
      v_kept_score := v_kept_score || v_score[i];
    else
      v_dropped := v_dropped || v_tokens[i];
    end if;
  end loop;
  -- Ни одно слово не нашло или каждое находит, но не вместе, — пусто
  if cardinality(v_kept_match) = 0 or cardinality(v_dropped) = 0 then
    return;
  end if;

  return query execute format(v_sql,
    array_to_string(v_kept_score, ' + '), cardinality(v_kept_match), array_to_string(v_kept_match, ' and '))
  using v_tokens, v_text, p_category, v_alts, v_dropped;
end $$;

comment on function app.catalog_search(text, text) is
  'Поиск по каталогу: активные витрины раздела (null, all — все), где подходят все слова запроса (по всем вместе ничего — без слов, которые ничего не находят: они в dropped), и оценка для порядка «по похожести». Запрос не сохраняется';

-- ── права ───────────────────────────────────────────────────────────────────
revoke execute on function app.search_query_words(text), app.catalog_search(text, text) from public;
grant execute on function app.catalog_search(text, text) to bayramm_api;
