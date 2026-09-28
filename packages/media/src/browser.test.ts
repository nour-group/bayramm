// compressForUpload без браузера: декодер и холст подменены (Graphics), кодировщик
// отдаёт настоящие WebP/JPEG из фикстур — с метаданными, как «неаккуратный» браузер
import { describe, expect, it } from "vitest";
import {
  type CompressOptions,
  compressForUpload,
  downscaleSteps,
  fitWithin,
  type Graphics,
  type Size,
} from "./browser";
import { MAX_INPUT_BYTES, MAX_UPLOAD_BYTES } from "./constants";
import { ImageError, type ImageErrorCode } from "./errors";
import { inspectImage } from "./inspect";
import { exifSegment, jpegFixture, pngFixture, VP8X_FLAGS, webpChunk, webpFixture } from "./testing";

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

interface FakeOptions {
  /** Размер исходника после декодирования */
  readonly source: Size;
  /** Кодирует ли «браузер» WebP (Safari — нет: вместо него PNG) */
  readonly webp?: boolean;
  /** Размер результата по качеству (для лестницы качества): добавочные байты ICC */
  readonly padding?: (quality: number) => number;
  readonly decodeFails?: boolean;
}

function fakeGraphics({ source, webp = true, padding = () => 0, decodeFails = false }: FakeOptions) {
  const log = {
    surfaces: [] as Size[],
    encodes: [] as { type: string; quality: number }[],
    released: 0,
    closed: 0,
  };
  const graphics: Graphics = {
    async decode() {
      if (decodeFails) throw new ImageError("decode_failed");
      return { ...source, source: {} as CanvasImageSource, close: () => void log.closed++ };
    },
    surface(size) {
      log.surfaces.push(size);
      return {
        ...size,
        source: {} as CanvasImageSource,
        draw: () => {},
        async encode(type, quality) {
          log.encodes.push({ type, quality });
          if (type === "image/webp") {
            if (!webp) return new Blob([pngFixture({ width: 8, height: 8 })], { type: "image/png" });
            // Кодировщик дописал EXIF — очистка обязана его убрать
            const extra = [
              webpChunk("EXIF", ascii("MM\0*")),
              webpChunk("ICCP", new Uint8Array(padding(quality))),
            ];
            const bytes = webpFixture({ ...size, vp8x: VP8X_FLAGS.exif | VP8X_FLAGS.icc, extra });
            return new Blob([bytes], { type });
          }
          const jpeg = jpegFixture({ ...size, segments: [exifSegment()] });
          return new Blob([jpeg], { type });
        },
        release: () => void log.released++,
      };
    },
  };
  return { graphics, log };
}

const photo = (type = "image/jpeg") => new Blob([new Uint8Array(1024)], { type });

async function failure(file: Blob, options: CompressOptions): Promise<ImageErrorCode> {
  try {
    await compressForUpload(file, options);
  } catch (err) {
    if (err instanceof ImageError) return err.code;
    throw err;
  }
  throw new Error("ожидалась ImageError");
}

describe("fitWithin и downscaleSteps", () => {
  it("вписывает в 2560 по длинной стороне и не увеличивает", () => {
    expect(fitWithin({ width: 4032, height: 3024 }, 2560)).toEqual({ width: 2560, height: 1920 });
    expect(fitWithin({ width: 3024, height: 4032 }, 2560)).toEqual({ width: 1920, height: 2560 });
    expect(fitWithin({ width: 1600, height: 1200 }, 2560)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin({ width: 9000, height: 3 }, 2560)).toEqual({ width: 2560, height: 1 });
  });

  it("уменьшает половинами, пока до цели больше чем вдвое", () => {
    const target = { width: 2560, height: 1920 };
    expect(downscaleSteps({ width: 4032, height: 3024 }, target)).toEqual([target]);
    expect(downscaleSteps({ width: 8000, height: 6000 }, target)).toEqual([
      { width: 4000, height: 3000 },
      target,
    ]);
    expect(downscaleSteps({ width: 5120, height: 3840 }, target)).toEqual([target]);
    expect(downscaleSteps({ width: 20000, height: 15000 }, target)).toEqual([
      { width: 10000, height: 7500 },
      { width: 5000, height: 3750 },
      target,
    ]);
    expect(downscaleSteps({ width: 1000, height: 750 }, { width: 1000, height: 750 })).toEqual([
      { width: 1000, height: 750 },
    ]);
  });
});

