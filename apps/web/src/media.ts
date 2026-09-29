import { isListingPhotoKey, type MediaEnv, type MediaWidth, mediaSrcSet, mediaUrl } from "@bayramm/media";
import type { Photo } from "@bayramm/shared/api";

/** Окружение воркера media по адресу сайта: боевой домен, staging, остальное — локально */
export function mediaEnvFor(hostname: string): MediaEnv {
  if (hostname === "bayramm.uz") return "production";
  if (hostname === "staging.bayramm.uz") return "staging";
  return "local";
}

export interface PhotoSources {
  readonly src: string;
  readonly srcSet: string;
}

/**
 * Адреса вариантов фото: src — запасной для браузеров без srcset, srcSet — все ширины.
 * Ключ не похож на фото листинга — null (покажем подложку, а не битую картинку)
 */
export function photoSources(
  photo: Photo,
  env: MediaEnv,
  fallbackWidth: MediaWidth = 640,
): PhotoSources | null {
  if (!isListingPhotoKey(photo.key)) return null;
  return { src: mediaUrl(photo.key, fallbackWidth, env), srcSet: mediaSrcSet(photo.key, env) };
}
