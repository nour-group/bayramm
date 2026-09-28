// Вырезание метаданных без перекодирования: те же части, что inspectImage
// считает метаданными (scan.ts), выбрасываются, остальное склеивается как было.
//
// Браузер и так перекодирует фото через canvas, и это теряет EXIF исходника.
// Но кодировщик браузера вправе дописать свой служебный блок (размеры, цветовое
// пространство) — гарантий спецификация не даёт. Поэтому результат canvas всё
// равно проходит через stripMetadata: сервер отклонит любой файл, где
// метаданные остались.

import { scanImage } from "./scan";

const VP8X_EXIF_XMP = 0x08 | 0x04;

/**
 * Копия файла без EXIF/XMP/IPTC, комментариев, текстовых чанков и миниатюр.
 * Пиксели, ICC-профиль и цветовые маркеры не трогаются. Если убирать нечего,
 * возвращает тот же массив. Не WebP/JPEG/PNG или битый файл — ImageError.
 */
export function stripMetadata(bytes: Uint8Array): Uint8Array {
  const scan = scanImage(bytes);
  const kept = scan.parts.filter((part) => part.meta === null);
  const flagsAt = scan.vp8xFlagsAt;
  const flagsDirty = flagsAt !== null && ((bytes[flagsAt] ?? 0) & VP8X_EXIF_XMP) !== 0;
  if (kept.length === scan.parts.length && !flagsDirty) return bytes;

  const length = kept.reduce((sum, part) => sum + (part.end - part.start), 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of kept) {
    out.set(bytes.subarray(part.start, part.end), offset);
    offset += part.end - part.start;
  }

  if (scan.format === "webp") {
    // Размер RIFF — длина файла без 8 байт заголовка
    new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(4, length - 8, true);
    // VP8X всегда первый чанк: до него ничего не вырезается, позиция флагов та же
    if (flagsAt !== null) out[flagsAt] = (out[flagsAt] ?? 0) & ~VP8X_EXIF_XMP;
  }
  return out;
}
