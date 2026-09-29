// Правило «ПДн — только через db/pii»: схема pii упоминается в коде API только
// в pii.ts. Запрос к pii в обход модуля (или комментарий, ссылающийся на неё
// мимо модуля) — красный тест с file:line. Тесты, сгенерированная схема и
// src/testing не проверяются.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");
const MODULE = join(import.meta.dirname, "pii.ts");

// pii.<что угодно> (в том числе «pii . x» и через перенос строки), а также имя
// схемы строкой: withSchema("pii"), sql.id("pii", …), "pii"."таблица" в сыром SQL
const PII_REF = /\bpii\s*\.|["'`]pii["'`]/gi;

/** Путь от src с прямыми слэшами — для сообщений и фильтров */
const rel = (path: string) => relative(SRC, path).split(sep).join("/");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

const checked = sources(SRC).filter(
  (path) =>
    path !== MODULE &&
    !rel(path).endsWith(".test.ts") &&
    !rel(path).endsWith("schema.generated.ts") &&
    !rel(path).startsWith("testing/"),
);

/** Каждое упоминание pii в тексте — «файл:строка: строка целиком» */
function piiRefs(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  return [...text.matchAll(PII_REF)].map((match) => {
    const line = text.slice(0, match.index).split("\n").length;
    return `src/${rel(path)}:${line}: ${lines[line - 1]?.trim()}`;
  });
}

describe("доступ к схеме pii — только через db/pii", () => {
  it("проверка видит исходники API", () => {
    expect(checked.length).toBeGreaterThan(20);
    expect(checked.map(rel)).toContain("routes/auth.ts");
    expect(checked.map(rel)).not.toContain("db/pii.ts");
  });

  it("сам модуль обращается к pii", () => {
    expect(piiRefs(MODULE).length).toBeGreaterThan(0);
  });

  it("вне модуля pii не упоминается", () => {
    expect(checked.flatMap(piiRefs), "таблицы и функции pii — только через src/db/pii.ts").toEqual([]);
  });
});
