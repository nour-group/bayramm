// Свои шрифты: объявления @font-face и сами файлы. Файлы разбираются по-настоящему
// (WOFF2 → таблица cmap): тест падает, если в шрифте нет букв, которые мы обещаем, —
// прежде всего узбекских ʻ (U+02BB) и ʼ (U+02BC).
import { existsSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./fonts.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

interface Face {
  readonly family: string;
  readonly weight: string;
  readonly display: string;
  readonly file: string;
  readonly range: string;
}

const faces: Face[] = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body = ""]) => {
  const value = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? "";
  return {
    family: value("font-family").replaceAll('"', ""),
    weight: value("font-weight"),
    display: value("font-display"),
    file: /url\("\.\.\/fonts\/([^"]+)"\)/.exec(body)?.[1] ?? "",
    range: value("unicode-range").replace(/\s+/g, " "),
  };
});

const fontUrl = (file: string) => new URL(`../fonts/${file}`, import.meta.url);

// ── WOFF2 → множество кодов из cmap ────────────────────────────────────────
// Формат: https://www.w3.org/TR/WOFF2/ — заголовок, каталог таблиц, один поток Brotli.
// cmap в WOFF2 не преобразуется, поэтому достаточно найти её в распакованном потоке.

const GLYF = 10;
const LOCA = 11;

function readBase128(bytes: Uint8Array, at: number): [value: number, next: number] {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = bytes[at + i] ?? 0;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, at + i + 1];
  }
  throw new Error("UIntBase128 длиннее 5 байт");
}

function cmapOf(file: Uint8Array): DataView {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (view.getUint32(0) !== 0x774f4632) throw new Error("не WOFF2");
  const numTables = view.getUint16(12);
  const compressedSize = view.getUint32(20);
  let at = 48;
  let offset = 0;
  let cmap: { offset: number; length: number } | null = null;
  for (let i = 0; i < numTables; i++) {
    const flags = file[at++] ?? 0;
    const known = flags & 0x3f;
    if (known === 0x3f) at += 4; // произвольный тег — не cmap
    const version = flags >> 6;
    let length: number;
    [length, at] = readBase128(file, at);
    // Преобразованная таблица хранит свою длину отдельно: glyf/loca — при версии 0, прочие — при ненулевой
    const transformed = known === GLYF || known === LOCA ? version === 0 : version !== 0;
    if (transformed) [length, at] = readBase128(file, at);
    if (known === 0) cmap = { offset, length };
    offset += length;
  }
  if (cmap === null) throw new Error("нет таблицы cmap");
  const stream = brotliDecompressSync(file.subarray(at, at + compressedSize));
  return new DataView(stream.buffer, stream.byteOffset + cmap.offset, cmap.length);
}

/** Коды из подтаблиц cmap формата 4 и 12 (Unicode), у которых есть глиф */
function codePoints(cmap: DataView): Set<number> {
  const codes = new Set<number>();
  const count = cmap.getUint16(2);
  for (let i = 0; i < count; i++) {
    const sub = cmap.getUint32(4 + i * 8 + 4);
    const format = cmap.getUint16(sub);
    if (format === 4) {
      const segs = cmap.getUint16(sub + 6) / 2;
      const ends = sub + 14;
      const starts = ends + segs * 2 + 2;
      const deltas = starts + segs * 2;
      const ranges = deltas + segs * 2;
      for (let s = 0; s < segs; s++) {
        const end = cmap.getUint16(ends + s * 2);
        const start = cmap.getUint16(starts + s * 2);
        const delta = cmap.getInt16(deltas + s * 2);
        const rangeOffset = cmap.getUint16(ranges + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph = rangeOffset === 0 ? c : cmap.getUint16(ranges + s * 2 + rangeOffset + (c - start) * 2);
          if (rangeOffset === 0 || glyph !== 0) glyph = (glyph + delta) & 0xffff;
          if (glyph !== 0) codes.add(c);
        }
      }
    } else if (format === 12) {
      const groups = cmap.getUint32(sub + 12);
      for (let g = 0; g < groups; g++) {
        const start = cmap.getUint32(sub + 16 + g * 12);
        const end = cmap.getUint32(sub + 20 + g * 12);
        for (let c = start; c <= end; c++) codes.add(c);
      }
    }
  }
  return codes;
}

const codesOf = (file: string) => codePoints(cmapOf(new Uint8Array(readFileSync(fontUrl(file)))));

const chars = (text: string) => [...text].map((ch) => ch.codePointAt(0) as number);
const hex = (code: number) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;

const LATIN = chars("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789«»—–·…’‘ʻʼ");
const CYRILLIC = chars("АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя№");

describe("fonts.css", () => {
  it("Manrope и Unbounded: latin и cyrillic, и больше ничего", () => {
    expect(faces.map((f) => `${f.family}/${f.file}`).sort()).toEqual([
      "Manrope/manrope-cyrillic.woff2",
      "Manrope/manrope-latin.woff2",
      "Unbounded/unbounded-cyrillic.woff2",
      "Unbounded/unbounded-latin.woff2",
    ]);
  });

  it("font-display: swap и диапазон начертаний у каждого", () => {
    for (const face of faces) {
      expect(face.display, face.file).toBe("swap");
      expect(face.weight, face.file).toMatch(/^\d00 \d00$/);
    }
  });

  it("файлы на месте; лицензия OFL лежит рядом", () => {
    for (const face of faces) expect(existsSync(fontUrl(face.file)), face.file).toBe(true);
    for (const family of ["Manrope", "Unbounded"]) {
      expect(readFileSync(fontUrl(`OFL-${family}.txt`), "utf8")).toContain("SIL Open Font License");
    }
  });

  it("latin-подмножество по unicode-range включает ʻ и ʼ", () => {
    for (const face of faces.filter((f) => f.file.endsWith("-latin.woff2"))) {
      expect(face.range, face.file).toContain("U+02BB-02BC");
    }
  });

  it.each(faces.map((f) => [f.file, f] as const))("%s: в файле есть все обещанные буквы", (file, face) => {
    const codes = codesOf(file);
    const expected = file.endsWith("-latin.woff2") ? LATIN : CYRILLIC;
    expect(expected.filter((c) => !codes.has(c)).map(hex), face.family).toEqual([]);
  });
});
