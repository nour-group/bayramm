// Демо-залы: помечены, вымышлены и проходят те же проверки, что карточки из панели.
// Диапазон id — тот же, что в app.demo_purge(): иначе reset не нашёл бы их или нашёл бы лишнее
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasNonCanonicalApostrophe, isUzPhone, normalizeUz } from "@bayramm/shared";
import { describe, expect, it } from "vitest";
import { charLength } from "../staff/input";
import { SLUG_RE } from "../staff/slug";
import {
  DEMO_BUSY_HORIZON_DAYS,
  DEMO_ID_PREFIX,
  DEMO_PHOTO_COUNT,
  DEMO_PHOTOS_PER_VENUE,
  DEMO_VENUES,
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

const uzTexts = (venue: (typeof DEMO_VENUES)[number]) => [venue.descriptionUz, venue.addressUz];
const ruTexts = (venue: (typeof DEMO_VENUES)[number]) => [venue.descriptionRu, venue.addressRu, venue.name];

describe("демо-залы: метка и диапазон id", () => {
  it("три зала; id вендоров и карточек — в демо-диапазоне и не повторяются", () => {
    expect(DEMO_VENUES).toHaveLength(3);
    const ids = DEMO_VENUES.flatMap((v) => [v.vendorId, v.listingId]);
    for (const id of ids) {
      expect(id).toMatch(UUID_RE);
      expect(id.startsWith(DEMO_ID_PREFIX)).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("app.demo_purge() ищет вендоров по тому же префиксу", () => {
    const file = readdirSync(MIGRATIONS).find((name) => name.endsWith("_demo_purge.sql"));
    expect(file).toBeDefined();
    const sql = readFileSync(join(MIGRATIONS, file ?? ""), "utf8");
    expect(sql).toContain(`v.id::text like '${DEMO_ID_PREFIX}%'`);
  });

  it("префикс не пересекается со случайными UUID v4 и не содержит символов шаблона LIKE", () => {
    // У gen_random_uuid() первые 12 знаков случайны: 00000000-0000 выпадает с вероятностью 2^-48
    expect(DEMO_ID_PREFIX).toBe("00000000-0000-4000-8000-de");
    expect(DEMO_ID_PREFIX).not.toMatch(/[%_\\]/);
  });

  it("всё, что видит клиент, помечено: «Демо-зал · Demo zal», предупреждение, демо-адрес", () => {
    for (const venue of DEMO_VENUES) {
      expect(venue.name).toMatch(/^Демо-зал «[^»]+» · Demo zal «[^»]+»$/);
      expect(venue.vendorName.startsWith("Демо")).toBe(true);
      expect(venue.slug.startsWith("demo-zal-")).toBe(true);
      expect(venue.descriptionRu.startsWith("Демонстрационная карточка: такого зала нет")).toBe(true);
      expect(venue.descriptionUz.startsWith("Namoyish kartochkasi: bunday zal yoʻq")).toBe(true);
      expect(venue.addressRu).toContain("демо-адрес");
      expect(venue.addressUz).toContain("demo manzil");
    }
  });

  it("телефоны и СТИР — заведомо вымышленные, но проходят проверки формата", () => {
    for (const venue of DEMO_VENUES) {
      // Кода оператора 00 в Узбекистане нет
      expect(venue.phone).toMatch(/^\+99800000000\d$/);
      expect(isUzPhone(venue.phone)).toBe(true);
      expect(venue.stir).toMatch(/^00000000\d$/);
    }
    expect(new Set(DEMO_VENUES.map((v) => v.stir)).size).toBe(DEMO_VENUES.length);
  });

  it("контакт — не человек: «Демо-контакт», без Telegram", () => {
    for (const venue of DEMO_VENUES) {
      expect(demoContacts(venue)).toMatchObject({ contact_person: "Демо-контакт", phone: venue.phone });
      expect(demoContacts(venue)).not.toHaveProperty("telegram_username");
    }
  });
});

describe("демо-залы: как карточка из панели", () => {
  it("адрес, название и район — по правилам таблицы и справочника", () => {
    const slugs = DEMO_VENUES.map((v) => v.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const venue of DEMO_VENUES) {
      expect(venue.slug).toMatch(SLUG_RE);
      expect(charLength(venue.name)).toBeLessThanOrEqual(80);
      expect(DISTRICTS).toContain(venue.districtCode);
      for (const text of [venue.addressRu, venue.addressUz])
        expect(charLength(text)).toBeLessThanOrEqual(300);
      for (const text of [venue.descriptionRu, venue.descriptionUz]) {
        expect(charLength(text)).toBeLessThanOrEqual(4000);
      }
    }
  });

  it("цена «от» — цена будней; есть будни и выходные, единица цены совпадает", () => {
    for (const venue of DEMO_VENUES) {
      const kinds = venue.packages.map((p) => p.kind);
      expect(kinds).toContain("weekday");
      expect(kinds).toContain("weekend");
      expect(kinds.filter((k) => k !== "custom")).toHaveLength(
        new Set(kinds.filter((k) => k !== "custom")).size,
      );
      const weekday = venue.packages.find((p) => p.kind === "weekday");
      expect(venue.priceFromUzs).toBe(weekday?.priceUzs);
      expect(weekday?.priceUnit).toBe(venue.priceUnit);
      for (const pkg of venue.packages) {
        expect(pkg.priceUzs).toBeGreaterThan(0);
        expect(charLength(pkg.nameRu)).toBeLessThanOrEqual(80);
        expect(charLength(pkg.nameUz)).toBeLessThanOrEqual(80);
      }
    }
  });

  it("вместимость в пределах таблицы, минимум не больше максимума", () => {
    for (const venue of DEMO_VENUES) {
      expect(venue.capMin).toBeGreaterThanOrEqual(1);
      expect(venue.capMax).toBeGreaterThanOrEqual(venue.capMin);
      expect(venue.capMax).toBeLessThanOrEqual(5000);
    }
  });

  it("несколько занятых дней в ближайшие 60 дней, по возрастанию, без повторов", () => {
    for (const venue of DEMO_VENUES) {
      expect(venue.busyDays.length).toBeGreaterThanOrEqual(3);
      expect(venue.busyDays.length).toBeLessThanOrEqual(10);
      expect([...venue.busyDays].sort((a, b) => a - b)).toEqual(venue.busyDays);
      expect(new Set(venue.busyDays).size).toBe(venue.busyDays.length);
      for (const day of venue.busyDays) {
        expect(day).toBeGreaterThanOrEqual(1);
        expect(day).toBeLessThanOrEqual(DEMO_BUSY_HORIZON_DAYS);
      }
    }
  });

  it("фото: по три на зал — минимум для публикации", () => {
    expect(DEMO_PHOTOS_PER_VENUE).toBe(3);
    expect(DEMO_PHOTO_COUNT).toBe(DEMO_VENUES.length * 3);
  });
});

describe("демо-залы: тексты", () => {
  it("узбекский — латиница; апострофы только U+02BB и U+02BC, текст нормализован", () => {
    for (const venue of DEMO_VENUES) {
      for (const text of [...uzTexts(venue), ...venue.packages.map((p) => p.nameUz)]) {
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
