import {
  base,
  CARD_ARCH,
  COLOR_TOKENS,
  colorVar,
  durations,
  durationVar,
  easings,
  easingVar,
  FONT_SIZES,
  fontSizeVar,
  fonts,
  fontVar,
  GAPS,
  gapVar,
  HIT_MIN,
  ICON_SIZES,
  iconVar,
  lux,
  type Palette,
  RADII,
  REDUCED_DURATION,
  radiusVar,
  safeArea,
  THEME_ATTRIBUTE,
} from "./tokens";

const decl = (name: string, value: string | number) => `  ${name}: ${value};`;
const px = (n: number) => `${n}px`;

// В CSS шестнадцатеричные цвета строчными — так их пишет форматтер Biome
const colors = (palette: Palette) =>
  COLOR_TOKENS.map((token) =>
    decl(
      colorVar(token),
      palette[token].replace(/^#[0-9A-F]+$/i, (hex) => hex.toLowerCase()),
    ),
  );

/**
 * Текст src/tokens.css. Файл не правят руками: тест tokens.test.ts сверяет его с этой функцией,
 * пересобрать — pnpm --filter @bayramm/ui css.
 */
export function renderTokensCss(): string {
  const root = [
    "  /* цвета: основная тема */",
    ...colors(base),
    "",
    "  /* шрифты и кегли */",
    ...Object.entries(fonts).map(([name, value]) => decl(fontVar(name as keyof typeof fonts), value)),
    ...FONT_SIZES.map((size) => decl(fontSizeVar(size), px(size))),
    "",
    "  /* скругления, зазоры, иконки, зона нажатия */",
    ...RADII.map((r) => decl(radiusVar(r), px(r))),
    decl("--r-arch", CARD_ARCH),
    ...GAPS.map((g) => decl(gapVar(g), px(g))),
    ...ICON_SIZES.map((s) => decl(iconVar(s), px(s))),
    decl("--hit-min", px(HIT_MIN)),
    "",
    "  /* движение */",
    ...Object.entries(durations).map(([name, ms]) =>
      decl(durationVar(name as keyof typeof durations), `${ms}ms`),
    ),
    ...Object.entries(easings).map(([name, value]) => decl(easingVar(name as keyof typeof easings), value)),
    "",
    "  /* безопасные зоны: Telegram → env() → 0; верх и низ складывают обе зоны */",
    ...Object.entries(safeArea).map(([name, value]) => decl(`--${name}`, value)),
  ];
  const reduced = Object.keys(durations).map(
    (name) => `  ${decl(durationVar(name as keyof typeof durations), REDUCED_DURATION)}`,
  );
  return [
    "/* Дизайн-токены Bayramm. СГЕНЕРИРОВАНО из src/tokens.ts (src/css.ts) — руками не править.",
    "   Пересобрать: pnpm --filter @bayramm/ui css */",
    "",
    ":root {",
    ...root,
    "}",
    "",
    "/* Премиум «Suzani»: переопределяет те же базовые токены, не отдельные классы */",
    `[${THEME_ATTRIBUTE}="lux"] {`,
    ...colors(lux),
    "}",
    "",
    "@media (prefers-reduced-motion: reduce) {",
    "  :root {",
    ...reduced,
    "  }",
    "}",
    "",
  ].join("\n");
}
