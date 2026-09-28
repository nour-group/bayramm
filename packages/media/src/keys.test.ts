import { describe, expect, it } from "vitest";
import { MEDIA_WIDTHS } from "./constants";
import {
  isListingPhotoKey,
  listingPhotoKey,
  mediaSrcSet,
  mediaUrl,
  parseMediaPath,
  pickMediaWidth,
} from "./keys";

const LISTING = "0b5c2a3e-1111-4a2b-9c3d-000000000101";
const PHOTO = "7f0e6d5c-2222-4b3a-8d4e-0000000000f1";
const KEY = `listings/${LISTING}/${PHOTO}.webp`;

describe("ключи объектов", () => {
  it("listings/<листинг>/<фото>.<расширение>, UUID в нижнем регистре", () => {
    expect(listingPhotoKey(LISTING, PHOTO, "webp")).toBe(KEY);
    expect(listingPhotoKey(LISTING.toUpperCase(), PHOTO, "jpeg")).toBe(`listings/${LISTING}/${PHOTO}.jpg`);
    expect(listingPhotoKey(LISTING, PHOTO, "png")).toBe(`listings/${LISTING}/${PHOTO}.png`);
  });

  it("не UUID — ошибка кода, а не странный ключ", () => {
    expect(() => listingPhotoKey("../../etc", PHOTO, "webp")).toThrow(TypeError);
    expect(() => listingPhotoKey(LISTING, "x", "webp")).toThrow(TypeError);
  });

  it("isListingPhotoKey: только точный формат", () => {
    expect(isListingPhotoKey(KEY)).toBe(true);
    for (const bad of [
      `listings/${LISTING}/${PHOTO}.gif`,
      `listings/${LISTING}/${PHOTO}.WEBP`,
      `listings/${LISTING}/../${PHOTO}.webp`,
      `other/${LISTING}/${PHOTO}.webp`,
      `listings/${LISTING}/${PHOTO}.webp?x=1`,
      `/listings/${LISTING}/${PHOTO}.webp`,
      `listings/${LISTING.toUpperCase()}/${PHOTO}.webp`,
    ]) {
      expect(isListingPhotoKey(bad), bad).toBe(false);
    }
  });
});

describe("адреса вариантов", () => {
  it("parseMediaPath: /<ширина>/<ключ>, только разрешённые ширины", () => {
    expect(parseMediaPath(`/640/${KEY}`)).toEqual({ width: 640, key: KEY });
    for (const width of MEDIA_WIDTHS) expect(parseMediaPath(`/${width}/${KEY}`)?.width).toBe(width);
    for (const bad of [
      `/641/${KEY}`,
      `/0640/${KEY}`,
      `/3840/${KEY}`,
      `/640/${KEY}/`,
      `/640//${KEY}`,
      `/640/listings/${LISTING}/${PHOTO}.svg`,
      `/640/listings/${LISTING}/%2e%2e/${PHOTO}.webp`,
      `/640`,
      "/",
      `/${KEY}`,
    ]) {
      expect(parseMediaPath(bad), bad).toBeNull();
    }
  });

  it("mediaUrl по окружению или своему адресу", () => {
    expect(mediaUrl(KEY, 640, "production")).toBe(`https://media.bayramm.uz/640/${KEY}`);
    expect(mediaUrl(KEY, 1280, "staging")).toBe(`https://media-staging.bayramm.uz/1280/${KEY}`);
    expect(mediaUrl(KEY, 320, "local")).toBe(`http://localhost:8790/320/${KEY}`);
    expect(mediaUrl(KEY, 960, { origin: "https://media.example.test/" })).toBe(
      `https://media.example.test/960/${KEY}`,
    );
  });

  it("адрес mediaUrl разбирается parseMediaPath обратно", () => {
    for (const width of MEDIA_WIDTHS) {
      expect(parseMediaPath(new URL(mediaUrl(KEY, width, "production")).pathname)).toEqual({
        width,
        key: KEY,
      });
    }
  });

  it("mediaUrl не собирает адрес для чужого ключа или ширины", () => {
    expect(() => mediaUrl("secret/file.webp", 640, "production")).toThrow(TypeError);
    expect(() => mediaUrl(KEY, 641 as 640, "production")).toThrow(TypeError);
  });

  it("mediaSrcSet перечисляет все ширины", () => {
    expect(mediaSrcSet(KEY, "production", [320, 640])).toBe(
      `https://media.bayramm.uz/320/${KEY} 320w, https://media.bayramm.uz/640/${KEY} 640w`,
    );
    expect(mediaSrcSet(KEY, "production").split(", ")).toHaveLength(MEDIA_WIDTHS.length);
  });

  it("pickMediaWidth: наименьшая достаточная ширина с учётом плотности пикселей", () => {
    expect(pickMediaWidth(300)).toBe(320);
    expect(pickMediaWidth(320)).toBe(320);
    expect(pickMediaWidth(321)).toBe(640);
    expect(pickMediaWidth(375, 3)).toBe(1280);
    expect(pickMediaWidth(800, 3)).toBe(1920);
    expect(pickMediaWidth(200, 0.5)).toBe(320);
  });
});
