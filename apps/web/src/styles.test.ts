import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { FONT_SIZES, GAPS, RADII } from "@bayramm/ui";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = readFileSync(createRequire(import.meta.url).resolve("@bayramm/ui/tokens.css"), "utf8");

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

describe("styles.css клиента", () => {
  it("скобки сбалансированы (ловушка №10)", () => {
    let depth = 0;
    for (const char of css) {
      if (char === "{") depth++;
      if (char === "}") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it("фрейм виджета Telegram — в его же color-scheme: в тёмной теме без чёрного фона", () => {
    expect(css).toMatch(/\.tg-login iframe \{\s*color-scheme: light dark;\s*\}/);
  });

  it("все переменные — из токенов @bayramm/ui; --tg-* ставит SDK Telegram", () => {
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map(([, name]) => name));
    const missing = [...used].filter((name) => !name?.startsWith("--tg-") && !tokens.includes(`${name}:`));
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

  it("высота: 100vh, а dvh и высота Telegram — только под @supports (ловушка №4)", () => {
    expect(declarationsOf(".app")).toMatch(/min-height:\s*100vh/);
    const supported = atRuleBody(/@supports \(min-height: 100dvh\)/);
    expect(supported).toMatch(/min-height:\s*var\(--tg-viewport-stable-height, 100dvh\)/);
    expect(css.indexOf("min-height: 100vh")).toBeLessThan(css.indexOf("@supports (min-height: 100dvh)"));
  });

  it("верх и низ складывают обе безопасные зоны: --pad-t и --pad-b", () => {
    expect(declarationsOf(".top")).toMatch(/padding:\s*calc\(var\(--pad-t\)/);
    expect(declarationsOf(".tabs")).toMatch(/var\(--pad-b\)/);
    expect(declarationsOf(".action-bar")).toMatch(/var\(--pad-b\)/);
    expect(css).not.toMatch(/--sa-t\)|--sa-b\)/);
  });

  it("overflow-y только вместе с overflow-x (ловушка №2)", () => {
    for (const rule of rules) {
      if (/overflow-y:/.test(rule.body)) expect(rule.body, rule.selectors.join()).toMatch(/overflow-x:/);
      if (/overflow-x:/.test(rule.body)) expect(rule.body, rule.selectors.join()).toMatch(/overflow-y:/);
    }
  });

  it(":hover — только внутри @media (hover: hover) (ловушка №6)", () => {
    const hover = atRuleBody(/@media \(hover: hover\)/);
    const outside = css.replace(hover, "");
    expect(outside).not.toMatch(/:hover/);
    expect(hover).toMatch(/:hover/);
  });

  it("три поля фильтров каталога — в строку с 560px: правило того же веса, что «район во всю ширину»", () => {
    // Раньше там стояло .filters .field:last-child — вес меньше, и район растягивался и на компьютере
    const wide = atRuleBody(/@media \(min-width: 560px\)/);
    expect(wide).toMatch(/\.filters \.field:nth-child\(3\):last-child \{\s*grid-column: auto;/);
  });

  it("лента разделов на телефоне гаснет у края (видно, что дальше есть ещё), с планшета — нет", () => {
    const strip = declarationsOf(".cat-switch ul");
    expect(strip).toMatch(/-webkit-mask-image: linear-gradient/);
    expect(strip).toMatch(/(^|;)\s*mask-image: linear-gradient/);
    expect(atRuleBody(/@media \(min-width: 768px\)/)).toMatch(/mask-image: none/);
  });

  it("выбранное объявлено после наведения (ловушка №7)", () => {
    const hover = css.search(/@media \(hover: hover\)/);
    for (const selector of ['.lang button[aria-pressed="true"]', '.tabs a[aria-current="page"]'])
      expect(css.indexOf(selector), selector).toBeGreaterThan(hover);
  });

  it.each([
    ".btn",
    ".icon-btn",
    ".link-btn",
    ".lang button",
    ".field-input",
    ".contact-phone",
    ".brand",
    ".skip",
  ])("%s: зона нажатия не меньше 44px", (selector) => {
    expect(declarationsOf(selector)).toMatch(
      /min-height:\s*(var\(--hit-min\)|4[4-9]px|5\dpx)|height:\s*var\(--hit-min\)/,
    );
  });

  it(".fav-btn: рисунок 36px, зона нажатия 44px+ — невидимым слоем (::after)", () => {
    const body = declarationsOf(".fav-btn");
    const size = Number(/width:\s*(\d+)px/.exec(body)?.[1]);
    const inset = Number(/inset:\s*-(\d+)px/.exec(declarationsOf(".fav-btn::after"))?.[1]);
    expect(size + 2 * inset).toBeGreaterThanOrEqual(44);
    // Своё правило: в общем списке с position: relative сердечко уехало бы в поток (ловушка №8)
    const shared = rules.filter((rule) => rule.selectors.includes(".fav-btn") && rule.selectors.length > 1);
    expect(shared).toEqual([]);
    expect(body).toMatch(/position:\s*absolute/);
  });

  it("нижняя панель — четыре вкладки", () => {
    expect(declarationsOf(".tabs")).toMatch(/grid-template-columns:\s*repeat\(4, 1fr\)/);
  });

  it("отказ и отправка в форме — одной ширины", () => {
    expect(declarationsOf(".form-bar")).toMatch(/grid-template-columns:\s*1fr 1fr/);
    expect(declarationsOf(".two-buttons")).toMatch(/grid-template-columns:\s*1fr 1fr/);
  });

  it("анимация отключается при prefers-reduced-motion", () => {
    expect(atRuleBody(/@media \(prefers-reduced-motion: reduce\)/)).toMatch(/animation:\s*none/);
  });

  it("фокус с клавиатуры виден", () => {
    expect(declarationsOf(":focus-visible")).toMatch(/outline:\s*3px solid var\(--coral\)/);
  });

  it("раскрывашки <details> — без системного треугольника, со своим уголком", () => {
    expect(declarationsOf(".doc summary")).toMatch(/list-style:\s*none/);
    expect(declarationsOf(".doc summary::-webkit-details-marker")).toMatch(/display:\s*none/);
    expect(declarationsOf(".doc[open] summary::after")).toMatch(/transform:/);
  });

  it("контролы — из набора @bayramm/ui/kit.css: своих правил для системных нет", () => {
    // Выпадающий список, выбор, календарь, число — в kit.css (свои тесты в packages/ui)
    for (const selector of ["select", ".select", ".choice", ".cal-day", ".stepper", ".field-button"])
      expect(rules.some((rule) => rule.selectors.some((s) => s.split(/[\s>+~:]/)[0] === selector))).toBe(
        false,
      );
    expect(css).not.toMatch(/accent-color|appearance/);
    // kit.css — раньше стилей клиента: клиент может подправить вид, не наоборот
    const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    expect(main.indexOf('"@bayramm/ui/kit.css"')).toBeGreaterThan(main.indexOf('"@bayramm/ui/tokens.css"'));
    expect(main.indexOf('"@bayramm/ui/kit.css"')).toBeLessThan(main.indexOf('"./styles.css"'));
  });

  it("узор в data-URI без «#»", () => {
    for (const [uri] of css.matchAll(/url\("data:[^"]+"\)/g)) expect(uri).not.toContain("#");
  });
});
