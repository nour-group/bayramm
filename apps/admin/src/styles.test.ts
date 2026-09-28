import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = readFileSync(createRequire(import.meta.url).resolve("@bayramm/ui/tokens.css"), "utf8");

/** Правила без вложенности: селектор → объявления */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector = "", body = ""]) => ({
  selectors: selector.split(",").map((s) => s.trim()),
  body,
}));

const declarationsOf = (selector: string) =>
  rules
    .filter((rule) => rule.selectors.includes(selector))
    .map((rule) => rule.body)
    .join(";");

describe("styles.css панели оператора", () => {
  it("скобки сбалансированы (ловушка №10)", () => {
    let depth = 0;
    for (const char of css) {
      if (char === "{") depth++;
      if (char === "}") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it("все переменные — из токенов @bayramm/ui", () => {
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map(([, name]) => name));
    const missing = [...used].filter((name) => !tokens.includes(`${name}:`));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(10);
  });

  it("цвета не вписаны числом", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  it("100vh идёт перед 100dvh (ловушка №4)", () => {
    const app = declarationsOf(".app");
    expect(app).toMatch(/min-height:\s*100vh;[\s\S]*min-height:\s*100dvh/);
  });

  it.each([".skip", ".brand", ".nav a", ".action"])("%s: зона нажатия не меньше 44px", (selector) => {
    expect(declarationsOf(selector)).toMatch(/min-height:\s*var\(--hit-min\)/);
  });

  it("фокус с клавиатуры виден", () => {
    expect(declarationsOf(":focus-visible")).toMatch(/outline:\s*\d+px solid var\(--coral\)/);
  });
});
