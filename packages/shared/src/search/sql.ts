/* SQL поиска из TS — чтобы база и TS не разошлись:
     · searchSql()        — app.search_norm (таблицы нормализации — normalize.ts и CYRILLIC_LATIN),
                            app.search_query_words (слова запроса без служебных и слов о цене —
                            searchTokens) и app.listing_attrs_text (текстовые поля витрины —
                            attributes.ts из конфигурации категорий): блок для миграции;
     · searchVectorsSql() — тест-векторы (vectors.ts) для pgTAP.
   Печатает их pnpm --silent --filter @bayramm/shared search:sql. Тест API
   (apps/api/src/db/search-sql.test.ts) сверяет последний блок в миграциях и блок в pgTAP с этим
   выводом: поменяли таблицу, апострофы или текстовое поле витрины — новая миграция с новым
   блоком. */

import { CATEGORIES } from "../categories/config";
import { CYRILLIC_LATIN } from "../slug";
import { attrTextJsonPath, attrTextPaths } from "./attributes";
import {
  SEARCH_APOSTROPHES,
  SEARCH_CHEAP_PREFIXES,
  SEARCH_MARK_RANGES,
  SEARCH_MAX_TOKENS,
  SEARCH_MIN_LENGTH,
  SEARCH_STOP_WORDS,
} from "./normalize";
import { MATCH_VECTORS, MISMATCH_VECTORS, NORM_VECTORS } from "./vectors";

/** Начало и конец блока функций в миграции — по ним его находит тест */
export const SEARCH_SQL_BEGIN = "-- search-sql:begin (pnpm --filter @bayramm/shared search:sql)";
export const SEARCH_SQL_END = "-- search-sql:end";
/** Начало и конец блока векторов в pgTAP */
export const SEARCH_VECTORS_BEGIN = "-- search-vectors:begin (pnpm --filter @bayramm/shared search:sql)";
export const SEARCH_VECTORS_END = "-- search-vectors:end";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const hex = (n: number) => n.toString(16).padStart(4, "0");

/** Тело app.search_norm: шаги — как у searchNorm */
function normBody(): string {
  const entries = Object.entries(CYRILLIC_LATIN);
  // Заглавные — на случай базы, где lower() не знает кириллицу (локаль C)
  const withUpper = entries.flatMap(([from, to]) => {
    const upper = from.toUpperCase();
    return upper !== from ? [[from, to] as const, [upper, to] as const] : [[from, to] as const];
  });
  const multi = withUpper.filter(([, to]) => to.length > 1);
  const single = withUpper.filter(([, to]) => to.length === 1);
  const drop = withUpper.filter(([, to]) => to.length === 0).map(([from]) => from);
  let expr = "lower(p_text)";
  for (const [from, to] of multi) expr = `replace(${expr}, ${literal(from)}, ${literal(to)})`;
  const fromChars = single.map(([from]) => from).join("") + drop.join("") + SEARCH_APOSTROPHES;
  const toChars = single.map(([, to]) => to).join("");
  const marks = SEARCH_MARK_RANGES.map(([a, b]) => `\\u${hex(a)}-\\u${hex(b)}`).join("");
  return [
    "  select btrim(regexp_replace(lower(regexp_replace(normalize(translate(",
    `    ${expr},`,
    `    ${literal(fromChars)},`,
    `    ${literal(toChars)}),`,
    `    NFKD), ${literal(`[${marks}]`)}, '', 'g')), '[^a-z0-9]+', ' ', 'g'))`,
  ].join("\n");
}

/** Тело app.search_query_words: слова — как у searchTokens */
function wordsBody(): string {
  const stop = `{${SEARCH_STOP_WORDS.join(",")}}`;
  const cheap = `^(${SEARCH_CHEAP_PREFIXES.join("|")})`;
  return [
    "  with w as (",
    `    select u.t, min(u.n) as n, u.t = any (${literal(stop)}::text[]) as stop`,
    "    from unnest(string_to_array(app.search_norm(p_text), ' ')) with ordinality as u(t, n)",
    `    where length(u.t) >= ${SEARCH_MIN_LENGTH} and u.t !~ ${literal(cheap)}`,
    "    group by u.t",
    "  )",
    "  select coalesce(array_agg(x.t order by x.n), '{}')",
    "  from (select w.t, w.n from w",
    "        where not w.stop or not exists (select 1 from w o where not o.stop)",
    "        order by w.n",
    `        limit ${SEARCH_MAX_TOKENS}) x`,
  ].join("\n");
}

