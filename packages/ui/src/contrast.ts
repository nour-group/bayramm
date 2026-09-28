/* Контраст по WCAG 2.2 (относительная яркость sRGB). Полупрозрачный фон сначала
   накладывается на подложку — так же, как его увидит пользователь. */

/** Цвет как [r, g, b, a]: каналы 0–255, альфа 0–1 */
export type Rgba = readonly [number, number, number, number];

/** Разбирает #rgb, #rrggbb, rgb(r, g, b) и rgba(r, g, b, a) */
export function parseColor(css: string): Rgba {
  const value = css.trim();
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    const channel = (i: number) => Number.parseInt(full.slice(i, i + 2), 16);
    return [channel(0), channel(2), channel(4), 1];
  }
  const fn = value.match(/^rgba?\(([^)]+)\)$/i)?.[1];
  if (fn) {
    const parts = fn.split(",").map((p) => Number(p.trim()));
    if ((parts.length === 3 || parts.length === 4) && parts.every((n) => Number.isFinite(n))) {
      const [r = 0, g = 0, b = 0, a = 1] = parts;
      return [r, g, b, a];
    }
  }
  throw new Error(`не цвет: ${css}`);
}

/** Накладывает цвет с прозрачностью на непрозрачную подложку */
export function composite(top: Rgba, under: Rgba): Rgba {
  const [r, g, b, a] = top;
  return [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a), 1];
}

/** Относительная яркость по WCAG */
export function relativeLuminance([r, g, b]: Rgba): number {
  const lin = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Контраст текста на фоне, 1–21. Полупрозрачный фон накладывается на ground,
 * полупрозрачный текст — на получившийся фон.
 */
export function contrastRatio(fg: string, bg: string, ground = "#FFFFFF"): number {
  const under = parseColor(ground);
  if (under[3] !== 1) throw new Error(`подложка должна быть непрозрачной: ${ground}`);
  const back = composite(parseColor(bg), under);
  const front = composite(parseColor(fg), back);
  const a = relativeLuminance(front);
  const b = relativeLuminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
