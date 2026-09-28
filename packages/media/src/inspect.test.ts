import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES } from "./constants";
import { ImageError, type ImageErrorCode } from "./errors";
import { assertUploadable, inspectImage } from "./inspect";
import {
  commentSegment,
  concat,
  exifSegment,
  iccSegment,
  iptcSegment,
  type JpegSegment,
  jpegFixture,
  pngChunk,
  pngExif,
  pngFixture,
  pngText,
  pngXmp,
  riff,
  VP8X_FLAGS,
  vp8lSolid,
  webpChunk,
  webpFixture,
  xmpSegment,
} from "./testing";

function code(run: () => unknown): ImageErrorCode {
  try {
    run();
  } catch (err) {
    if (err instanceof ImageError) return err.code;
    throw err;
  }
  throw new Error("ожидалась ImageError");
}

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

describe("inspectImage: формат и размеры из байтов", () => {
  it("WebP без потерь (VP8L)", () => {
    expect(inspectImage(webpFixture({ width: 640, height: 480 }))).toMatchObject({
      format: "webp",
      mime: "image/webp",
      extension: "webp",
      width: 640,
      height: 480,
      animated: false,
      metadata: [],
    });
  });

  it("WebP с потерями (VP8) и расширенный (VP8X)", () => {
    expect(inspectImage(webpFixture({ width: 1920, height: 1080, lossy: true }))).toMatchObject({
      width: 1920,
      height: 1080,
    });
    expect(inspectImage(webpFixture({ width: 2560, height: 1440, vp8x: VP8X_FLAGS.alpha }))).toMatchObject({
      width: 2560,
      height: 1440,
      metadata: [],
    });
  });

  it("JPEG: размеры из SOF, байты — длина файла", () => {
    const bytes = jpegFixture({ width: 1000, height: 750 });
    expect(inspectImage(bytes)).toMatchObject({
      format: "jpeg",
      mime: "image/jpeg",
      extension: "jpg",
      width: 1000,
      height: 750,
      bytes: bytes.length,
    });
  });

  it("PNG: размеры из IHDR", () => {
    expect(inspectImage(pngFixture({ width: 400, height: 330 }))).toMatchObject({
      format: "png",
      extension: "png",
      width: 400,
      height: 330,
    });
  });

  it("тип определяется по сигнатуре, а не по чему-то ещё", () => {
    expect(code(() => inspectImage(ascii("<svg xmlns='http://www.w3.org/2000/svg'/>")))).toBe(
      "unsupported_format",
    );
    expect(code(() => inspectImage(ascii("GIF89a\x01\x00\x01\x00")))).toBe("unsupported_format");
    expect(code(() => inspectImage(ascii("<!doctype html><script>alert(1)</script>")))).toBe(
      "unsupported_format",
    );
    expect(code(() => inspectImage(concat(ascii("RIFF"), new Uint8Array(4), ascii("AVI "))))).toBe(
      "unsupported_format",
    );
    expect(code(() => inspectImage(new Uint8Array(0)))).toBe("empty");
  });
});

