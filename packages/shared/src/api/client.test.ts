import { describe, expect, it } from "vitest";
import {
  clientCatalogPath,
  clientRequestPath,
  comparablePriceUzs,
  estimatedTotalUzs,
  FEATURED_LISTINGS,
  type ListingCard,
  pickFeatured,
} from "./client";

const perGuest = { priceFromUzs: 150_000, priceUnit: "per_guest", capMax: 400 } as const;
const perEvent = { priceFromUzs: 33_000_000, priceUnit: "per_event", capMax: 300 } as const;

describe("сравнимая цена", () => {
  it("без гостей — на гостя: за мероприятие делится на вместимость, вверх", () => {
    expect(comparablePriceUzs(perGuest, null)).toBe(150_000);
    expect(comparablePriceUzs(perEvent, null)).toBe(110_000);
    expect(comparablePriceUzs({ ...perEvent, priceFromUzs: 33_000_001 }, null)).toBe(110_001);
  });

  it("с гостями — примерная сумма: за гостя × гости, за мероприятие как есть", () => {
    expect(comparablePriceUzs(perGuest, 200)).toBe(30_000_000);
    expect(comparablePriceUzs(perEvent, 200)).toBe(33_000_000);
    expect(estimatedTotalUzs(perGuest, 250)).toBe(37_500_000);
    expect(estimatedTotalUzs(perEvent, 250)).toBe(33_000_000);
  });

  it("порядок меняется с числом гостей: зал за мероприятие выгоднее на большую компанию", () => {
    const cheaper = (guests: number | null) =>
      comparablePriceUzs(perEvent, guests) < comparablePriceUzs(perGuest, guests) ? "event" : "guest";
    expect(cheaper(null)).toBe("event");
    expect(cheaper(200)).toBe("guest");
    expect(cheaper(250)).toBe("event");
  });
});

describe("ссылки на экраны клиента", () => {
  it("заявка в «Моих заявках»", () => {
    expect(clientRequestPath("eeeeeeee-0000-4000-8000-0000000000a1")).toBe(
      "/requests?open=eeeeeeee-0000-4000-8000-0000000000a1",
    );
  });

  it("каталог с фильтрами; пустые не пишутся", () => {
    expect(clientCatalogPath({ date: "2026-12-12", guests: 200, district: "chilonzor" })).toBe(
      "/?date=2026-12-12&guests=200&district=chilonzor",
    );
    // Залы — явно: каталог без категории — все разделы
    expect(clientCatalogPath({ category: "hall", date: "2026-12-12" })).toBe(
      "/?category=hall&date=2026-12-12",
    );
    expect(clientCatalogPath({ date: "2026-12-12", guests: null, district: null })).toBe("/?date=2026-12-12");
    expect(clientCatalogPath({})).toBe("/");
  });
});

describe("витрины лендинга (pickFeatured)", () => {
  const card = (category: string, n: number): ListingCard => ({
    id: `${category}-${n}`,
    slug: `${category}-${n}`,
    name: `${category} ${n}`,
    categoryCode: category,
    districtCode: null,
    priceFromUzs: 100_000 * n,
    priceUnit: "per_event",
    capMin: null,
    capMax: null,
    cover: null,
    photoCount: 3,
    busyOnDate: null,
    dateLoad: null,
  });
  const list = (category: string, count: number) =>
    Array.from({ length: count }, (_, i) => card(category, i + 1));
  const ids = (cards: readonly ListingCard[]) => cards.map((c) => c.id);

  it("разделов четыре и больше — первая витрина каждого из первых четырёх", () => {
    const lists = ["hall", "car", "photo", "cake", "decor"].map((c) => list(c, 3));
    expect(FEATURED_LISTINGS).toBe(4);
    expect(ids(pickFeatured(lists))).toEqual(["hall-1", "car-1", "photo-1", "cake-1"]);
  });

  it("разделов мало — по несколько из каждого, по очереди", () => {
    expect(ids(pickFeatured([list("hall", 5), list("cake", 5)]))).toEqual([
      "hall-1",
      "cake-1",
      "hall-2",
      "cake-2",
    ]);
    expect(ids(pickFeatured([list("cake", 9)]))).toEqual(["cake-1", "cake-2", "cake-3", "cake-4"]);
    // Три раздела: по две из каждого, но всего четыре
    expect(ids(pickFeatured([list("a", 3), list("b", 3), list("c", 3)]))).toEqual([
      "a-1",
      "b-1",
      "c-1",
      "a-2",
    ]);
  });

  it("витрин в разделе меньше, чем нужно, — берётся сколько есть; пустые разделы пропускаются", () => {
    // Как и раньше: из двух разделов по две, поэтому у «Тойхан» одна, у тортов две — всего три
    expect(ids(pickFeatured([list("hall", 1), [], list("cake", 5)]))).toEqual(["hall-1", "cake-1", "cake-2"]);
    expect(pickFeatured([])).toEqual([]);
    expect(pickFeatured([[], []])).toEqual([]);
  });
});
