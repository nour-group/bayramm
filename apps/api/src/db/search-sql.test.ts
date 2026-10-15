// SQL поиска в базе = TS @bayramm/shared/search: последний блок search-sql в миграциях —
// вывод pnpm --filter @bayramm/shared search:sql (нормализация и текстовые поля витрины), блок
// векторов в pgTAP — тоже. Поменяли таблицу нормализации, апострофы, текстовое поле витрины или
// векторы без новой миграции и без обновления pgTAP — красный тест: searchNorm и app.search_norm
// разошлись бы. Пороги похожести у app.catalog_search — те же, что у демо-API.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SEARCH_FUZZY_SIMILARITY,
  SEARCH_SQL_BEGIN,
  SEARCH_SQL_END,
  SEARCH_VECTORS_BEGIN,
  SEARCH_VECTORS_END,
  SEARCH_WORD_SIMILARITY,
  searchSql,
  searchVectorsSql,
} from "@bayramm/shared/search";
import { describe, expect, it } from "vitest";

const supabase = join(import.meta.dirname, "../../../../supabase");
const migrationsDir = join(supabase, "migrations");

function block(source: string, begin: string, end: string): string | null {
  const from = source.lastIndexOf(begin);
  if (from === -1) return null;
  const to = source.indexOf(end, from);
  if (to === -1) throw new Error(`нет конца блока ${begin}`);
  return source.slice(from, to + end.length);
}

/** Последняя миграция с блоком функций поиска */
function latestSearchSql(): { file: string; text: string; sql: string } {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse();
  for (const file of files) {
    const text = readFileSync(join(migrationsDir, file), "utf8");
    const sql = block(text, SEARCH_SQL_BEGIN, SEARCH_SQL_END);
    if (sql !== null) return { file, text, sql };
  }
  throw new Error("ни в одной миграции нет блока search-sql");
}

describe("SQL поиска в миграции", () => {
  it("последний блок совпадает с выводом pnpm --filter @bayramm/shared search:sql", () => {
    const { file, sql } = latestSearchSql();
    expect(sql, `${file}: блок поиска устарел — новая миграция с новым блоком`).toBe(searchSql());
  });

  it("пороги похожести app.catalog_search — как у TS", () => {
    const text = readFileSync(join(migrationsDir, "20261015090000_catalog_search.sql"), "utf8");
    const fn = text.slice(text.indexOf("create function app.catalog_search"));
    expect(fn).toContain(`set pg_trgm.word_similarity_threshold = '${SEARCH_WORD_SIMILARITY}'`);
    expect(fn).toContain(`set pg_trgm.strict_word_similarity_threshold = '${SEARCH_FUZZY_SIMILARITY}'`);
  });

  it("векторы в pgTAP совпадают с vectors.ts", () => {
    const test = readFileSync(join(supabase, "tests/32_catalog_search.test.sql"), "utf8");
    const vectors = block(test, SEARCH_VECTORS_BEGIN, SEARCH_VECTORS_END);
    expect(vectors, "32_catalog_search.test.sql: векторы устарели — вставить вывод search:sql").toBe(
      searchVectorsSql(),
    );
  });
});