/** Строки (порядок, категория, путь) текстовых полей витрины */
function attrPathRows(): string[] {
  let ord = 0;
  return CATEGORIES.flatMap((category) =>
    attrTextPaths(category).map((path) => {
      ord += 1;
      return `    (${ord}, ${literal(category.code)}, ${literal(attrTextJsonPath(path))})`;
    }),
  );
}

/** Блок функций поиска для миграции — между SEARCH_SQL_BEGIN и SEARCH_SQL_END */
export function searchSql(): string {
  const rows = attrPathRows();
  const attrs =
    rows.length === 0
      ? "  select ''::text"
      : [
          "  select coalesce(string_agg(v.value #>> '{}', ' ' order by p.ord, v.n), '')",
          "  from (values",
          rows.join(",\n"),
          "  ) as p(ord, category, path)",
          "  cross join lateral jsonb_path_query(p_attributes, p.path::jsonpath) with ordinality as v(value, n)",
          "  where p.category = p_category and jsonb_typeof(v.value) = 'string'",
        ].join("\n");
  return [
    SEARCH_SQL_BEGIN,
    "create or replace function app.search_norm(p_text text)",
    "returns text",
    "language sql immutable strict parallel safe set search_path = ''",
    "as $$",
    normBody(),
    "$$;",
    "",
    "comment on function app.search_norm(text) is",
    "  'Текст для поиска: строчные, кириллица → латиница, без апострофов и диакритики, [a-z0-9 ] (= searchNorm из @bayramm/shared/search)';",
    "",
    "create or replace function app.search_query_words(p_text text)",
    "returns text[]",
    "language sql immutable strict parallel safe set search_path = ''",
    "as $$",
    wordsBody(),
    "$$;",
    "",
    "comment on function app.search_query_words(text) is",
    "  'Слова запроса поиска: различные, от двух символов, без слов о цене и служебных (если есть другие), первые шесть (= searchTokens из @bayramm/shared/search)';",
    "",
    "create or replace function app.listing_attrs_text(p_category text, p_attributes jsonb)",
    "returns text",
    "language sql immutable parallel safe set search_path = ''",
    "as $$",
    attrs,
    "$$;",
    "",
    "comment on function app.listing_attrs_text(text, jsonb) is",
    "  'Текстовые значения полей витрины категории одной строкой (= listingAttrText из @bayramm/shared/search)';",
    SEARCH_SQL_END,
  ].join("\n");
}

/** Векторы для pgTAP — между SEARCH_VECTORS_BEGIN и SEARCH_VECTORS_END; число проверок — searchVectorsCount */
export function searchVectorsSql(): string {
  const norm = NORM_VECTORS.map(
    ([input, expected]) =>
      `select is(app.search_norm(${literal(input)}), ${literal(expected)}, ${literal(`search_norm: ${input}`)});`,
  );
  const match = MATCH_VECTORS.map(
    ([query, text]) =>
      `select ok(app.search_matches(${literal(query)}, ${literal(text)}), ${literal(`подходит: ${query} → ${text}`)});`,
  );
  const mismatch = MISMATCH_VECTORS.map(
    ([query, text]) =>
      `select ok(not app.search_matches(${literal(query)}, ${literal(text)}), ${literal(`не подходит: ${query} → ${text}`)});`,
  );
  return [SEARCH_VECTORS_BEGIN, ...norm, ...match, ...mismatch, SEARCH_VECTORS_END].join("\n");
}

/** Сколько проверок в блоке векторов (для plan() в pgTAP) */
export const searchVectorsCount = () => NORM_VECTORS.length + MATCH_VECTORS.length + MISMATCH_VECTORS.length;
