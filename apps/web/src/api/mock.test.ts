import { isListingPhotoKey } from "@bayramm/media";
import { comparablePriceUzs, type ListingCard } from "@bayramm/shared/api";
import { describe, expect, it } from "vitest";
import { busyLast, SORTS } from "../screens/catalog-feed";
import { createMockApi, demoListings } from "./mock";

const TODAY = "2026-10-01";
const NOW = Date.parse("2026-10-01T07:00:00Z");
const BUSY_DAY = "2026-10-08";

async function everything(api: ReturnType<typeof createMockApi>, query: Parameters<typeof api.catalog>[0]) {
  const items: ListingCard[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.catalog({ ...query, cursor, limit: 7 });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

describe("демо-API по контракту", () => {
  const listings = demoListings(TODAY);
  const api = createMockApi({ now: () => NOW, listings });

  it("демо-данные проходят правила публикации: цена, три фото, ключи фото настоящего вида", () => {
    for (const listing of listings) {
      expect(listing.priceFromUzs).toBeGreaterThan(0);
      expect(listing.photos.length).toBeGreaterThanOrEqual(3);
      for (const photo of listing.photos) expect(isListingPhotoKey(photo.key)).toBe(true);
      expect(listing.slug).toMatch(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/);
      // Телефоны в несуществующем коде оператора: живые люди не пострадают
      expect(listing.phone).toMatch(/^\+99800\d{7}$/);
    }
  });

  it("курсор отдаёт всех ровно по разу", async () => {
    const items = await everything(api, {});
    expect(items).toHaveLength(listings.length);
    expect(new Set(items.map((i) => i.id)).size).toBe(listings.length);
  });

  for (const sort of [undefined, ...SORTS])
    it(`занятые на дату — в конце и не спрятаны (порядок: ${sort ?? "по умолчанию"})`, async () => {
      const items = await everything(api, { date: BUSY_DAY, sort });
      expect(items).toHaveLength(listings.length);
      const firstBusy = items.findIndex((i) => i.busyOnDate === true);
      expect(firstBusy).toBeGreaterThan(0);
      expect(items.slice(firstBusy).every((i) => i.busyOnDate === true)).toBe(true);
      expect(busyLast(items)).toEqual(items);
    });

  it("гости отсекают по вместимости; без даты busyOnDate — null", async () => {
    const items = await everything(api, { guests: 500 });
    expect(items.every((i) => (i.capMax ?? 0) >= 500)).toBe(true);
    expect(items.every((i) => i.busyOnDate === null)).toBe(true);
  });

  it("порядок по цене (как на сервере: одна шкала для цены за гостя и за мероприятие) и вместимости", async () => {
    const units = new Set(listings.map((l) => l.priceUnit));
    expect(units).toEqual(new Set(["per_guest", "per_event"]));
    for (const guests of [null, 150, 400]) {
      const query = guests === null ? {} : { guests };
      const cheap = (await everything(api, { ...query, sort: "price_asc" })).map((i) =>
        comparablePriceUzs(i, guests),
      );
      expect(cheap, `гостей: ${guests}`).toEqual([...cheap].sort((a, b) => a - b));
      const rich = (await everything(api, { ...query, sort: "price_desc" })).map((i) =>
        comparablePriceUzs(i, guests),
      );
      expect(rich, `гостей: ${guests}`).toEqual([...rich].sort((a, b) => b - a));
    }
    const big = await everything(api, { sort: "capacity_desc" });
    expect(big.map((i) => i.capMax)).toEqual(
      [...big.map((i) => i.capMax)].sort((a, b) => (b ?? 0) - (a ?? 0)),
    );
  });

  it("несуществующая площадка — 404", async () => {
    await expect(api.listing("net-takoy")).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("заявка: 409 на ту же дату, отзыв — только активной", async () => {
    const fresh = createMockApi({ now: () => NOW, listings });
    const listing = listings[0];
    if (!listing) throw new Error("нет площадки");
    const body = {
      listingId: listing.id,
      occasionCode: "toy",
      eventDate: "2026-10-20",
      guests: 100,
      contactName: "A",
      contactPhone: "+998001234567",
      requestTransferConsentId: "demo-request_transfer-ru",
    };
    const created = await fresh.createRequest(body);
    expect(created.slaDueAt).toBe("2026-10-01T19:00:00.000Z");
    await expect(fresh.createRequest(body)).rejects.toMatchObject({
      status: 409,
      code: "duplicate_request",
      existingId: created.id,
    });
    await expect(fresh.withdrawRequest(created.id)).resolves.toMatchObject({ status: "withdrawn" });
    await expect(fresh.withdrawRequest(created.id)).rejects.toMatchObject({ status: 409 });
    // Отозванная не мешает новой на ту же дату
    await expect(fresh.createRequest(body)).resolves.toMatchObject({ status: "new" });
  });

  it("оплаты в данных нет вовсе: порядок не может от неё зависеть", () => {
    for (const listing of listings)
      expect(JSON.stringify(listing)).not.toMatch(/promo|paid|premium|rating|review/i);
  });
});
