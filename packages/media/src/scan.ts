// Разбор структуры WebP, JPEG и PNG по байтам — без декодирования пикселей.
//
// Результат — размеры и список частей файла, у каждой отмечено, метаданные это
// или нет. На нём стоят и проверка (inspect.ts), и очистка (strip.ts): что одна
// считает метаданными, то другая и вырезает.
//
// Разбор строгий: неизвестная структура, обрезанный файл, лишние байты после
// конца изображения — ошибка, а не «как-нибудь прочитаем». Всё, что браузер
// кладёт в результат canvas.toBlob, разбирается; экзотика (12-битный JPEG,
// арифметическое кодирование, CMYK) — unsupported_format.

import type { ImageFormat } from "./constants";
import { ImageError } from "./errors";

/** Вид метаданных. Интерфейсу хватает самого факта, но в логах полезно видеть, что нашлось. */
export type MetadataKind =
  /** EXIF: камера, дата, GPS-координаты */
  | "exif"
  /** XMP: то же и больше, в XML */
  | "xmp"
  /** IPTC (Photoshop): автор, подписи, место */
  | "iptc"
  /** Комментарий JPEG */
  | "comment"
  /** Текстовые поля PNG */
  | "text"
  /** Встроенная миниатюра: может показывать исходный, необрезанный кадр */
  | "thumbnail"
  /** Прочие служебные блоки: MPF (доп. кадры, карты глубины), дата PNG, неизвестные */
  | "other";

export interface Part {
  readonly start: number;
  readonly end: number;
  /** null — часть изображения; иначе — метаданные, которые можно вырезать */
  readonly meta: MetadataKind | null;
}

export interface Scan {
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
  readonly animated: boolean;
  readonly parts: readonly Part[];
  /** Метаданные, объявленные флагами без отдельной части (флаги VP8X) */
  readonly flagged: readonly MetadataKind[];
  /** WebP VP8X: позиция байта флагов — очистка сбрасывает в нём биты EXIF и XMP */
  readonly vp8xFlagsAt: number | null;
}

const corrupt = (message: string) => new ImageError("corrupt", message);
const unsupported = (message: string) => new ImageError("unsupported_format", message);

// ── чтение байтов ──────────────────────────────────────────────────────────
// Индексы проверяются до чтения: `?? 0` только успокаивает типы

function at(b: Uint8Array, i: number): number {
  return b[i] ?? 0;
}

function u16be(b: Uint8Array, i: number): number {
  return (at(b, i) << 8) | at(b, i + 1);
}

function u32be(b: Uint8Array, i: number): number {
  return at(b, i) * 0x1000000 + ((at(b, i + 1) << 16) | (at(b, i + 2) << 8) | at(b, i + 3));
}

function u16le(b: Uint8Array, i: number): number {
  return at(b, i) | (at(b, i + 1) << 8);
}

function u24le(b: Uint8Array, i: number): number {
  return at(b, i) | (at(b, i + 1) << 8) | (at(b, i + 2) << 16);
}

function u32le(b: Uint8Array, i: number): number {
  return u24le(b, i) + at(b, i + 3) * 0x1000000;
}

/** Байты начиная с i совпадают с ASCII-строкой (сигнатуры, коды чанков). */
function hasAscii(b: Uint8Array, i: number, text: string): boolean {
  if (i + text.length > b.length) return false;
  for (let k = 0; k < text.length; k++) {
    if (b[i + k] !== text.charCodeAt(k)) return false;
  }
  return true;
}

function ascii(b: Uint8Array, i: number, length: number): string {
  let out = "";
  for (let k = 0; k < length; k++) out += String.fromCharCode(at(b, i + k));
  return out;
}

// ── определение формата ────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Формат по сигнатуре; null — не WebP, не JPEG и не PNG. */
export function sniffFormat(b: Uint8Array): ImageFormat | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v)) return "png";
  if (hasAscii(b, 0, "RIFF") && hasAscii(b, 8, "WEBP")) return "webp";
  return null;
}

export function scanImage(b: Uint8Array): Scan {
  switch (sniffFormat(b)) {
    case "jpeg":
      return scanJpeg(b);
    case "png":
      return scanPng(b);
    case "webp":
      return scanWebp(b);
    case null:
      throw unsupported("не WebP, JPEG или PNG");
  }
}

