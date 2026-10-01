// Сид категорий и каталога услуг в миграции = конфигурация @bayramm/shared/categories.
// Правка конфигурации (категория, тип услуги, обязательное поле, тексты) без новой миграции
// с новым сидом — красный тест: база и API разошлись бы. Как обновить — CLAUDE.md, раздел
// «Категории и услуги». Саму базу с конфигурацией сверяет интеграционный тест categories.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORIES, categoriesSeedSql, SEED_BEGIN, SEED_END } from "@bayramm/shared/categories";
import { describe, expect, it } from "vitest";

const migrationsDir = join(import.meta.dirname, "../../../../supabase/migrations");

/** Блок сида из последней миграции, где он есть: имя файла и текст от начала до конца блока */
function latestSeed(): { file: string; block: string } {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse();
  for (const file of files) {
    const source = readFileSync(join(migrationsDir, file), "utf8");
    const begin = source.lastIndexOf(SEED_BEGIN);
    if (begin === -1) continue;
    const end = source.indexOf(SEED_END, begin);
    if (end === -1) throw new Error(`${file}: нет конца блока сида`);
    return { file, block: source.slice(begin, end + SEED_END.length) };
  }
  throw new Error("ни в одной миграции нет сида категорий");
}

describe("сид категорий в миграции", () => {
  it("последний сид совпадает с выводом pnpm --filter @bayramm/shared categories:sql", () => {
    const { file, block } = latestSeed();
    expect(block, `${file}: сид устарел — новая миграция с новым сидом`).toBe(categoriesSeedSql().trimEnd());
  });

  it("в сиде все категории и все типы услуг конфигурации", () => {
    const { block } = latestSeed();
    for (const category of CATEGORIES) {
      expect(block).toContain(`('${category.code}', `);
      for (const service of category.services)
        expect(block).toContain(`('${category.code}', '${service.code}', `);
    }
  });
});
