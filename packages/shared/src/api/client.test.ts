import { describe, expect, it } from "vitest";
import { clientCatalogPath, clientRequestPath, comparablePriceUzs, estimatedTotalUzs } from "./client";

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
