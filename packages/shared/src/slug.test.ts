import { describe, expect, it } from "vitest";
import { finishSlug, SLUG_RE, slugFromName, typingSlug } from "./slug";

describe("slugFromName", () => {
  it.each([
    ["Oqsaroy", "oqsaroy"],
    ["Тойхона «Хумо»", "toyxona-xumo"],
    ["Ўрда Қасри", "orda-qasri"],
    ["Gʻuncha Toʻyxonasi", "guncha-toyxonasi"],
    ["  Grand   Hall №2  ", "grand-hall-2"],
    ["Café Élite", "cafe-elite"],
  ])("%s → %s", (name, slug) => {
    expect(slugFromName(name)).toBe(slug);
  });

  it("длинное — не длиннее 40 и без дефиса в конце", () => {
    const slug = slugFromName("Очень длинное название тойхоны на целых пятьдесят символов и больше");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toMatch(SLUG_RE);
  });

  it("из названия ничего не вышло — коротко или пусто (адрес не пройдёт проверку)", () => {
    expect(slugFromName("№ 1")).toBe("1");
    expect(slugFromName("★★★")).toBe("");
    expect(SLUG_RE.test(slugFromName("★★★"))).toBe(false);
  });
});

describe("typingSlug / finishSlug", () => {
  it("пока набирают: строчные, кириллица — латиницей, пробел — дефисом, дефис в конце остаётся", () => {
    expect(typingSlug("Oq Saroy ")).toBe("oq-saroy-");
    expect(typingSlug("Хумо")).toBe("xumo");
    expect(typingSlug("--grand__hall!!")).toBe("grand-hall-");
    expect(typingSlug("a".repeat(50))).toHaveLength(40);
  });

  it("набрали — без дефисов по краям", () => {
    expect(finishSlug("oq-saroy-")).toBe("oq-saroy");
    expect(finishSlug(" -humo- ")).toBe("humo");
  });
});
