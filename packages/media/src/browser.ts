// Подготовка фото в браузере перед загрузкой: только здесь есть декодер, и
// только здесь сжатие бесплатно (сервер и воркер пикселей не трогают).
//
//   1. Отсекаем заведомо лишнее: не картинка, SVG, больше 25 МБ.
//   2. Декодируем с учётом EXIF-ориентации: createImageBitmap(file,
//      { imageOrientation: "from-image" }); старые движки — без параметра или <img>.
//   3. Уменьшаем, чтобы длинная сторона была ≤ 2560 (увеличивать — никогда).
//      Большое уменьшение — ступенями по половине: так браузеры с простым
//      фильтром масштабирования не дают муара и «лесенок».
//   4. Кодируем в WebP с качеством 0.9; если браузер WebP не умеет (Safari
//      возвращает PNG вместо запрошенного типа) — в JPEG 0.9.
//   5. Вырезаем метаданные, которые мог дописать сам кодировщик, и проверяем
//      результат той же функцией, что и сервер.
//
// Перекодирование всегда, даже для «подходящих» файлов: только так EXIF с
// GPS-координатами гарантированно не уходит дальше телефона.
//
// Все вызовы браузерных API — через проверку наличия: Mini App обязан работать
// и в старом WebView Android.

import {
  MAX_INPUT_BYTES,
  MAX_LONG_SIDE,
  MAX_UPLOAD_BYTES,
  UPLOAD_QUALITY,
  UPLOAD_QUALITY_FALLBACKS,
} from "./constants";
import { ImageError } from "./errors";
import { assertUploadable, type ImageInfo } from "./inspect";
import { stripMetadata } from "./strip";

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Размер, вписанный в квадрат maxLongSide × maxLongSide; меньшее не увеличивается. */
export function fitWithin(size: Size, maxLongSide: number): Size {
  const long = Math.max(size.width, size.height);
  if (long <= maxLongSide) return { width: size.width, height: size.height };
  const scale = maxLongSide / long;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** Промежуточные размеры уменьшения: половинами, пока до цели больше чем вдвое; последний — цель. */
export function downscaleSteps(from: Size, to: Size): Size[] {
  const steps: Size[] = [];
  let current = from;
  while (current.width >= to.width * 2 && current.height >= to.height * 2) {
    current = { width: Math.round(current.width / 2), height: Math.round(current.height / 2) };
    if (current.width <= to.width * 1.0001 || current.height <= to.height * 1.0001) break;
    steps.push(current);
  }
  steps.push(to);
  return steps;
}

// ── графика: браузерная реализация и швы для тестов ────────────────────────

/** Декодированное изображение с уже применённой ориентацией. */
export interface Decoded extends Size {
  readonly source: CanvasImageSource;
  close(): void;
}

/** Холст заданного размера с белым фоном. */
export interface Surface extends Size {
  readonly source: CanvasImageSource;
  /** Рисует source целиком, растягивая на весь холст */
  draw(source: CanvasImageSource): void;
  /** Blob запрошенного типа; другой тип — значит, браузер его не умеет. null — не смог */
  encode(type: string, quality: number): Promise<Blob | null>;
  release(): void;
}

export interface Graphics {
  decode(file: Blob): Promise<Decoded>;
  surface(size: Size): Surface;
}

async function decodeWithBitmap(file: Blob): Promise<Decoded | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (err) {
    // Движок старше значения "from-image" отвергает сам параметр (TypeError) —
    // тогда по умолчанию: в тех версиях это и было «ориентация из EXIF»
    if (!(err instanceof TypeError)) return null;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return null;
    }
  }
  return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
}

async function decodeWithImage(file: Blob): Promise<Decoded | null> {
  if (typeof document === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return null;
  const url = URL.createObjectURL(file);
  const img = new Image();
  const release = () => URL.revokeObjectURL(url);
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = url;
    });
  } catch {
    release();
    return null;
  }
  // naturalWidth/Height — уже с учётом EXIF-ориентации (image-orientation: from-image по умолчанию)
  return { width: img.naturalWidth, height: img.naturalHeight, source: img, close: release };
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function prepare(ctx: Context2D | null, size: Size): Context2D {
  if (!ctx) throw new ImageError("encode_failed", "нет 2d-контекста");
  // Белый фон: прозрачное в JPEG стало бы чёрным, а фото площадки прозрачности не несут
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.imageSmoothingEnabled = true;
  if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
  return ctx;
}

