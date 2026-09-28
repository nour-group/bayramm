import { describe, expect, it } from "vitest";
import { composite, contrastRatio, parseColor } from "./contrast";
import { EXEMPT_PAIRS, MIN_CONTRAST, TEXT_PAIRS } from "./pairs";
import { type ColorToken, type Palette, type ThemeName, themes } from "./tokens";

/* Полупрозрачный фон (линии, подложки премиума) кладём и на фон экрана, и на карточку
   и берём худший случай — компонент может оказаться на любом из них. */
function worstRatio(palette: Palette, fg: ColorToken, bg: ColorToken): number {
  return Math.min(
    ...[palette.paper, palette.white].map((ground) => contrastRatio(palette[fg], palette[bg], ground)),
  );
}

describe("формула контраста", () => {
  it("крайние случаи", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#6F6580", "#6F6580")).toBe(1);
  });

  it("известные значения", () => {
    expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });

  it("полупрозрачный фон накладывается на подложку", () => {
    expect(composite(parseColor("rgba(0, 0, 0, 0.5)"), parseColor("#FFFFFF"))).toEqual([
      127.5, 127.5, 127.5, 1,
    ]);
    expect(contrastRatio("#000000", "rgba(0, 0, 0, 0)", "#FFFFFF")).toBeCloseTo(21, 5);
  });

  it("не принимает не-цвета", () => {
    expect(() => parseColor("coral")).toThrow();
    expect(() => parseColor("#12345")).toThrow();
  });
});

describe.each(Object.keys(themes) as ThemeName[])("контраст текста, тема %s", (name) => {
  const palette = themes[name];

  it.each(TEXT_PAIRS.map((pair) => [`${pair.fg} на ${pair.bg} (${pair.size}) — ${pair.use}`, pair] as const))(
    "%s",
    (_, pair) => {
      const ratio = worstRatio(palette, pair.fg, pair.bg);
      expect(
        ratio,
        `${palette[pair.fg]} на ${palette[pair.bg]}: ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(MIN_CONTRAST[pair.size]);
    },
  );

  it("исключённые пары существуют в палитре", () => {
    for (const { fg, bg } of EXEMPT_PAIRS) {
      expect(palette[fg]).toBeTruthy();
      expect(palette[bg]).toBeTruthy();
    }
  });
});

/* Значения, подобранные под WCAG AA при переносе. Тест держит таблицу README.md честной:
   «было» действительно не проходит, «стало» — текущее значение токена. */
const ADJUSTED: readonly { theme: ThemeName; token: ColorToken; before: string; after: string }[] = [
  { theme: "base", token: "mutedLt", before: "#A198AC", after: "#786D87" },
  { theme: "base", token: "coral", before: "#EE6C4D", after: "#ED6545" },
  { theme: "base", token: "coralDeep", before: "#C74627", after: "#BB4225" },
  { theme: "base", token: "teal", before: "#2E9E93", after: "#237870" },
  { theme: "base", token: "accentHover", before: "#E2593A", after: "#D74120" },
  { theme: "lux", token: "muted", before: "#6A6357", after: "#625C51" },
  { theme: "lux", token: "peach", before: "#A3302A", after: "#DA756F" },
];

describe("подобранные значения", () => {
  it.each(ADJUSTED.map((a) => [`${a.theme}.${a.token}: ${a.before} → ${a.after}`, a] as const))(
    "%s",
    (_, a) => {
      const palette = themes[a.theme];
      expect(palette[a.token]).toBe(a.after);
      const before: Palette = { ...palette, [a.token]: a.before };
      const failing = TEXT_PAIRS.filter(
        (pair) =>
          (pair.fg === a.token || pair.bg === a.token) &&
          worstRatio(before, pair.fg, pair.bg) < MIN_CONTRAST[pair.size],
      );
      expect(failing.length, "старое значение должно проваливать хотя бы одну пару").toBeGreaterThan(0);
    },
  );
});
