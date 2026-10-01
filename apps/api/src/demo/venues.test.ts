// Демо-витрины: помечены, вымышлены и проходят те же проверки, что витрины из панели —
// поля витрины и услуги по конфигурации категорий (@bayramm/shared/categories).
// Диапазон id — тот же, что в app.demo_purge(): иначе reset не нашёл бы их или нашёл бы лишнее
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasNonCanonicalApostrophe, isUzPhone, normalizeUz } from "@bayramm/shared";
import {
  CATEGORIES,
  categoryConfig,
  missingAttributes,
  validateAttributePatch,
  validateServiceInput,
} from "@bayramm/shared/categories";
import { describe, expect, it } from "vitest";
import { charLength } from "../staff/input";
import { SLUG_RE } from "../staff/slug";
import {
  DEMO_BUSY_HORIZON_DAYS,
  DEMO_ID_PREFIX,
  DEMO_PHOTO_COUNT,
  DEMO_PHOTOS_PER_VENUE,
  DEMO_VENUES,
  type DemoVenue,
  demoContacts,
} from "./venues";

const MIGRATIONS = join(import.meta.dirname, "../../../../supabase/migrations");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Районы из справочника (20260928120000_foundation.sql)
const DISTRICTS = [
  "yunusobod",
  "mirzo_ulugbek",
  "chilonzor",
  "yakkasaroy",
  "shayxontohur",
  "mirobod",
  "sergeli",
  "uchtepa",
  "olmazor",
  "yashnobod",
  "bektemir",
  "yangihayot",
];
// Правила продукта: «Заявка, не бронь»; оплаченное — только «Реклама»
const FORBIDDEN = { ru: [/брон/i, /продвижен/i], uz: [/bron/i, /band\s+qil/i] };

const uzTexts = (venue: DemoVenue) => [
  venue.descriptionUz,
  venue.addressUz,
  ...venue.services.flatMap((s) => [s.includes?.uz, s.name?.uz]).filter((t) => t !== undefined),
];
const ruTexts = (venue: DemoVenue) => [venue.descriptionRu, venue.addressRu, venue.name];

const config = (venue: DemoVenue) => {
  const category = categoryConfig(venue.category);
  if (category === undefined) throw new Error(venue.category);
  return category;
};