describe("compressForUpload", () => {
  it("фото с телефона: 2560 по длинной стороне, WebP 0.9, без EXIF", async () => {
    const { graphics, log } = fakeGraphics({ source: { width: 4032, height: 3024 } });
    const result = await compressForUpload(photo(), { graphics });

    expect(log.surfaces).toEqual([{ width: 2560, height: 1920 }]);
    expect(log.encodes).toEqual([{ type: "image/webp", quality: 0.9 }]);
    expect(result.info).toMatchObject({ format: "webp", width: 2560, height: 1920, metadata: [] });
    expect(result.blob.type).toBe("image/webp");
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(result.bytes);
    expect(inspectImage(result.bytes).metadata).toEqual([]);
    expect(result.sourceBytes).toBe(1024);
    expect(log.closed).toBe(1);
    expect(log.released).toBe(log.surfaces.length);
  });

  it("огромный кадр — ступенями, промежуточные холсты освобождаются", async () => {
    const { graphics, log } = fakeGraphics({ source: { width: 8000, height: 6000 } });
    const result = await compressForUpload(photo(), { graphics });
    expect(log.surfaces).toEqual([
      { width: 4000, height: 3000 },
      { width: 2560, height: 1920 },
    ]);
    expect(result.info).toMatchObject({ width: 2560, height: 1920 });
    expect(log.released).toBe(2);
  });

  it("маленькое фото не увеличивается, но всё равно перекодируется", async () => {
    const { graphics, log } = fakeGraphics({ source: { width: 1000, height: 750 } });
    const result = await compressForUpload(photo("image/webp"), { graphics });
    expect(log.surfaces).toEqual([{ width: 1000, height: 750 }]);
    expect(log.encodes).toHaveLength(1);
    expect(result.info).toMatchObject({ width: 1000, height: 750, metadata: [] });
  });

  it("браузер без WebP-кодировщика (Safari отдаёт PNG) — JPEG 0.9 без EXIF", async () => {
    const { graphics, log } = fakeGraphics({ source: { width: 3024, height: 4032 }, webp: false });
    const result = await compressForUpload(photo("image/heic"), { graphics });
    expect(log.encodes).toEqual([
      { type: "image/webp", quality: 0.9 },
      { type: "image/jpeg", quality: 0.9 },
    ]);
    expect(result.info).toMatchObject({ format: "jpeg", mime: "image/jpeg", width: 1920, height: 2560 });
    expect(result.info.metadata).toEqual([]);
    expect(result.blob.type).toBe("image/jpeg");
  });

  it("не уложились в 10 МБ — качество ниже, но не меньше 0.8", async () => {
    const heavy = (q: number) => (q > 0.8 ? MAX_UPLOAD_BYTES : 0);
    const { graphics, log } = fakeGraphics({ source: { width: 4000, height: 3000 }, padding: heavy });
    const result = await compressForUpload(photo(), { graphics });
    expect(log.encodes.map((e) => e.quality)).toEqual([0.9, 0.85, 0.8]);
    expect(result.bytes.length).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);

    const always = fakeGraphics({ source: { width: 4000, height: 3000 }, padding: () => MAX_UPLOAD_BYTES });
    expect(await failure(photo(), { graphics: always.graphics })).toBe("too_large");
    expect(always.log.released).toBe(1);
  });

  it("отсекает до декодирования: пустой, больше 25 МБ, не картинка, SVG", async () => {
    const { graphics, log } = fakeGraphics({ source: { width: 4000, height: 3000 } });
    expect(await failure(new Blob([], { type: "image/jpeg" }), { graphics })).toBe("empty");
    const huge = { size: MAX_INPUT_BYTES + 1, type: "image/jpeg" } as Blob;
    expect(await failure(huge, { graphics })).toBe("too_large");
    expect(await failure(photo("application/pdf"), { graphics })).toBe("unsupported_format");
    expect(await failure(photo("image/svg+xml"), { graphics })).toBe("unsupported_format");
    expect(log.surfaces).toEqual([]);
  });

  it("пустой type (некоторые галереи Android) — решает декодер", async () => {
    const { graphics } = fakeGraphics({ source: { width: 1600, height: 1200 } });
    expect((await compressForUpload(photo(""), { graphics })).info.width).toBe(1600);
  });

  it("не открылось — decode_failed; слишком маленькое — dimensions_too_small", async () => {
    const broken = fakeGraphics({ source: { width: 1, height: 1 }, decodeFails: true });
    expect(await failure(photo(), { graphics: broken.graphics })).toBe("decode_failed");
    const tiny = fakeGraphics({ source: { width: 300, height: 200 } });
    expect(await failure(photo(), { graphics: tiny.graphics })).toBe("dimensions_too_small");
  });

  it("свой предел длинной стороны", async () => {
    const { graphics } = fakeGraphics({ source: { width: 4000, height: 3000 } });
    const result = await compressForUpload(photo(), { graphics, maxLongSide: 1600 });
    expect(result.info).toMatchObject({ width: 1600, height: 1200 });
  });
});
