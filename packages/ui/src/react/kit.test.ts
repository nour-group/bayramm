import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FONT_SIZES, GAPS, RADII } from "../tokens";

/* Те же правила, что у стилей приложений (apps/*\/src/styles.test.ts): набор подключают
   все три приложения, и нарушение здесь — нарушение везде. */

const css = readFileSync(new URL("./kit.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");

/** Правила без вложенности: селектор → объявления (правила внутри @media тоже попадают) */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector = "", body = ""]) => ({
  selectors: selector.split(",").map((s) => s.trim()),
  body,
}));

const declarationsOf = (selector: string) =>
  rules
    .filter((rule) => rule.selectors.includes(selector))
    .map((rule) => rule.body)
    .join(";");

/** Тело @media / @supports с заданным условием */
function atRuleBody(prelude: RegExp): string {
  const start = css.search(prelude);
  if (start < 0) return "";
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
  }
  return "";
}

describe("kit.css", () => {
  it("скобки сбалансированы (ловушка №10)", () => {
    let depth = 0;
    for (const char of css) {
      if (char === "{") depth++;
      if (char === "}") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it("все переменные — из токенов", () => {
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map(([, name]) => name));
    const missing = [...used].filter((name) => !tokens.includes(`${name}:`));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(30);
  });

  it("цвета не вписаны числом", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  it("кегли, скругления и зазоры — только из шкал", () => {
    expect(css).not.toMatch(/font-size:\s*\d/);
    expect(css).not.toMatch(/border-radius:\s*\d/);
    expect(css).not.toMatch(/\bgap:\s*\d/);
    const sizes = new Set([...css.matchAll(/--fs-([\d-]+)/g)].map(([, s]) => Number(s?.replace("-", "."))));
    expect([...sizes].filter((s) => !(FONT_SIZES as readonly number[]).includes(s))).toEqual([]);
    const radii = new Set([...css.matchAll(/--r-(\d+)/g)].map(([, r]) => Number(r)));
    expect([...radii].filter((r) => !(RADII as readonly number[]).includes(r))).toEqual([]);
    const gaps = new Set([...css.matchAll(/--gap-(\d+)/g)].map(([, g]) => Number(g)));
    expect([...gaps].filter((g) => !(GAPS as readonly number[]).includes(g))).toEqual([]);
  });

  it("внутренние отступы — только чётные", () => {
    const paddings = [...css.matchAll(/padding(?:-[a-z]+)?:\s*([^;]+);/g)].flatMap(([, value]) =>
      [...(value ?? "").matchAll(/(?<![\w-])(\d+)px/g)].map(([, n]) => Number(n)),
    );
    expect(paddings.filter((n) => n % 2 !== 0)).toEqual([]);
  });

  it("overflow-y только вместе с overflow-x (ловушка №2)", () => {
    for (const rule of rules) {
      if (/overflow-y:/.test(rule.body)) expect(rule.body, rule.selectors.join()).toMatch(/overflow-x:/);
      if (/overflow-x:/.test(rule.body)) expect(rule.body, rule.selectors.join()).toMatch(/overflow-y:/);
    }
  });

  it("высота шторки и диалога: сначала vh, dvh — только под @supports (ловушка №4)", () => {
    expect(declarationsOf(".ui-sheet")).toMatch(/max-height:\s*85vh/);
    expect(declarationsOf(".ui-dialog")).toMatch(/max-height:\s*85vh/);
    const supported = atRuleBody(/@supports \(max-height: 85dvh\)/);
    expect(supported).toMatch(/max-height:\s*85dvh/);
    const start = css.search(/@supports \(max-height: 85dvh\)/);
    const outside = css.slice(0, start) + css.slice(css.indexOf(supported, start) + supported.length);
    expect(outside.replace("@supports (max-height: 85dvh)", "")).not.toMatch(/dvh/);
    expect(start).toBeGreaterThan(css.indexOf("max-height: 85vh"));
  });

  it("шторка и диалог стоят над нижней безопасной зоной — обе зоны, --pad-b", () => {
    expect(declarationsOf(".ui-sheet")).toMatch(/padding:[^;]*var\(--pad-b\)/);
    expect(declarationsOf(".ui-dialog")).toMatch(/padding:[^;]*var\(--pad-b\)/);
    expect(css).not.toMatch(/--sa-b\)|--sa-t\)/);
  });

  it(":hover — только внутри @media (hover: hover) (ловушка №6)", () => {
    const hover = atRuleBody(/@media \(hover: hover\)/);
    expect(css.replace(hover, "")).not.toMatch(/:hover/);
    expect(hover).toMatch(/:hover/);
  });

  it("выбранное объявлено после наведения (ловушка №7)", () => {
    const hover = css.search(/@media \(hover: hover\)/);
    for (const selector of [
      ".ui-option.is-active",
      ".ui-radios-pill .ui-radio.is-on",
      ".ui-radios-segmented .ui-radio.is-on",
      ".ui-cal-day.is-selected",
    ])
      expect(css.indexOf(`${selector} {`), selector).toBeGreaterThan(hover);
  });

  it("абсолютно позиционированное не делит правило с relative (ловушка №8)", () => {
    for (const rule of rules.filter((r) => /position:\s*(absolute|relative)/.test(r.body)))
      expect(rule.selectors, rule.body).toHaveLength(1);
  });

  it.each([
    ".ui-btn",
    ".ui-icon-btn",
    ".ui-select",
    ".ui-option",
    ".ui-check",
    ".ui-switch",
    ".ui-radio",
    ".ui-cal-day",
    ".ui-number-input",
    ".ui-search-input",
    ".ui-drop-face",
  ])("%s: зона нажатия не меньше 44px", (selector) => {
    expect(declarationsOf(selector)).toMatch(
      /min-height:\s*(var\(--hit-min\)|4[4-9]px|[5-9]\dpx)|height:\s*var\(--hit-min\)/,
    );
  });

  it("фокус с клавиатуры виден у каждого контрола", () => {
    for (const selector of [
      ".ui-btn:focus-visible",
      ".ui-icon-btn:focus-visible",
      ".ui-select:focus-visible",
      ".ui-cal .ui-cal-day:focus-visible",
      ".ui-native:focus-visible + .ui-check-box",
      ".ui-native:focus-visible + .ui-switch-track",
      ".ui-native:focus-visible + .ui-drop-face",
      ".ui-radio:focus-within",
      ".ui-radio:has(.ui-native:focus-visible)",
    ])
      expect(declarationsOf(selector), selector).toMatch(/outline:\s*3px solid var\(--coral\)/);
  });

  it("занятый день выцветает, а не краснеет; в календаре для показа — читается", () => {
    const busy = declarationsOf(".ui-cal-day.is-busy");
    expect(busy).toMatch(/color:\s*var\(--busy-ink\)/);
    expect(busy).not.toMatch(/coral|berry/);
    // Только показ: число занятого дня — текст с парой muted/busy (pairs.ts), не красный
    const view = declarationsOf(".ui-cal.is-view .ui-cal-day.is-busy");
    expect(view).toMatch(/color:\s*var\(--muted\)/);
    expect(view).not.toMatch(/coral|berry/);
    expect(css.indexOf(".ui-cal.is-view .ui-cal-day.is-busy")).toBeGreaterThan(
      css.indexOf(".ui-cal-day.is-busy {"),
    );
  });

  it('день календаря с фокусом виден и под [tabindex="-1"]:focus приложений', () => {
    // Вес (0,3,0) выше (0,2,0) у правила приложений «программный фокус без рамки»
    expect(declarationsOf(".ui-cal .ui-cal-day:focus-visible")).toMatch(/outline:\s*3px solid/);
  });

  it("движение отключается при prefers-reduced-motion", () => {
    const reduced = atRuleBody(/@media \(prefers-reduced-motion: reduce\)/);
    expect(reduced).toMatch(/animation:\s*none/);
    expect(reduced).toMatch(/transition:\s*none/);
    for (const [, name] of css.matchAll(/animation:\s*(ui-[a-z-]+)/g))
      expect(css, name).toMatch(new RegExp(`@keyframes ${name}\\b`));
  });

  it("каждый класс ui-* из компонентов описан в kit.css, и наоборот", () => {
    const dir = new URL("./", import.meta.url);
    const code = readdirSync(dir)
      .filter((name) => /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name))
      .map((name) => readFileSync(new URL(name, dir), "utf8"))
      .join("\n");
    const inCode = new Set([...code.matchAll(/(?<![\w-])(ui-[a-z0-9-]+)/g)].map(([, name = ""]) => name));
    // Составные имена из шаблонов: ui-${kind}, ui-select-${size}, ui-radios-${variant}, ui-toast-${tone}
    for (const name of [
      "ui-check",
      "ui-switch",
      "ui-check-label",
      "ui-switch-label",
      "ui-select-field",
      "ui-select-compact",
      "ui-radios-pill",
      "ui-radios-row",
      "ui-radios-segmented",
      "ui-toast-error",
    ])
      inCode.add(name);
    const inCss = new Set([...css.matchAll(/\.(ui-[a-z0-9-]+)/g)].map(([, name = ""]) => name));
    // Классы-метки без своих правил: по ним находят элементы тесты и приложения
    // ui-live — живая область, её не делают inert модальные слои; ui-cal-pad — пустая клетка
    const markers = new Set([
      "ui-toast-info",
      "ui-toast-success",
      "ui-radio-label",
      "ui-cal",
      "ui-live",
      "ui-cal-pad",
    ]);
    const missing = [...inCode].filter(
      (name) => !name.endsWith("-") && !inCss.has(name) && !markers.has(name),
    );
    expect(missing).toEqual([]);
    expect([...inCss].filter((name) => !inCode.has(name) && name !== "ui-lock")).toEqual([]);
  });
});