// ── JPEG ───────────────────────────────────────────────────────────────────
// Маркеры до SOS, затем энтропийные данные до следующего маркера (FF, за которым
// не 00 и не RSTn), и так до EOI. После EOI байтов быть не должно: туда телефоны
// дописывают «живые фото» (видео со звуком) и служебные блоки.

const SOF_SUPPORTED = new Set([0xc0, 0xc1, 0xc2]); // baseline, extended, progressive (Хаффман)
// lossless, иерархические и арифметические — браузеры их не показывают или показывают не все
const SOF_UNSUPPORTED = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf]);
const TABLES = new Set([0xc4, 0xdb, 0xdd]); // DHT, DQT, DRI

function jpegAppKind(b: Uint8Array, marker: number, start: number, end: number): MetadataKind | null {
  switch (marker) {
    case 0xe0: // APP0: JFIF без миниатюры — не метаданные
      if (hasAscii(b, start, "JFIF\0") && end - start >= 14) {
        return at(b, start + 12) > 0 && at(b, start + 13) > 0 ? "thumbnail" : null;
      }
      return hasAscii(b, start, "JFXX\0") ? "thumbnail" : "other";
    case 0xe1:
      if (hasAscii(b, start, "Exif\0")) return "exif";
      if (hasAscii(b, start, "http://ns.adobe.com/")) return "xmp";
      return "other";
    case 0xe2: // ICC-профиль нужен для верных цветов; MPF и прочее — нет
      return hasAscii(b, start, "ICC_PROFILE\0") ? null : "other";
    case 0xed:
      return "iptc";
    case 0xee: // Adobe: преобразование цвета, влияет на декодирование
      return hasAscii(b, start, "Adobe") ? null : "other";
    default:
      return "other";
  }
}

/** Конец энтропийных данных скана: позиция следующего маркера. */
function jpegScanEnd(b: Uint8Array, from: number): number {
  let i = from;
  for (;;) {
    i = b.indexOf(0xff, i);
    if (i < 0 || i + 1 >= b.length) throw corrupt("JPEG: данные скана оборваны");
    const next = at(b, i + 1);
    // FF 00 — экранированный байт данных, FF D0…D7 — маркеры перезапуска внутри скана
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
      i += 2;
    } else if (next === 0xff) {
      i += 1; // байты-заполнители перед маркером
    } else {
      return i;
    }
  }
}

function scanJpeg(b: Uint8Array): Scan {
  const n = b.length;
  const parts: Part[] = [{ start: 0, end: 2, meta: null }];
  let pos = 2;
  let width = 0;
  let height = 0;
  let frame = false;
  let scanned = false;

  for (;;) {
    const start = pos;
    if (pos >= n || b[pos] !== 0xff) throw corrupt("JPEG: ожидался маркер");
    while (pos < n && b[pos] === 0xff) pos++;
    if (pos >= n) throw corrupt("JPEG: файл оборван");
    const marker = at(b, pos);
    pos++;

    if (marker === 0xd9) {
      parts.push({ start, end: pos, meta: null });
      break;
    }
    if (marker === 0x00 || marker === 0xd8) throw corrupt("JPEG: неожиданный маркер");
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push({ start, end: pos, meta: null }); // маркеры без длины
      continue;
    }

    if (pos + 2 > n) throw corrupt("JPEG: файл оборван");
    const length = u16be(b, pos);
    if (length < 2 || pos + length > n) throw corrupt("JPEG: неверная длина сегмента");
    const data = pos + 2;
    let end = pos + length;
    let meta: MetadataKind | null = null;

    if (SOF_SUPPORTED.has(marker)) {
      if (frame) throw corrupt("JPEG: второй кадр");
      if (length < 8) throw corrupt("JPEG: короткий SOF");
      const precision = at(b, data);
      height = u16be(b, data + 1);
      width = u16be(b, data + 3);
      const components = at(b, data + 5);
      if (precision !== 8) throw unsupported("JPEG: не 8 бит на канал");
      if (components !== 1 && components !== 3) throw unsupported("JPEG: не оттенки серого и не YCbCr");
      if (width === 0 || height === 0) throw unsupported("JPEG: высота задана после скана (DNL)");
      frame = true;
    } else if (SOF_UNSUPPORTED.has(marker)) {
      throw unsupported("JPEG: lossless, иерархический или арифметический");
    } else if (marker === 0xda) {
      if (!frame) throw corrupt("JPEG: скан до кадра");
      end = jpegScanEnd(b, end);
      scanned = true;
    } else if (marker >= 0xe0 && marker <= 0xef) {
      meta = jpegAppKind(b, marker, data, pos + length);
    } else if (marker === 0xfe) {
      meta = "comment";
    } else if (!TABLES.has(marker)) {
      throw corrupt(`JPEG: неизвестный маркер 0x${marker.toString(16)}`);
    }

    parts.push({ start, end, meta });
    pos = end;
  }

  if (!frame || !scanned) throw corrupt("JPEG: нет кадра или скана");
  if (pos !== n) throw corrupt("JPEG: данные после конца изображения");
  return { format: "jpeg", width, height, animated: false, parts, flagged: [], vp8xFlagsAt: null };
}

