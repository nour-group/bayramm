// Общая часть: работает в браузере, в воркерах и в Node — без DOM.
// Подготовка фото в браузере (canvas) — отдельно: @bayramm/media/browser.

export {
  FORMAT_EXTENSION,
  FORMAT_MIME,
  type ImageFormat,
  LISTING_PHOTOS_BUCKET,
  MAX_INPUT_BYTES,
  MAX_LONG_SIDE,
  MAX_UPLOAD_BYTES,
  MEDIA_ORIGINS,
  MEDIA_QUALITY,
  MEDIA_WIDTHS,
  type MediaEnv,
  type MediaWidth,
  MIN_SHORT_SIDE,
  UPLOAD_MIME_TYPES,
  UPLOAD_QUALITY,
  type UploadMime,
} from "./constants";
export { ImageError, type ImageErrorCode, isImageError } from "./errors";
export { assertUploadable, type ImageInfo, inspectImage, UPLOAD_LIMITS, type UploadLimits } from "./inspect";
export {
  isListingPhotoKey,
  isMediaWidth,
  listingPhotoKey,
  type MediaTarget,
  mediaSrcSet,
  mediaUrl,
  parseMediaPath,
  pickMediaWidth,
} from "./keys";
export { type MetadataKind, sniffFormat } from "./scan";
export { stripMetadata } from "./strip";
