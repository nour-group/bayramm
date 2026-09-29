// Константы конвейера фото. Одни и те же числа — в браузере, в API, в воркере
// media и в миграции бакета (supabase/migrations/…_listing_photos_storage.sql):
// тест API сверяет бакет с этими значениями.

/** Бакет Supabase Storage с фото листингов (публичное чтение, запись — только API). */
export const LISTING_PHOTOS_BUCKET = "listing-photos";

/** Предел файла, который принимает сервер и бакет: 10 МБ. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Предел исходного файла в браузере до сжатия: 25 МБ — больше не декодируем. */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;

/** Длинная сторона сохраняемого оригинала, px. Больше не нужно ни одному экрану. */
export const MAX_LONG_SIDE = 2560;

/** Короткая сторона не меньше, px: иначе это миниатюра, а не фото площадки. */
export const MIN_SHORT_SIDE = 320;

/** Качество перекодирования в браузере: на глаз неотличимо от исходника. */
export const UPLOAD_QUALITY = 0.9;

/**
 * Если файл всё же вышел больше MAX_UPLOAD_BYTES (шумная ночная съёмка), качество
 * снижается по этой лестнице. Ниже 0.8 не опускаемся — появятся видимые артефакты.
 */
export const UPLOAD_QUALITY_FALLBACKS = [0.85, 0.8] as const;

/** Форматы, которые хранятся в бакете. */
export const UPLOAD_MIME_TYPES = ["image/webp", "image/jpeg", "image/png"] as const;
export type UploadMime = (typeof UPLOAD_MIME_TYPES)[number];

export type ImageFormat = "webp" | "jpeg" | "png";

export const FORMAT_MIME: Readonly<Record<ImageFormat, UploadMime>> = {
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png",
};

/** Расширение ключа объекта по формату. */
export const FORMAT_EXTENSION: Readonly<Record<ImageFormat, "webp" | "jpg" | "png">> = {
  webp: "webp",
  jpeg: "jpg",
  png: "png",
};

/**
 * Ширины вариантов, которые отдаёт воркер media. Только они: каждая новая ширина —
 * новое уникальное преобразование в Cloudflare, бесплатных — 5000 в месяц.
 */
export const MEDIA_WIDTHS = [320, 640, 960, 1280, 1920] as const;
export type MediaWidth = (typeof MEDIA_WIDTHS)[number];

/** Качество вариантов (Cloudflare Image Transformations), 1–100. */
export const MEDIA_QUALITY = 85;

/** Где работает воркер media в каждом окружении. */
export const MEDIA_ORIGINS = {
  local: "http://localhost:8790",
  staging: "https://media-staging.bayramm.uz",
  production: "https://media.bayramm.uz",
} as const;
export type MediaEnv = keyof typeof MEDIA_ORIGINS;

/**
 * Источники фото для img-src сайтов: воркеры media обоих боевых окружений — один список
 * на все сборки, оба origin наши. Локальный — только в dev
 */
export function mediaImageOrigins(dev = false): string[] {
  const deployed = [MEDIA_ORIGINS.staging, MEDIA_ORIGINS.production];
  return dev ? [...deployed, MEDIA_ORIGINS.local] : deployed;
}
