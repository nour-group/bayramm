import type { Photo as PhotoData } from "@bayramm/shared/api";
import { useState } from "react";
import { useServices } from "../context";
import { photoSources } from "../media";

interface PhotoProps {
  readonly photo: PhotoData | null;
  /** Пусто — декоративное фото рядом с названием (подпись уже есть в тексте) */
  readonly alt: string;
  /** Ширина в раскладке для выбора варианта из srcset */
  readonly sizes: string;
  /** Первый экран: грузить сразу и с высоким приоритетом */
  readonly eager?: boolean;
  readonly className?: string;
}

/**
 * Фото площадки: варианты с воркера media (srcset), ленивая загрузка. Нет фото или оно
 * не загрузилось — подложка с узором гириха, а не значок битой картинки
 */
export function Photo({ photo, alt, sizes, eager = false, className = "" }: PhotoProps) {
  const { mediaEnv } = useServices();
  const [failed, setFailed] = useState(false);
  const sources = photo && !failed ? photoSources(photo, mediaEnv) : null;

  if (!photo || !sources)
    return alt ? (
      <span className={`photo photo-empty ${className}`} role="img" aria-label={alt} />
    ) : (
      <span className={`photo photo-empty ${className}`} aria-hidden="true" />
    );

  return (
    <img
      className={`photo ${className}`}
      src={sources.src}
      srcSet={sources.srcSet}
      sizes={sizes}
      alt={alt}
      width={photo.width}
      height={photo.height}
      loading={eager ? "eager" : "lazy"}
      fetchPriority={eager ? "high" : "auto"}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