function offscreenSurface(size: Size): Surface {
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = prepare(canvas.getContext("2d"), size);
  return {
    ...size,
    source: canvas,
    draw: (source) => ctx.drawImage(source, 0, 0, size.width, size.height),
    encode: (type, quality) => canvas.convertToBlob({ type, quality }).catch(() => null),
    release: () => {
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

function elementSurface(size: Size): Surface {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = prepare(canvas.getContext("2d"), size);
  return {
    ...size,
    source: canvas,
    draw: (source) => ctx.drawImage(source, 0, 0, size.width, size.height),
    encode: (type, quality) =>
      new Promise((resolve) => {
        try {
          canvas.toBlob(resolve, type, quality);
        } catch {
          resolve(null);
        }
      }),
    // Safari держит память холста, пока у него есть размер
    release: () => {
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

/** Графика текущего браузера: OffscreenCanvas, где он умеет кодировать, иначе <canvas>. */
export function browserGraphics(): Graphics {
  const offscreen =
    typeof OffscreenCanvas === "function" && typeof OffscreenCanvas.prototype.convertToBlob === "function";
  return {
    async decode(file) {
      const decoded = (await decodeWithBitmap(file)) ?? (await decodeWithImage(file));
      if (!decoded || decoded.width === 0 || decoded.height === 0) {
        throw new ImageError("decode_failed", "браузер не открыл файл");
      }
      return decoded;
    },
    surface: (size) => (offscreen ? offscreenSurface(size) : elementSurface(size)),
  };
}

// ── сжатие ─────────────────────────────────────────────────────────────────

export interface CompressOptions {
  /** Длинная сторона результата, px (по умолчанию 2560) */
  readonly maxLongSide?: number;
  /** Качество 0…1 (по умолчанию 0.9) */
  readonly quality?: number;
  /** Подмена браузерной графики — для тестов */
  readonly graphics?: Graphics;
}

export interface CompressedPhoto {
  /** Файл для отправки на сервер */
  readonly blob: Blob;
  readonly bytes: Uint8Array;
  /** Формат, размеры и размер результата — как их увидит сервер */
  readonly info: ImageInfo;
  /** Размер исходного файла, байт */
  readonly sourceBytes: number;
}

function checkInput(file: Blob): void {
  if (file.size === 0) throw new ImageError("empty", "пустой файл");
  if (file.size > MAX_INPUT_BYTES) throw new ImageError("too_large", `больше ${MAX_INPUT_BYTES} байт`);
  // Пустой type бывает у файлов из некоторых галерей Android — тогда решит декодер
  const type = file.type.toLowerCase();
  if (type !== "" && (!type.startsWith("image/") || type.startsWith("image/svg"))) {
    throw new ImageError("unsupported_format", `не фото: ${type}`);
  }
}

async function render(graphics: Graphics, decoded: Decoded, target: Size): Promise<Surface> {
  let source: CanvasImageSource = decoded.source;
  let previous: Surface | null = null;
  try {
    for (const step of downscaleSteps(decoded, target)) {
      const surface = graphics.surface(step);
      surface.draw(source);
      previous?.release();
      previous = surface;
      source = surface.source;
    }
  } catch (err) {
    previous?.release();
    throw err;
  }
  if (!previous) throw new ImageError("encode_failed", "нечего кодировать");
  return previous;
}

async function encodeBytes(surface: Surface, type: string, quality: number): Promise<Uint8Array | null> {
  const blob = await surface.encode(type, quality);
  if (!blob || blob.type !== type) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Готовит фото к загрузке: ориентация из EXIF, длинная сторона ≤ 2560,
 * WebP 0.9 (или JPEG 0.9, где WebP не кодируется), без метаданных.
 * Ошибки — ImageError с кодом для текста в интерфейсе.
 */
export async function compressForUpload(file: Blob, options: CompressOptions = {}): Promise<CompressedPhoto> {
  checkInput(file);
  const graphics = options.graphics ?? browserGraphics();
  const quality = options.quality ?? UPLOAD_QUALITY;
  const ladder = [quality, ...UPLOAD_QUALITY_FALLBACKS.filter((q) => q < quality)];

  const decoded = await graphics.decode(file);
  let surface: Surface;
  try {
    surface = await render(graphics, decoded, fitWithin(decoded, options.maxLongSide ?? MAX_LONG_SIDE));
  } finally {
    decoded.close();
  }

  try {
    let webp = true;
    for (const q of ladder) {
      let encoded = webp ? await encodeBytes(surface, "image/webp", q) : null;
      if (!encoded) {
        webp = false;
        encoded = await encodeBytes(surface, "image/jpeg", q);
      }
      if (!encoded) throw new ImageError("encode_failed", "браузер не закодировал ни WebP, ни JPEG");

      const bytes = stripMetadata(encoded);
      if (bytes.length > MAX_UPLOAD_BYTES) continue; // слишком «тяжёлое» фото — чуть ниже качество
      const info = assertUploadable(bytes);
      if (info.width !== surface.width || info.height !== surface.height) {
        throw new ImageError("encode_failed", "размер результата не совпал с холстом");
      }
      return {
        blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: info.mime }),
        bytes,
        info,
        sourceBytes: file.size,
      };
    }
    throw new ImageError("too_large", "не уложились в 10 МБ даже с пониженным качеством");
  } finally {
    surface.release();
  }
}