describe("inspectImage: метаданные", () => {
  it("JPEG: EXIF, XMP, IPTC, комментарий и миниатюра JFIF", () => {
    const meta = (segments: JpegSegment[]) =>
      inspectImage(jpegFixture({ width: 640, height: 480, segments })).metadata;
    expect(meta([exifSegment()])).toEqual(["exif"]);
    expect(meta([xmpSegment()])).toEqual(["xmp"]);
    expect(meta([iptcSegment()])).toEqual(["iptc"]);
    expect(meta([commentSegment()])).toEqual(["comment"]);
    expect(meta([exifSegment(), xmpSegment(), commentSegment()])).toEqual(["exif", "xmp", "comment"]);
    expect(inspectImage(jpegFixture({ width: 640, height: 480, jfifThumbnail: true })).metadata).toEqual([
      "thumbnail",
    ]);
  });

  it("JPEG: ICC-профиль и Adobe — не метаданные; MPF и прочие APPn — метаданные", () => {
    expect(inspectImage(jpegFixture({ width: 640, height: 480, segments: [iccSegment()] })).metadata).toEqual(
      [],
    );
    const adobe = { marker: 0xee, data: concat(ascii("Adobe"), new Uint8Array(7)) };
    expect(inspectImage(jpegFixture({ width: 640, height: 480, segments: [adobe] })).metadata).toEqual([]);
    const mpf = { marker: 0xe2, data: concat(ascii("MPF\0"), new Uint8Array(8)) };
    expect(inspectImage(jpegFixture({ width: 640, height: 480, segments: [mpf] })).metadata).toEqual([
      "other",
    ]);
    const app5 = { marker: 0xe5, data: new Uint8Array(4) };
    expect(inspectImage(jpegFixture({ width: 640, height: 480, segments: [app5] })).metadata).toEqual([
      "other",
    ]);
  });

  it("WebP: чанки EXIF и XMP, флаги VP8X без чанков, неизвестные чанки", () => {
    const exif = webpChunk("EXIF", ascii("MM\0*"));
    const xmp = webpChunk("XMP ", ascii("<x:xmpmeta/>"));
    expect(
      inspectImage(
        webpFixture({ width: 640, height: 480, vp8x: VP8X_FLAGS.exif | VP8X_FLAGS.xmp, extra: [exif, xmp] }),
      ).metadata,
    ).toEqual(["exif", "xmp"]);
    // Флаг без чанка — тоже считается: файл собран кем-то, кроме браузера
    expect(inspectImage(webpFixture({ width: 640, height: 480, vp8x: VP8X_FLAGS.exif })).metadata).toEqual([
      "exif",
    ]);
    // EXIF в простом формате (без VP8X) — не по спецификации, но встречается
    expect(inspectImage(webpFixture({ width: 640, height: 480, extra: [exif] })).metadata).toEqual(["exif"]);
    expect(
      inspectImage(webpFixture({ width: 640, height: 480, vp8x: 0, extra: [webpChunk("ABCD", ascii("xx"))] }))
        .metadata,
    ).toEqual(["other"]);
    // ICC-профиль — не метаданные
    expect(
      inspectImage(
        webpFixture({
          width: 640,
          height: 480,
          vp8x: VP8X_FLAGS.icc,
          extra: [webpChunk("ICCP", ascii("p"))],
        }),
      ).metadata,
    ).toEqual([]);
  });

  it("PNG: eXIf, текстовые чанки, XMP, дата", () => {
    const meta = (chunks: Uint8Array[]) =>
      inspectImage(pngFixture({ width: 400, height: 400, chunks })).metadata;
    expect(meta([pngExif()])).toEqual(["exif"]);
    expect(meta([pngText()])).toEqual(["text"]);
    expect(meta([pngXmp()])).toEqual(["xmp"]);
    expect(meta([pngChunk("tIME", new Uint8Array(7))])).toEqual(["other"]);
    expect(meta([pngChunk("pHYs", new Uint8Array(9)), pngChunk("gAMA", new Uint8Array(4))])).toEqual([]);
  });
});

describe("inspectImage: анимация", () => {
  it("анимированный WebP и APNG", () => {
    expect(inspectImage(webpFixture({ width: 640, height: 480, vp8x: VP8X_FLAGS.animation })).animated).toBe(
      true,
    );
    const apng = pngFixture({ width: 400, height: 400, chunks: [pngChunk("acTL", new Uint8Array(8))] });
    expect(inspectImage(apng).animated).toBe(true);
  });
});

