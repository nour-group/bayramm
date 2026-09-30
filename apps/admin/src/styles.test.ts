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

  it("переменные — из токенов @bayramm/ui; свои — только размеры оболочки в :root; --tg-* — от SDK Telegram", () => {
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map(([, name]) => name));
    const own = new Set([...css.matchAll(/(--[a-z0-9-]+):/g)].map(([, name]) => name));
    const missing = [...used].filter(
      (name = "") => !tokens.includes(`${name}:`) && !own.has(name) && !name.startsWith("--tg-"),
    );
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(10);
    // Свои — только размеры и высота экрана, не цвета: цвета только из токенов
    expect([...own].sort()).toEqual(["--app-h", "--bar-h", "--rail-w", "--tabbar-h"]);
  });

  it("цвета не вписаны числом", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  it("высота экрана: 100vh раньше переменной, 100dvh — только где он есть (ловушка №4)", () => {
    const app = declarationsOf(".app");
    expect(app).toMatch(
      /min-height:\s*100vh;[\s\S]*min-height:\s*var\(--tg-viewport-stable-height, var\(--app-h\)\)/,
    );
    expect(declarationsOf(":root")).toMatch(/--app-h:\s*100vh/);
    expect(css).toMatch(/@supports \(height: 100dvh\)\s*\{\s*:root\s*\{\s*--app-h:\s*100dvh/);
  });

  it.each([
    ".skip",
    ".brand",
    ".nav a",
    ".action",
    ".btn",
    ".chip",
    ".input",
    ".cal-day",
    ".phone-row",
    ".appbar-brand",
    ".appbar-btn",
    ".appbar-account",
    ".tab",
    ".rail-link",
    ".back-link",
  ])("%s: зона нажатия не меньше 44px", (selector) => {
    expect(declarationsOf(selector)).toMatch(/min-height:\s*var\(--hit-min\)/);
  });

  it("таблицы и прокручиваемые слои задают обе оси (ловушка №2)", () => {
    for (const selector of [".nav", ".table-wrap", ".rail"]) {
      const body = declarationsOf(selector);
      expect(body, selector).toMatch(/overflow-x:/);
      expect(body, selector).toMatch(/overflow-y:/);
    }
  });

  it("безопасные зоны: шапка складывает обе верхние (--pad-t), нижняя панель — обе нижние (--pad-b)", () => {
    expect(declarationsOf(".appbar")).toMatch(/padding:\s*calc\(var\(--pad-t\) \+ 8px\)/);
    expect(declarationsOf(".tabbar")).toMatch(/calc\(var\(--pad-b\) \+ 6px\)/);
    expect(declarationsOf(".rail")).toMatch(/var\(--sa-l\)/);
    // Панель действий липнет над нижней навигацией и безопасной зоной
    expect(declarationsOf(".app-phone .actionbar-slot")).toMatch(
      /bottom:\s*calc\(var\(--tabbar-h\) \+ var\(--pad-b\)\)/,
    );
  });

  it("класс объявлен один раз: одно имя на две разные вещи ломает обе (как data-* в ловушке №1)", () => {
    const flat = css.replace(/@[a-z-]+[^{]*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, "");
    // Правило из одного класса; общие правила списком («.a, .b») — дополнения, их не считаем
    const plain = [...flat.matchAll(/([^{}]+)\{[^{}]*\}/g)]
      .map(([, selector = ""]) => selector.trim())
      .filter((selector) => /^\.[a-z0-9-]+$/.test(selector));
    const twice = plain.filter((selector, index) => plain.indexOf(selector) !== index);
    expect(twice).toEqual([]);
  });

  it("наведение — только внутри @media (hover: hover) (ловушка №6)", () => {
    const outside = css.replace(/@media \(hover: hover\)\s*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, "");
    expect(outside).not.toMatch(/:hover/);
  });

  it("фокус с клавиатуры виден", () => {
    expect(declarationsOf(":focus-visible")).toMatch(/outline:\s*\d+px solid var\(--coral\)/);
  });
});
