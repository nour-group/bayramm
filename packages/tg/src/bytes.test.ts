import { describe, expect, it } from "vitest";
import { base64UrlToBytes, hexToBytes, timingSafeEqual } from "./bytes";

describe("timingSafeEqual", () => {
  it("равные массивы", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it("отличие в последнем байте", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it("разная длина", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe("hexToBytes", () => {
  it("строчный hex", () => {
    expect(hexToBytes("00ff10")).toEqual(new Uint8Array([0, 255, 16]));
  });

  it.each(["", "0", "FF", "0g", " 00"])("%j → null", (hex) => {
    expect(hexToBytes(hex)).toBeNull();
  });
});

describe("base64UrlToBytes", () => {
  it.each([
    ["-_8", [251, 255]],
    ["-_8=", [251, 255]],
    ["AQID", [1, 2, 3]],
    ["", []],
  ])("%j", (value, bytes) => {
    expect(base64UrlToBytes(value)).toEqual(new Uint8Array(bytes));
  });

  it.each(["+/8", "AQ ID", "A", "AQ=ID", "AQID==="])("%j → null", (value) => {
    expect(base64UrlToBytes(value)).toBeNull();
  });
});