describe("inspectImage: битые и необычные файлы", () => {
  it("обрезанный файл", () => {
    const jpeg = jpegFixture({ width: 640, height: 480 });
    expect(code(() => inspectImage(jpeg.subarray(0, jpeg.length - 2)))).toBe("corrupt");
    expect(code(() => inspectImage(jpeg.subarray(0, 40)))).toBe("corrupt");
    const png = pngFixture({ width: 400, height: 400 });
    expect(code(() => inspectImage(png.subarray(0, png.length - 12)))).toBe("corrupt");
    const webp = webpFixture({ width: 640, height: 480 });
    expect(code(() => inspectImage(webp.subarray(0, webp.length - 1)))).toBe("corrupt");
  });

  it("данные после конца изображения («живое фото», вложенный архив)", () => {
    const trailer = ascii("....ftypmp42....");
    expect(code(() => inspectImage(jpegFixture({ width: 640, height: 480, trailer })))).toBe("corrupt");
    expect(code(() => inspectImage(concat(pngFixture({ width: 400, height: 400 }), trailer)))).toBe(
      "corrupt",
    );
    // В WebP хвост ломает размер RIFF
    expect(code(() => inspectImage(concat(webpFixture({ width: 640, height: 480 }), trailer)))).toBe(
      "corrupt",
    );
  });

  it("JPEG: 12 бит, CMYK, арифметическое кодирование — не поддерживаются", () => {
    const jpeg = jpegFixture({ width: 640, height: 480 });
    const sofAt = jpeg.findIndex((v, i) => v === 0xff && jpeg[i + 1] === 0xc0);
    const patched = (patch: (b: Uint8Array) => void) => {
      const b = jpeg.slice();
      patch(b);
      return b;
    };
    expect(code(() => inspectImage(patched((b) => (b[sofAt + 4] = 12))))).toBe("unsupported_format");
    expect(code(() => inspectImage(patched((b) => (b[sofAt + 9] = 4))))).toBe("unsupported_format");
    expect(code(() => inspectImage(patched((b) => (b[sofAt + 1] = 0xc9))))).toBe("unsupported_format");
    // progressive (SOF2) — обычный формат камер и браузеров
    expect(inspectImage(patched((b) => (b[sofAt + 1] = 0xc2)))).toMatchObject({ width: 640, height: 480 });
  });

  it("WebP: кадр не совпадает с холстом VP8X, второй кадр", () => {
    const mismatch = riff([
      webpChunk("VP8X", concat(Uint8Array.of(0, 0, 0, 0), Uint8Array.of(0xff, 0x09, 0, 0xdf, 0x01, 0))), // 2560×480
      webpChunk("VP8L", vp8lSolid(640, 480)),
    ]);
    expect(code(() => inspectImage(mismatch))).toBe("corrupt");
    const twoFrames = riff([webpChunk("VP8L", vp8lSolid(640, 480)), webpChunk("VP8L", vp8lSolid(640, 480))]);
    expect(code(() => inspectImage(twoFrames))).toBe("corrupt");
  });

  it("PNG: неизвестный критичный чанк", () => {
    const png = pngFixture({ width: 400, height: 400, chunks: [pngChunk("ZZZZ", new Uint8Array(1))] });
    expect(code(() => inspectImage(png))).toBe("unsupported_format");
  });
});

describe("assertUploadable: правила сервера", () => {
  it("чистое фото подходящего размера проходит", () => {
    expect(assertUploadable(webpFixture({ width: 2560, height: 1920 }))).toMatchObject({
      width: 2560,
      height: 1920,
    });
    expect(assertUploadable(jpegFixture({ width: 1280, height: 960 }))).toMatchObject({ format: "jpeg" });
    expect(assertUploadable(pngFixture({ width: 320, height: 320 }))).toMatchObject({ format: "png" });
  });

  it("EXIF и XMP отклоняются — их должен был вырезать браузер", () => {
    const err = (() => {
      try {
        assertUploadable(jpegFixture({ width: 1280, height: 960, segments: [exifSegment(), xmpSegment()] }));
      } catch (e) {
        return e as ImageError;
      }
      throw new Error("ожидалась ошибка");
    })();
    expect(err.code).toBe("metadata_present");
    expect(err.details).toEqual(["exif", "xmp"]);
    const webpExif = webpFixture({
      width: 1280,
      height: 960,
      vp8x: VP8X_FLAGS.exif,
      extra: [webpChunk("EXIF", ascii("MM\0*"))],
    });
    expect(code(() => assertUploadable(webpExif))).toBe("metadata_present");
  });

  it("размеры: длинная сторона ≤ 2560, короткая ≥ 320", () => {
    expect(code(() => assertUploadable(webpFixture({ width: 2561, height: 1000 })))).toBe(
      "dimensions_too_large",
    );
    expect(code(() => assertUploadable(webpFixture({ width: 1000, height: 4000 })))).toBe(
      "dimensions_too_large",
    );
    expect(code(() => assertUploadable(webpFixture({ width: 2560, height: 319 })))).toBe(
      "dimensions_too_small",
    );
    expect(assertUploadable(webpFixture({ width: 2560, height: 320 }))).toMatchObject({ height: 320 });
  });

  it("больше 10 МБ — too_large, не разбирая", () => {
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1); // даже не картинка: до разбора не доходит
    expect(code(() => assertUploadable(big))).toBe("too_large");
  });

  it("анимация отклоняется", () => {
    expect(
      code(() => assertUploadable(webpFixture({ width: 640, height: 480, vp8x: VP8X_FLAGS.animation }))),
    ).toBe("animated");
  });

  it("свои пределы (например, для тестов)", () => {
    const limits = { maxBytes: 100, maxLongSide: 64, minShortSide: 1 };
    expect(assertUploadable(webpFixture({ width: 64, height: 1 }), limits)).toMatchObject({ width: 64 });
    expect(code(() => assertUploadable(jpegFixture({ width: 8, height: 8 }), limits))).toBe("too_large");
  });
});
