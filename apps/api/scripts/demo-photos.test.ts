// Фото демо-залов, которые рисует workflow: проходят ту же проверку, что любая загрузка,
// лёгкие и все разные (у одной карточки два одинаковых фото база не примет)
import { createHash } from "node:crypto";
import { assertUploadable } from "@bayramm/media";
import { describe, expect, it } from "vitest";
import { DEMO_PHOTO_COUNT } from "../src/demo/venues";
import {
  DEMO_PHOTO_FILES,
  DEMO_PHOTO_HEIGHT,
  DEMO_PHOTO_WIDTH,
  demoPhoto,
  demoPhotoSvg,
} from "./demo-photos";

const MAX_BYTES = 60 * 1024;

describe("демо-фото", () => {
  it("столько, сколько ждёт POST /ops/demo: по три на витрину", () => {
    expect(DEMO_PHOTO_FILES).toBe(DEMO_PHOTO_COUNT);
  });

  it("WebP без метаданных нужного размера, не больше 60 КБ, все разные", async () => {
    const photos = await Promise.all(Array.from({ length: DEMO_PHOTO_FILES }, (_, i) => demoPhoto(i)));
    for (const bytes of photos) {
      const info = assertUploadable(new Uint8Array(bytes));
      expect(info).toMatchObject({
        format: "webp",
        width: DEMO_PHOTO_WIDTH,
        height: DEMO_PHOTO_HEIGHT,
        metadata: [],
      });
      expect(bytes.length).toBeLessThanOrEqual(MAX_BYTES);
    }
    const digests = photos.map((bytes) => createHash("sha256").update(bytes).digest("hex"));
    expect(new Set(digests).size).toBe(photos.length);
  });

  it("рисунок — только линии и заливки: без текста, шрифтов и внешних ссылок", () => {
    for (let i = 0; i < DEMO_PHOTO_FILES; i++) {
      const svg = demoPhotoSvg(i);
      expect(svg).not.toMatch(/<text|<image|href=|font-family/);
    }
  });
});
