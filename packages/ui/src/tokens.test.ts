import { describe, expect, it } from "vitest";
import { parseColor } from "./contrast";
import { renderTokensCss } from "./css";
import { TEXT_PAIRS } from "./pairs";
import {
  base,
  COLOR_TOKENS,
  caps,
  colorVar,
  FONT_SIZES,
  GAPS,
  ICON_SIZES,
  lux,
  RADII,
  safeArea,
  type ThemeName,
  themes,
} from "./tokens";

const css = renderTokensCss();

// Имена переменных, объявленных в блоке с данным селектором
function declared(selector: string): string[] {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return [];
  const body = css.slice(start, css.indexOf("}", start));
  return [...body.matchAll(/(--[\w-]+):/g)].map((m) => m[1] as string);
}

describe("темы", () => {
  it("обе темы задают один и тот же набор цветов", () => {
    expect(Object.keys(base).sort()).toEqual([...COLOR_TOKENS].sort());
    expect(Object.keys(lux).sort()).toEqual([...COLOR_TOKENS].sort());
  });

  it("каждое значение — разбираемый цвет", () => {
    for (const name of Object.keys(themes) as ThemeName[])
      for (const token of COLOR_TOKENS)
        expect(() => parseColor(themes[name][token]), `${name}.${token}`).not.toThrow();
  });

  it("грунты и цвета текста непрозрачны", () => {
    const opaque = new Set([...TEXT_PAIRS.map((pair) => pair.fg), "paper", "white"] as const);
    for (const name of Object.keys(themes) as ThemeName[])
      for (const token of opaque) expect(parseColor(themes[name][token])[3], `${name}.${token}`).toBe(1);
  });

  it("премиум отличается от основной темы", () => {
    expect(lux.paper).not.toBe(base.paper);
    expect(lux.ink).not.toBe(base.ink);
    expect(lux.coral).not.toBe(base.coral);
  });

  it("в премиуме нет чистого белого и чёрного", () => {
    const values = Object.values(lux).map((v) => v.toUpperCase());
    expect(values).not.toContain("#FFFFFF");
    expect(values).not.toContain("#000000");
  });

  it("в премиуме занятая дата выцветает, а не краснеет", () => {
    const [r, g, b] = parseColor(lux.busyInk);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(40);
  });
});

describe("шкалы", () => {
  it("кегли — фиксированный набор от 10 до 27", () => {
    expect(FONT_SIZES).toEqual([10, 11, 12.5, 13.5, 14, 15, 16, 19, 22, 23, 27]);
    for (const style of Object.values(caps)) expect(FONT_SIZES).toContain(style.size);
  });

  it("скругления, зазоры, иконки", () => {
    expect(RADII).toEqual([3, 8, 11, 14, 18, 22, 999]);
    expect(GAPS).toEqual([3, 5, 7, 9, 12]);
    expect(ICON_SIZES).toEqual([12, 14, 17, 20, 24, 26]);
  });
});

describe("безопасные зоны", () => {
  it("цепочка: Telegram → env() → ноль", () => {
    for (const side of ["t", "b", "l", "r"] as const) {
      expect(safeArea[`sa-${side}`]).toMatch(
        /^var\(--tg-safe-area-inset-\w+, env\(safe-area-inset-\w+, 0px\)\)$/,
      );
    }
    expect(safeArea["csa-t"]).toBe("var(--tg-content-safe-area-inset-top, 0px)");
  });

  it("верх и низ складывают обе зоны", () => {
    expect(safeArea["pad-t"]).toBe("calc(var(--sa-t) + var(--csa-t))");
    expect(safeArea["pad-b"]).toBe("calc(var(--sa-b) + var(--csa-b))");
  });
});

describe("tokens.css", () => {
  it("совпадает с tokens.ts (пересобрать: pnpm --filter @bayramm/ui css)", async () => {
    await expect(css).toMatchFileSnapshot("./tokens.css");
  });

  it("премиум переопределяет базовые токены, и только цвета", () => {
    const colorVars = COLOR_TOKENS.map(colorVar);
    expect(declared(":root")).toEqual(expect.arrayContaining(colorVars));
    expect(declared('[data-theme="lux"]')).toEqual(colorVars);
  });

  it("--peach и --coral-soft определены и в основной теме", () => {
    expect(declared(":root")).toEqual(expect.arrayContaining(["--peach", "--coral-soft"]));
  });

  it("баланс фигурных скобок", () => {
    expect(css.split("{").length).toBe(css.split("}").length);
  });
});