// ── PNG ────────────────────────────────────────────────────────────────────
// IHDR первым, дальше чанки до IEND. CRC не проверяем (это дело декодера, а
// проход по 10 МБ — лишнее время процессора воркера): за структуру отвечаем,
// за пиксели — нет.

const PNG_IMAGE_CHUNKS = new Set([
  "PLTE",
  "tRNS",
  "cHRM",
  "gAMA",
  "iCCP",
  "sBIT",
  "sRGB",
  "bKGD",
  "hIST",
  "pHYs",
  "sPLT",
  "cICP",
  "mDCv",
  "cLLi",
]);

function scanPng(b: Uint8Array): Scan {
  const n = b.length;
  const parts: Part[] = [{ start: 0, end: 8, meta: null }];
  let pos = 8;
  let width = 0;
  let height = 0;
  let animated = false;
  let idat = false;
  let ended = false;

  while (!ended) {
    if (pos + 12 > n) throw corrupt("PNG: файл оборван");
    const length = u32be(b, pos);
    const type = ascii(b, pos + 4, 4);
    if (length > 0x7fffffff || pos + 12 + length > n) throw corrupt("PNG: неверная длина чанка");
    if (!/^[A-Za-z]{4}$/.test(type)) throw corrupt("PNG: неверный тип чанка");
    const data = pos + 8;
    const end = data + length + 4;
    let meta: MetadataKind | null = null;

    if (parts.length === 1) {
      if (type !== "IHDR" || length !== 13) throw corrupt("PNG: первым должен быть IHDR");
      width = u32be(b, data);
      height = u32be(b, data + 4);
      if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
        throw corrupt("PNG: неверные размеры");
      }
    } else if (type === "IHDR") {
      throw corrupt("PNG: второй IHDR");
    } else if (type === "IDAT") {
      idat = true;
    } else if (type === "IEND") {
      ended = true;
    } else if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      animated = true;
    } else if (type === "eXIf") {
      meta = "exif";
    } else if (type === "iTXt") {
      meta = hasAscii(b, data, "XML:com.adobe.xmp\0") ? "xmp" : "text";
    } else if (type === "tEXt" || type === "zTXt") {
      meta = "text";
    } else if (!PNG_IMAGE_CHUNKS.has(type)) {
      // Заглавная первая буква — критичный чанк: без него картинку не прочитать
      if (type.charCodeAt(0) < 0x61) throw unsupported(`PNG: неизвестный критичный чанк ${type}`);
      meta = "other"; // tIME, подписи C2PA и прочее служебное
    }

    parts.push({ start: pos, end, meta });
    pos = end;
  }

  if (!idat) throw corrupt("PNG: нет данных изображения");
  if (pos !== n) throw corrupt("PNG: данные после IEND");
  return { format: "png", width, height, animated, parts, flagged: [], vp8xFlagsAt: null };
}

// ── WebP ───────────────────────────────────────────────────────────────────
// RIFF-контейнер: простой (один чанк VP8 или VP8L) или расширенный (VP8X с
// флагами и холстом, затем ICCP, ALPH, кадр, EXIF, XMP). Размер RIFF обязан
// совпадать с длиной файла.

