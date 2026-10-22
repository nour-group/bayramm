-- Откат 20261023110000_catalog_search_forgiving: поиск снова требует все слова запроса —
-- служебные и слова о цене ищутся как остальные, без повтора без ненайденных слов.
--
-- Только для локальной разработки и проверки в CI (up → down → up).

do $$ begin perform extensions.similarity('', ''); end $$;

create or replace function app.search_matches(p_query text, p_text text)
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

drop function app.catalog_search(text, text, boolean);

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
        v_cond := v_cond || format(' or s.body operator(extensions.%%>) $4[%s]', array_length(v_alts, 1));
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

revoke execute on function app.catalog_search(text, text) from public;
grant execute on function app.catalog_search(text, text) to bayramm_api;

drop function app.search_query_words(text);
