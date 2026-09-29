import { describe, expect, it } from "vitest";
import { freeSlug, SLUG_RE, slugify } from "./slug";

describe("slugify", () => {
  it.each([
    ["Oqsaroy", "oqsaroy"],
    ["Тойхона «Хумо»", "toyxona-xumo"],
    ["Ўрда Қасри", "orda-qasri"],
    ["Gʻuncha Toʻyxonasi", "guncha-toyxonasi"],
    ["  Grand   Hall №2  ", "grand-hall-2"],
    ["Café Élite", "cafe-elite"],
  ])("%s → %s", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it("длинное название обрезается по правилам базы", () => {
    const slug = slugify("Очень длинное название тойхоны на целых пятьдесят символов и больше");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toMatch(SLUG_RE);
  });

  it("из названия ничего не вышло — «hall»", () => {
    expect(slugify("№ 1")).toBe("hall");
    expect(slugify("★★★")).toBe("hall");
  });
});

describe("freeSlug", () => {
  it("свободная основа — как есть, занятая — с номером", () => {
    expect(freeSlug("humo", new Set())).toBe("humo");
    expect(freeSlug("humo", new Set(["humo"]))).toBe("humo-2");
    expect(freeSlug("humo", new Set(["humo", "humo-2"]))).toBe("humo-3");
  });

  it("с номером не длиннее 40 символов", () => {
    const base = "a".repeat(40);
    const slug = freeSlug(base, new Set([base]));
    expect(slug).toMatch(SLUG_RE);
    expect(slug.endsWith("-2")).toBe(true);
  });
});
