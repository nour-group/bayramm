import { SUGGEST_LISTINGS } from "@bayramm/shared/api";
import { describe, expect, it } from "vitest";
import { allDemoListings, createMockApi } from "./mock";

/* Поиск демо-API — по контракту сервера: q вместе с фильтрами, порядок «сначала подходящие» по
   умолчанию, total на первой странице, короткий q — не поиск, длинный — 400; подсказки —
   разделы, районы в разделе, до пяти витрин */

const NOW = Date.parse("2026-10-01T07:00:00Z");
const listings = allDemoListings("2026-10-01");
const api = createMockApi({ now: () => NOW, listings });
const names = (items: readonly { name: string }[]) => items.map((i) => i.name);

describe("демо-API: поиск", () => {
  it("кириллица и латиница, с апострофом и без — одна выдача", async () => {
    const latin = await api.catalog({ category: "all", q: "kortej" });
    const cyrillic = await api.catalog({ category: "all", q: "КОРТЕЖ" });
    expect(names(cyrillic.items)).toEqual(names(latin.items));
    expect(latin.total).toBe(3);
    const okina = await api.catalog({ category: "all", q: "Toʻyxona" });
    const plain = await api.catalog({ category: "all", q: "toyxona" });
    expect(names(okina.items)).toEqual(names(plain.items));
    expect(okina.items.length).toBeGreaterThan(0);
  });

  it("опечатка находит; порядок по умолчанию — подходящие сверху", async () => {
    const page = await api.catalog({ category: "all", q: "limuzn lux" });
    expect(names(page.items)[0]).toBe("Limuzin Lux");
  });

  it("вместе с разделом и фильтрами; total — только на первой странице", async () => {
    const all = await api.catalog({ category: "all", q: "zali" });
    const inHall = await api.catalog({ category: "hall", q: "zali", district: "chilonzor" });
    expect(inHall.items.every((i) => i.categoryCode === "hall" && i.districtCode === "chilonzor")).toBe(true);
    expect(inHall.items.length).toBeLessThan(all.items.length);
    const first = await api.catalog({ category: "all", q: "zali", limit: 2 });
    expect(first.total).toBe(all.total);
    const next = await api.catalog({ category: "all", q: "zali", limit: 2, cursor: first.nextCursor ?? "" });
    expect(next.total).toBeUndefined();
  });

  it("порядок по цене с q — тот же отбор, другой порядок", async () => {
    const relevant = await api.catalog({ category: "all", q: "zali", limit: 50 });
    const cheap = await api.catalog({ category: "all", q: "zali", sort: "price_asc", limit: 50 });
    expect(new Set(names(cheap.items))).toEqual(new Set(names(relevant.items)));
  });

  it("короткий q — не поиск, длинный — 400 [q]", async () => {
    const plain = await api.catalog({ category: "car" });
    const short = await api.catalog({ category: "car", q: "a" });
    expect(names(short.items)).toEqual(names(plain.items));
    expect(short.total).toBeUndefined();
    await expect(api.catalog({ category: "all", q: "щ".repeat(40) })).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
    });
  });

  it("подсказки: разделы, районы в разделе, витрины — не больше пяти", async () => {
    const car = await api.suggest("кортеж");
    expect(car.categories.map((c) => c.code)).toEqual(["car"]);
    expect(car.listings.length).toBeGreaterThan(0);
    const district = await api.suggest("chilonzor");
    expect(district.districts[0]).toMatchObject({
      code: "chilonzor",
      name: { ru: "Чиланзар", uz: "Chilonzor" },
    });
    expect(district.districts.every((d) => d.listings > 0)).toBe(true);
    const many = await api.suggest("zali");
    expect(many.listings.length).toBeLessThanOrEqual(SUGGEST_LISTINGS);
    expect(await api.suggest("a")).toEqual({ categories: [], districts: [], listings: [] });
  });
});
