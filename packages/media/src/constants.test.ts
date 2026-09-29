import { describe, expect, it } from "vitest";
import { MEDIA_ORIGINS, mediaImageOrigins } from "./constants";

describe("mediaImageOrigins", () => {
  it("в сборке — воркеры media обоих окружений, только https", () => {
    const origins = mediaImageOrigins();
    expect(origins).toEqual([MEDIA_ORIGINS.staging, MEDIA_ORIGINS.production]);
    for (const origin of origins) expect(new URL(origin).origin).toBe(origin);
    expect(origins.every((origin) => origin.startsWith("https://"))).toBe(true);
  });

  it("локальный воркер — только в dev", () => {
    expect(mediaImageOrigins(true)).toContain(MEDIA_ORIGINS.local);
    expect(mediaImageOrigins(false)).not.toContain(MEDIA_ORIGINS.local);
  });
});