const VP8X_ANIMATION = 0x02;
const VP8X_XMP = 0x04;
const VP8X_EXIF = 0x08;

interface Frame {
  width: number;
  height: number;
}

function vp8Frame(b: Uint8Array, data: number, size: number): Frame {
  if (size < 10) throw corrupt("WebP: короткий VP8");
  if ((at(b, data) & 1) !== 0) throw corrupt("WebP: VP8 не ключевой кадр");
  if (at(b, data + 3) !== 0x9d || at(b, data + 4) !== 0x01 || at(b, data + 5) !== 0x2a) {
    throw corrupt("WebP: нет стартового кода VP8");
  }
  const width = u16le(b, data + 6) & 0x3fff;
  const height = u16le(b, data + 8) & 0x3fff;
  if (width === 0 || height === 0) throw corrupt("WebP: нулевые размеры");
  return { width, height };
}

function vp8lFrame(b: Uint8Array, data: number, size: number): Frame {
  if (size < 5 || at(b, data) !== 0x2f) throw corrupt("WebP: нет сигнатуры VP8L");
  const bits = u32le(b, data + 1);
  if (bits >>> 29 !== 0) throw corrupt("WebP: неизвестная версия VP8L");
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

function scanWebp(b: Uint8Array): Scan {
  const n = b.length;
  if (n < 20) throw corrupt("WebP: файл оборван");
  if (u32le(b, 4) + 8 !== n) throw corrupt("WebP: размер RIFF не совпадает с длиной файла");

  const parts: Part[] = [{ start: 0, end: 12, meta: null }];
  const flagged: MetadataKind[] = [];
  let pos = 12;
  let extended = false;
  let canvas: Frame | null = null;
  let frame: Frame | null = null;
  let animated = false;
  let vp8xFlagsAt: number | null = null;

  while (pos < n) {
    if (pos + 8 > n) throw corrupt("WebP: файл оборван");
    const fourcc = ascii(b, pos, 4);
    const size = u32le(b, pos + 4);
    const data = pos + 8;
    const end = data + size + (size & 1); // чанки выровнены на чётную границу
    if (end > n) throw corrupt("WebP: неверная длина чанка");
    let meta: MetadataKind | null = null;
    const first = parts.length === 1;

    if (fourcc === "VP8X") {
      if (!first || size < 10) throw corrupt("WebP: VP8X не первым или короткий");
      extended = true;
      vp8xFlagsAt = data;
      const flags = at(b, data);
      if (flags & VP8X_ANIMATION) animated = true;
      if (flags & VP8X_EXIF) flagged.push("exif");
      if (flags & VP8X_XMP) flagged.push("xmp");
      canvas = { width: u24le(b, data + 4) + 1, height: u24le(b, data + 7) + 1 };
    } else if (fourcc === "VP8 " || fourcc === "VP8L") {
      if (frame) throw corrupt("WebP: второй кадр");
      if (!first && !extended) throw corrupt("WebP: кадр не первым в простом формате");
      frame = fourcc === "VP8 " ? vp8Frame(b, data, size) : vp8lFrame(b, data, size);
    } else if (first) {
      throw unsupported(`WebP: неизвестный первый чанк ${fourcc}`);
    } else if (fourcc === "ANIM" || fourcc === "ANMF") {
      animated = true;
    } else if (fourcc === "EXIF") {
      meta = "exif";
    } else if (fourcc === "XMP ") {
      meta = "xmp";
    } else if (!(extended && (fourcc === "ICCP" || fourcc === "ALPH"))) {
      meta = "other";
    }

    parts.push({ start: pos, end, meta });
    pos = end;
  }

  let size: Frame;
  if (extended && canvas) {
    // У анимации кадры внутри ANMF, их здесь не разбираем: такой файл всё равно отклоняется
    if (!animated) {
      if (!frame) throw corrupt("WebP: нет кадра");
      if (frame.width !== canvas.width || frame.height !== canvas.height) {
        throw corrupt("WebP: размер кадра не совпадает с холстом");
      }
    }
    size = canvas;
  } else {
    if (!frame) throw corrupt("WebP: нет кадра");
    size = frame;
  }
  return { format: "webp", ...size, animated, parts, flagged, vp8xFlagsAt };
}
