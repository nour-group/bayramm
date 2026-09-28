import { describe, expect, it } from "vitest";
import { assertUploadable, inspectImage } from "./inspect";
import { stripMetadata } from "./strip";
import {
  commentSegment,
  exifSegment,
  iccSegment,
  iptcSegment,
  jpegFixture,
  pngChunk,
  pngExif,
  pngFixture,
  pngText,
  pngXmp,
  VP8X_FLAGS,
  webpChunk,
  webpFixture,
  xmpSegment,
} from "./testing";

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

describe("stripMetadata", () => {
  it("JPEG: убирает EXIF, XMP, IPTC, комментарий и миниатюру; ICC и пиксели на месте", () => {
    const clean = jpegFixture({ width: 1280, height: 960, segments: [iccSegment()] });
    const dirty = jpegFixture({
      width: 1280,
      height: 960,
      jfifThumbnail: true,
      segments: [exifSegment(), iccSegment(), xmpSegment(), iptcSegment(), commentSegment()],
    });
    const stripped = stripMetadata(dirty);
    expect(inspectImage(stripped)).toMatchObject({ width: 1280, height: 960, metadata: [] });
    // APP0 с миниатюрой убран целиком, остальное совпадает с чистым файлом без APP0
    const withoutApp0 = (b: Uint8Array) => Array.from(b.subarray(b.indexOf(0xe2) - 1));
    expect(withoutApp0(stripped)).toEqual(withoutApp0(clean));
    expect(assertUploadable(stripped).format).toBe("jpeg");
  });

  it("WebP: убирает чанки EXIF и XMP, сбрасывает флаги, пересчитывает размер RIFF", () => {
    const dirty = webpFixture({
      width: 1280,
      height: 960,
      vp8x: VP8X_FLAGS.exif | VP8X_FLAGS.xmp | VP8X_FLAGS.icc,
      extra: [webpChunk("EXIF", ascii("MM\0*payload")), webpChunk("XMP ", ascii("<x:xmpmeta/>"))],
    });
    const stripped = stripMetadata(dirty);
    const view = new DataView(stripped.buffer, stripped.byteOffset, stripped.byteLength);
    expect(view.getUint32(4, true)).toBe(stripped.length - 8);
    expect(stripped[20]).toBe(VP8X_FLAGS.icc); // ICC-флаг остался, EXIF и XMP сброшены
    expect(inspectImage(stripped)).toMatchObject({ width: 1280, height: 960, metadata: [] });
    expect(stripped).toEqual(webpFixture({ width: 1280, height: 960, vp8x: VP8X_FLAGS.icc }));
  });

  it("WebP: только флаг без чанка — тоже чистится", () => {
    const stripped = stripMetadata(webpFixture({ width: 640, height: 480, vp8x: VP8X_FLAGS.exif }));
    expect(inspectImage(stripped).metadata).toEqual([]);
  });

  it("PNG: убирает eXIf, tEXt, iTXt (XMP), tIME; pHYs оставляет", () => {
    const phys = pngChunk("pHYs", new Uint8Array(9));
    const dirty = pngFixture({
      width: 400,
      height: 400,
      chunks: [pngExif(), phys, pngText(), pngXmp(), pngChunk("tIME", new Uint8Array(7))],
    });
    const stripped = stripMetadata(dirty);
    expect(stripped).toEqual(pngFixture({ width: 400, height: 400, chunks: [phys] }));
  });

  it("чистый файл возвращается как есть, без копии", () => {
    const clean = webpFixture({ width: 640, height: 480 });
    expect(stripMetadata(clean)).toBe(clean);
  });

  it("не картинка — ошибка, а не «пустой результат»", () => {
    let error: unknown;
    try {
      stripMetadata(ascii("<svg/>"));
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ name: "ImageError", code: "unsupported_format" });
  });
});
