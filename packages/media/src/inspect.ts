// Проверка файла перед сохранением. На сервере — обязательно: клиенту не верим,
// тип и размеры берём из байтов, а не из заголовков запроса и имени файла.
// В браузере — та же проверка результата сжатия, чтобы не слать заведомо
// отклоняемое.

import {
  FORMAT_EXTENSION,
  FORMAT_MIME,
  type ImageFormat,
  MAX_LONG_SIDE,
  MAX_UPLOAD_BYTES,
  MIN_SHORT_SIDE,
  type UploadMime,
} from "./constants";
import { ImageError } from "./errors";
import { type MetadataKind, scanImage } from "./scan";

export interface ImageInfo {
  readonly format: ImageFormat;
  readonly mime: UploadMime;
  /** Расширение для ключа объекта: webp, jpg, png */
  readonly extension: "webp" | "jpg" | "png";
  readonly width: number;
  readonly height: number;
  /** Размер файла в байтах */
  readonly bytes: number;
  readonly animated: boolean;
  /** Какие метаданные есть в файле; пусто — нет */
  readonly metadata: readonly MetadataKind[];
}

/**
 * Формат, размеры и метаданные по байтам, без декодирования пикселей.
 * Не WebP/JPEG/PNG — ImageError unsupported_format; битая структура — corrupt.
 */
export function inspectImage(bytes: Uint8Array): ImageInfo {
  if (bytes.length === 0) throw new ImageError("empty", "пустой файл");
  const scan = scanImage(bytes);
  const metadata = new Set<MetadataKind>(scan.flagged);
  for (const part of scan.parts) if (part.meta !== null) metadata.add(part.meta);
  return {
    format: scan.format,
    mime: FORMAT_MIME[scan.format],
    extension: FORMAT_EXTENSION[scan.format],
    width: scan.width,
    height: scan.height,
    bytes: bytes.length,
    animated: scan.animated,
    metadata: [...metadata],
  };
}

export interface UploadLimits {
  readonly maxBytes: number;
  readonly maxLongSide: number;
  readonly minShortSide: number;
}

export const UPLOAD_LIMITS: UploadLimits = {
  maxBytes: MAX_UPLOAD_BYTES,
  maxLongSide: MAX_LONG_SIDE,
  minShortSide: MIN_SHORT_SIDE,
};

/**
 * Файл можно сохранять: WebP/JPEG/PNG, не больше 10 МБ, без анимации, без
 * метаданных (их вырезает браузер — если остались, файл пришёл в обход него),
 * длинная сторона ≤ 2560, короткая ≥ 320. Иначе — ImageError.
 */
export function assertUploadable(bytes: Uint8Array, limits: UploadLimits = UPLOAD_LIMITS): ImageInfo {
  if (bytes.length === 0) throw new ImageError("empty", "пустой файл");
  // Размер — до разбора: большой файл не читаем вовсе
  if (bytes.length > limits.maxBytes) throw new ImageError("too_large", `больше ${limits.maxBytes} байт`);

  const info = inspectImage(bytes);
  if (info.animated) throw new ImageError("animated", "анимация не принимается");
  if (info.metadata.length > 0) {
    throw new ImageError("metadata_present", "в файле остались метаданные", info.metadata);
  }
  const long = Math.max(info.width, info.height);
  const short = Math.min(info.width, info.height);
  if (long > limits.maxLongSide) {
    throw new ImageError("dimensions_too_large", `длинная сторона ${long} > ${limits.maxLongSide}`);
  }
  if (short < limits.minShortSide) {
    throw new ImageError("dimensions_too_small", `короткая сторона ${short} < ${limits.minShortSide}`);
  }
  return info;
}
