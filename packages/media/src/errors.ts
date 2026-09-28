// Почему фото не принято. Код стабильный: по нему интерфейс выбирает текст на
// RU/UZ, API — HTTP-статус. Сообщение — для разработчика, не для показа.

export type ImageErrorCode =
  /** Пустой файл */
  | "empty"
  /** Больше предела: 25 МБ до сжатия в браузере, 10 МБ на сервере */
  | "too_large"
  /** Не WebP, JPEG или PNG (по сигнатуре, а не по имени и типу файла) либо их редкая разновидность */
  | "unsupported_format"
  /** Структура файла повреждена, обрезана или после конца изображения есть лишние байты */
  | "corrupt"
  /** Анимация (анимированный WebP, APNG) */
  | "animated"
  /** Остались метаданные: EXIF (в т.ч. GPS), XMP, IPTC, комментарии, миниатюры */
  | "metadata_present"
  | "dimensions_too_large"
  | "dimensions_too_small"
  /** Браузер не смог открыть файл (например, HEIC в Chrome) */
  | "decode_failed"
  /** Браузер не смог закодировать результат */
  | "encode_failed";

export class ImageError extends Error {
  readonly code: ImageErrorCode;
  /** Уточнения: для metadata_present — какие именно метаданные найдены */
  readonly details: readonly string[];

  constructor(code: ImageErrorCode, message: string = code, details: readonly string[] = []) {
    super(message);
    this.name = "ImageError";
    this.code = code;
    this.details = details;
  }
}

export function isImageError(err: unknown): err is ImageError {
  return err instanceof ImageError;
}