describe("демо-витрины: метка и диапазон id", () => {
  it("три зала и по витрине в каждой включённой категории; id — в демо-диапазоне, без повторов", () => {
    expect(DEMO_VENUES.filter((v) => v.category === "hall")).toHaveLength(3);
    const enabled = CATEGORIES.filter((c) => c.enabled && c.code !== "hall").map((c) => c.code);
    expect(DEMO_VENUES.filter((v) => v.category !== "hall").map((v) => v.category)).toEqual(enabled);
    const ids = DEMO_VENUES.flatMap((v) => [v.vendorId, v.listingId]);
    for (const id of ids) {
      expect(id).toMatch(UUID_RE);
      expect(id.startsWith(DEMO_ID_PREFIX)).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("app.demo_purge() ищет вендоров по тому же префиксу", () => {
    const files = readdirSync(MIGRATIONS).filter((name) =>
      readFileSync(join(MIGRATIONS, name), "utf8").includes("function app.demo_purge()"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(join(MIGRATIONS, file), "utf8")).toContain(`v.id::text like '${DEMO_ID_PREFIX}%'`);
    }
  });

  it("префикс не пересекается со случайными UUID v4 и не содержит символов шаблона LIKE", () => {
    // У gen_random_uuid() первые 12 знаков случайны: 00000000-0000 выпадает с вероятностью 2^-48
    expect(DEMO_ID_PREFIX).toBe("00000000-0000-4000-8000-de");
    expect(DEMO_ID_PREFIX).not.toMatch(/[%_\\]/);
  });

  it("всё, что видит клиент, помечено: «Демо-… · Demo …», предупреждение, демо-адрес", () => {
    for (const venue of DEMO_VENUES) {
      expect(venue.name).toMatch(/^Демо-\S+ «[^»]+» · Demo [^«]+«[^»]+»$/);
      expect(venue.vendorName.startsWith("Демо")).toBe(true);
      expect(venue.slug.startsWith("demo-")).toBe(true);
      expect(venue.descriptionRu.startsWith("Демонстрационная карточка: тако")).toBe(true);
      expect(venue.descriptionUz.startsWith("Namoyish kartochkasi: bunday")).toBe(true);
      expect(venue.addressRu).toContain("демо-адрес");
      expect(venue.addressUz).toContain("demo manzil");
    }
  });

  it("телефоны и СТИР — заведомо вымышленные, но проходят проверки формата", () => {
    for (const venue of DEMO_VENUES) {
      // Кода оператора 00 в Узбекистане нет
      expect(venue.phone).toMatch(/^\+9980000000\d\d$/);
      expect(isUzPhone(venue.phone)).toBe(true);
      expect(venue.stir).toMatch(/^0000000\d\d$/);
    }
    expect(new Set(DEMO_VENUES.map((v) => v.stir)).size).toBe(DEMO_VENUES.length);
    expect(new Set(DEMO_VENUES.map((v) => v.phone)).size).toBe(DEMO_VENUES.length);
  });

  it("контакт — не человек: «Демо-контакт», без Telegram", () => {
    for (const venue of DEMO_VENUES) {
      expect(demoContacts(venue)).toMatchObject({ contact_person: "Демо-контакт", phone: venue.phone });
      expect(demoContacts(venue)).not.toHaveProperty("telegram_username");
    }
  });
});

describe("демо-витрины: как витрина из панели", () => {
  it("адрес, название и район — по правилам таблицы и справочника", () => {
    const slugs = DEMO_VENUES.map((v) => v.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const venue of DEMO_VENUES) {
      expect(venue.slug).toMatch(SLUG_RE);
      expect(charLength(venue.name)).toBeLessThanOrEqual(80);
      if (venue.districtCode !== null) expect(DISTRICTS).toContain(venue.districtCode);
      if (config(venue).listingFields.includes("district")) expect(venue.districtCode).not.toBeNull();
      for (const text of [venue.addressRu, venue.addressUz])
        expect(charLength(text)).toBeLessThanOrEqual(300);
      for (const text of [venue.descriptionRu, venue.descriptionUz]) {
        expect(charLength(text)).toBeLessThanOrEqual(4000);
      }
    }
  });

  it("поля витрины — по конфигурации категории, обязательные заполнены", () => {
    for (const venue of DEMO_VENUES) {
      const category = config(venue);
      const result = validateAttributePatch(category, venue.attributes);
      expect(result, venue.slug).toMatchObject({ ok: true });
      expect(missingAttributes(category, venue.attributes), venue.slug).toEqual([]);
    }
  });

  it("услуги — из каталога категории: цена, единица и опции проходят проверку; обязательные — есть", () => {
    for (const venue of DEMO_VENUES) {
      const category = config(venue);
      expect(venue.services.length).toBeGreaterThan(0);
      for (const service of venue.services) {
        const options = (service.options ?? []).map((o) => {
          const template = category.services
            .find((t) => t.code === service.type)
            ?.options.find((t) => t.code === o.code);
          expect(template, `${venue.slug}/${service.type}/${o.code}`).toBeDefined();
          return {
            code: o.code,
            name: { ru: "Опция", uz: "Opsiya" },
            priceUzs: o.priceUzs,
            priceUnit: o.priceUnit,
          };
        });
        const result = validateServiceInput(
          category,
          {
            type: service.type,
            priceUzs: service.priceUzs,
            priceUnit: service.priceUnit,
            ...(service.minQty === undefined ? {} : { minQty: service.minQty }),
            ...(service.leadDays === undefined ? {} : { leadDays: service.leadDays }),
            ...(service.includes === undefined ? {} : { includes: service.includes }),
            ...(service.name === undefined ? {} : { name: service.name }),
            options,
          },
          { create: true },
        );
        expect(result, `${venue.slug}/${service.type}`).toMatchObject({ ok: true });
      }
      const types = venue.services.map((s) => s.type);
      for (const required of category.requiredServices) expect(types).toContain(required);
    }
  });

  it("вместимость в гостях — только где она есть (залы), в пределах таблицы", () => {
    for (const venue of DEMO_VENUES) {
      if (config(venue).listingFields.includes("guest_capacity")) {
        expect(venue.capMin).toBeGreaterThanOrEqual(1);
        expect(venue.capMax).toBeGreaterThanOrEqual(venue.capMin ?? 0);
        expect(venue.capMax).toBeLessThanOrEqual(5000);
      } else {
        expect(venue.capMax).toBeNull();
      }
      expect(venue.parallelCapacity).toBeGreaterThanOrEqual(1);
      expect(venue.parallelCapacity).toBeLessThanOrEqual(50);
    }
  });

  it("занятые дни и части дня — в ближайшие 60 дней, по возрастанию, без повторов; части — только у режима parts", () => {
    for (const venue of DEMO_VENUES) {
      expect([...venue.busyDays].sort((a, b) => a - b)).toEqual(venue.busyDays);
      expect(new Set(venue.busyDays).size).toBe(venue.busyDays.length);
      for (const day of [...venue.busyDays, ...venue.busyParts.map((p) => p.offset)]) {
        expect(day).toBeGreaterThanOrEqual(1);
        expect(day).toBeLessThanOrEqual(DEMO_BUSY_HORIZON_DAYS);
      }
      if (config(venue).availability !== "parts") expect(venue.busyParts).toEqual([]);
      if (config(venue).availability === "lead") expect(venue.busyDays).toEqual([]);
      const parts = venue.busyParts.map((p) => `${p.offset}/${p.part}`);
      expect(new Set(parts).size).toBe(parts.length);
    }
    expect(DEMO_VENUES.filter((v) => v.category === "hall").every((v) => v.busyDays.length >= 3)).toBe(true);
  });

  it("фото: по три на витрину — минимум для публикации", () => {
    expect(DEMO_PHOTOS_PER_VENUE).toBe(3);
    expect(DEMO_PHOTO_COUNT).toBe(DEMO_VENUES.length * 3);
    for (const venue of DEMO_VENUES)
      expect(config(venue).minPhotos).toBeLessThanOrEqual(DEMO_PHOTOS_PER_VENUE);
  });
});

describe("демо-витрины: тексты", () => {
  it("узбекский — латиница; апострофы только U+02BB и U+02BC, текст нормализован", () => {
    for (const venue of DEMO_VENUES) {
      for (const text of uzTexts(venue)) {
        expect(text).not.toMatch(/[Ѐ-ӿ]/);
        expect(hasNonCanonicalApostrophe(text), text).toBe(false);
        expect(normalizeUz(text)).toBe(text);
      }
    }
    // Апострофы в текстах действительно есть — нормализация их не выбросила
    expect(DEMO_VENUES.map((v) => v.descriptionUz).join("")).toMatch(/[oOgG]ʻ/);
  });

  it("нет запрещённых слов: заявка, не бронь", () => {
    for (const venue of DEMO_VENUES) {
      for (const text of ruTexts(venue)) for (const re of FORBIDDEN.ru) expect(text).not.toMatch(re);
      for (const text of uzTexts(venue)) for (const re of FORBIDDEN.uz) expect(text).not.toMatch(re);
    }
  });
});
