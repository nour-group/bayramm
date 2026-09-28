// Ключи объектов в бакете и адреса вариантов у воркера media.
//
//   ключ:    listings/<listing_id>/<photo_uuid>.<webp|jpg|png>
//   вариант: https://media.bayramm.uz/<ширина>/<ключ>
//
// Формат ключа проверяет и база (ограничение photos_storage_key_format), и
// воркер: он не пойдёт в хранилище за путём, который не похож на фото листинга.

import { trimTrailingSlashes } from "@bayramm/shared";
import {
  FORMAT_EXTENSION,
  type ImageFormat,
  MEDIA_ORIGINS,
  MEDIA_WIDTHS,
  type MediaEnv,
  type MediaWidth,
} from "./constants";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`);
const KEY_RE = new RegExp(`^listings/${UUID}/${UUID}\\.(?:webp|jpg|png)$`);
// Ширина без ведущих нулей: у каждого варианта ровно один адрес (кэш и квота
// преобразований считаются по адресу)
const MEDIA_PATH_RE = new RegExp(`^/([1-9]\\d{2,3})/(listings/${UUID}/${UUID}\\.(?:webp|jpg|png))$`);

/** Ключ объекта нового фото. id — UUID в нижнем регистре (как отдаёт Postgres). */
export function listingPhotoKey(listingId: string, photoId: string, format: ImageFormat): string {
  const listing = listingId.toLowerCase();
  const photo = photoId.toLowerCase();
  if (!UUID_RE.test(listing) || !UUID_RE.test(photo)) throw new TypeError("listingPhotoKey: нужны UUID");
  return `listings/${listing}/${photo}.${FORMAT_EXTENSION[format]}`;
}

export function isListingPhotoKey(key: string): boolean {
  return KEY_RE.test(key);
}

export function isMediaWidth(value: number): value is MediaWidth {
  return (MEDIA_WIDTHS as readonly number[]).includes(value);
}

/** Путь запроса к воркеру media → ширина и ключ; null — такого варианта не бывает. */
export function parseMediaPath(pathname: string): { width: MediaWidth; key: string } | null {
  const match = MEDIA_PATH_RE.exec(pathname);
  if (!match) return null;
  const width = Number(match[1]);
  const key = match[2];
  if (!isMediaWidth(width) || key === undefined) return null;
  return { width, key };
}

/** Окружение (local/staging/production) или свой адрес воркера, например из настроек сборки. */
export type MediaTarget = MediaEnv | { readonly origin: string };

function originOf(target: MediaTarget): string {
  const origin = typeof target === "string" ? MEDIA_ORIGINS[target] : target.origin;
  return trimTrailingSlashes(origin);
}

/** Адрес варианта фото заданной ширины. */
export function mediaUrl(key: string, width: MediaWidth, target: MediaTarget): string {
  if (!isListingPhotoKey(key)) throw new TypeError("mediaUrl: это не ключ фото листинга");
  if (!isMediaWidth(width)) throw new TypeError(`mediaUrl: ширины ${width} нет среди вариантов`);
  return `${originOf(target)}/${width}/${key}`;
}

/** srcset для <img>: браузер сам выберет ширину под экран и плотность пикселей. */
export function mediaSrcSet(
  key: string,
  target: MediaTarget,
  widths: readonly MediaWidth[] = MEDIA_WIDTHS,
): string {
  return widths.map((width) => `${mediaUrl(key, width, target)} ${width}w`).join(", ");
}

/**
 * Наименьшая ширина варианта, которой хватит на cssWidth точек при плотности dpr.
 * Больше самой широкой — самая широкая.
 */
export function pickMediaWidth(cssWidth: number, dpr = 1): MediaWidth {
  const needed = Math.ceil(cssWidth * Math.max(1, dpr));
  for (const width of MEDIA_WIDTHS) if (width >= needed) return width;
  return MEDIA_WIDTHS[MEDIA_WIDTHS.length - 1] as MediaWidth;
}
