import { describe, expect, it } from "vitest";
import { buildStartParam, parseStartParam } from "./index";

describe("parseStartParam", () => {
  it.each([
    ["vendor_toyxona-1", "toyxona-1"],
    ["vendor_42", "42"],
    ["vendor_3f0c9a52-7a1e-4c1b-9a6e-2f5d8c0b1e7a", "3f0c9a52-7a1e-4c1b-9a6e-2f5d8c0b1e7a"],
    [`vendor_${"a".repeat(64)}`, "a".repeat(64)],
  ])("%s → вендор %s", (startParam, id) => {
    expect(parseStartParam(startParam)).toEqual({ kind: "vendor", id });
  });

  it.each([
    ["заглавные в id", "vendor_Toyxona"],
    ["точка", "vendor_a.b"],
    ["подчёркивание в id", "vendor_a_b"],
    ["слэш", "vendor_../admin"],
    ["percent-encoding", "vendor_a%20b"],
    ["пробел", "vendor_a b"],
    ["кириллица", "vendor_тойхона"],
    ["перевод строки", "vendor_a\n"],
    ["пустой id", "vendor_"],
  ])("недопустимые символы: %s → null", (_name, startParam) => {
    expect(parseStartParam(startParam)).toBeNull();
  });

  it("id длиннее 64 символов → null", () => {
    expect(parseStartParam(`vendor_${"a".repeat(65)}`)).toBeNull();
  });

  it("start_param длиннее 512 символов → null", () => {
    expect(parseStartParam(`vendor_${"a".repeat(506)}`)).toBeNull();
  });

  it.each(["v_toyxona", "Vendor_toyxona", "vendors_toyxona", "vendor", "toyxona", ""])(
    "незнакомый маршрут %j → null",
    (startParam) => {
      expect(parseStartParam(startParam)).toBeNull();
    },
  );

  it.each([null, undefined])("%s → null", (startParam) => {
    expect(parseStartParam(startParam)).toBeNull();
  });
});

describe("buildStartParam", () => {
  it("собирает то, что потом разбирает parseStartParam", () => {
    const startParam = buildStartParam({ kind: "vendor", id: "toyxona-1" });
    expect(startParam).toBe("vendor_toyxona-1");
    expect(parseStartParam(startParam)).toEqual({ kind: "vendor", id: "toyxona-1" });
  });

  it.each(["", "Toyxona", "a_b", "a".repeat(65)])("не собирает ссылку с id %j", (id) => {
    expect(() => buildStartParam({ kind: "vendor", id })).toThrow(RangeError);
  });
});
