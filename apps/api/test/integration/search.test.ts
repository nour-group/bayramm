// Поиск по каталогу на настоящем Postgres, ролью bayramm_api: GET /catalog/listings?q= вместе с
// фильтрами, порядком и курсором, GET /catalog/suggest. Нормализацию и правила совпадения
// проверяет pgTAP (32_catalog_search), без базы — src/catalog/search.test.ts.
//
// Данные — свои на каждый прогон: слово прогона в названиях (run) отделяет их от остальных;
// после тестов витрины снимаются с публикации.

import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { CatalogPage, CatalogSuggest } from "@bayramm/shared/api";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addHallBanquets, adminClient, call } from "./helpers";

let admin: Client;
// Слово прогона — одни буквы: цифры и буквы вперемешку похожи друг на друга сильнее
const run = `zq${Array.from(randomBytes(4), (b) => String.fromCharCode(97 + (b % 26))).join("")}`;
const vendor = randomUUID();
const consentText = randomUUID();

// Тойханы прогона в Учтепе: versal и oqsaroy — опубликованы, grand — с «oqsaroy» в описании,
// draft — не опубликована
const L = {
  versal: { name: `Versal ${run}`, description: "Банкетный зал", price: 120_000, publish: true },
  oqsaroy: { name: `Oqsaroy ${run}`, description: "Katta zal", price: 100_000, publish: true },
  grand: { name: `Grand ${run}`, description: "Рядом с Oqsaroy", price: 90_000, publish: true },
  draft: { name: `Versal Draft ${run}`, description: "Черновик", price: 80_000, publish: false },
} as const;
type Name = keyof typeof L;
const listings = Object.fromEntries(
  Object.entries(L).map(([name, l]) => [name, { ...l, id: randomUUID(), slug: `srch-${run}-${name}` }]),
) as Record<Name, (typeof L)[Name] & { id: string; slug: string }>;
const byId = new Map(Object.entries(listings).map(([name, l]) => [l.id, name as Name]));

beforeAll(async () => {
  admin = await adminClient();
  await admin.query(
    `insert into app.consent_texts (id, purpose, version, locale, body) values ($1, 'vendor_contact', $2, 'ru', 'Тест')`,
    [consentText, 2_000_000_000 + randomInt(0, 147_000_000)],
  );
  await admin.query(
    `insert into app.vendor_accounts (id, legal_form, contract_no, contract_signed_at, stir_verified_at,
                                      contacts_confirmed_at, pd_consent_signed_at, pd_consent_text_id)
     values ($1, 'ooo', $2, now(), now(), now(), now(), $3)`,
    [vendor, `S-${run}`, consentText],
  );
  for (const l of Object.values(listings)) {
    await admin.query(
      `insert into app.listings (id, vendor_id, slug, category_code, name, district_code, address_ru, address_uz,
                                 description_ru, description_uz, cap_min, cap_max)
       values ($1, $2, $3, 'hall', $4, 'uchtepa', 'Адрес', 'Manzil', $5, 'Tavsif', 50, 400)`,
      [l.id, vendor, l.slug, l.name, l.description],
    );
    await admin.query(
      "insert into pii.listing_contacts (listing_id, public_phone) values ($1, '+998000000777')",
      [l.id],
    );
    await addHallBanquets(admin, l.id, l.price);
    for (const n of [1, 2, 3]) {
      await admin.query(
        `insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256,
                                 sort, no_faces_ack)
         values ($1, 'ready', 'approved', $2, 'image/webp', 1000, 1200, 900, $3, $4, true)`,
        [l.id, `listings/${l.id}/${randomUUID()}.webp`, randomBytes(32), n],
      );
    }
    if (l.publish) {
      await admin.query("update app.listings set status = 'review' where id = $1", [l.id]);
      await admin.query("update app.listings set status = 'active' where id = $1", [l.id]);
    }
  }
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(
    "update app.listings set status = 'suspended', status_reason = 'integration test cleanup' where vendor_id = $1 and status = 'active'",
    [vendor],
  );
  await admin.query("update app.consent_texts set retired_at = now() where id = $1 and retired_at is null", [
    consentText,
  ]);
  await admin.end();
});

async function json<T>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

const url = (params: Record<string, string>) => `/catalog/listings?${new URLSearchParams(params)}`;

/** Площадки прогона в выдаче — по порядку */
async function found(params: Record<string, string>): Promise<Name[]> {
  const body = await json<CatalogPage>(await call(url({ limit: "50", ...params })), 200);
  return body.items.flatMap((item) => byId.get(item.id) ?? []);
}

describe("GET /catalog/listings?q", () => {
  it("находит опубликованные витрины прогона; черновика нет; total — сколько всего", async () => {
    const body = await json<CatalogPage>(await call(url({ q: run, category: "hall" })), 200);
    expect(body.items.map((i) => byId.get(i.id)).sort()).toEqual(["grand", "oqsaroy", "versal"]);
    expect(body.total).toBe(3);
    expect(body.items.every((i) => i.slug.startsWith(`srch-${run}-`))).toBe(true);
  });

  it("с опечаткой, кириллицей и другим апострофом", async () => {
    expect(await found({ q: `versl ${run}` })).toEqual(["versal"]);
    expect(await found({ q: `Версаль ${run}` })).toEqual(["versal"]);
    expect(await found({ q: `Oqsaroʻy ${run}` })).toEqual(["oqsaroy", "grand"]);
  });

  it("по похожести: название выше описания", async () => {
    expect(await found({ q: `oqsaroy ${run}` })).toEqual(["oqsaroy", "grand"]);
  });

  it("вместе с фильтрами: раздел, район, гости; чужой раздел и район — пусто", async () => {
    expect((await found({ q: run, category: "hall", district: "uchtepa", guests: "300" })).sort()).toEqual([
      "grand",
      "oqsaroy",
      "versal",
    ]);
    expect(await found({ q: run, category: "car" })).toEqual([]);
    expect(await found({ q: run, district: "sergeli", category: "all" })).toEqual([]);
    expect(await found({ q: run, guests: "500", category: "hall" })).toEqual([]);
  });

  it("порядок по цене с q — как без него", async () => {
    expect(await found({ q: run, sort: "price_asc" })).toEqual(["grand", "oqsaroy", "versal"]);
    expect(await found({ q: run, sort: "price_desc" })).toEqual(["versal", "oqsaroy", "grand"]);
  });

  it("курсор: страницы без повторов, total — только на первой; курсор другого запроса — 400", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const params: Record<string, string> = { q: run, limit: "1", ...(cursor ? { cursor } : {}) };
      const body: CatalogPage = await json<CatalogPage>(await call(url(params)), 200);
      if (page === 0) expect(body.total).toBe(3);
      else expect(body.total).toBeUndefined();
      seen.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.map((id) => byId.get(id)).sort()).toEqual(["grand", "oqsaroy", "versal"]);

    const first = await json<CatalogPage>(await call(url({ q: run, limit: "1" })), 200);
    const other = await call(url({ q: `versal ${run}`, limit: "1", cursor: first.nextCursor ?? "" }));
    expect(other.status).toBe(400);
  });

  it("ответ кэшируется, как выдача: публичный, одинаковый для всех", async () => {
    const res = await call(url({ q: run }));
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=30, s-maxage=30, stale-while-revalidate=60",
    );
  });

  it("запрос не попадает в текст SQL (pg_stat_statements) — только параметром", async () => {
    const secret = `${run}secret`;
    await json<CatalogPage>(await call(url({ q: secret })), 200);
    await json<CatalogSuggest>(await call(`/catalog/suggest?q=${secret}`), 200);
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from extensions.pg_stat_statements where query like $1",
      [`%${secret}%`],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe("GET /catalog/suggest", () => {
  it("витрины по похожести, до пяти, с обложкой", async () => {
    const body = await json<CatalogSuggest>(
      await call(`/catalog/suggest?q=${encodeURIComponent(`oqsaroy ${run}`)}`),
      200,
    );
    expect(body.listings.map((l) => byId.get(l.id))).toEqual(["oqsaroy", "grand"]);
    expect(body.listings[0]).toMatchObject({
      slug: listings.oqsaroy.slug,
      name: listings.oqsaroy.name,
      categoryCode: "hall",
      districtCode: "uchtepa",
      cover: { width: 1200, height: 900 },
    });
    expect(body.listings.length).toBeLessThanOrEqual(5);
  });

  it("район кириллицей — «Учтепа — тойханы» с числом витрин; раздел по названию", async () => {
    const district = await json<CatalogSuggest>(
      await call(`/catalog/suggest?q=${encodeURIComponent("Учтепа")}`),
      200,
    );
    const row = district.districts.find((d) => d.code === "uchtepa" && d.category === "hall");
    expect(row?.listings).toBeGreaterThanOrEqual(3);
    expect(row?.name).toEqual({ ru: "Учтепа", uz: "Uchtepa" });

    const category = await json<CatalogSuggest>(
      await call(`/catalog/suggest?q=${encodeURIComponent("тойхона")}`),
      200,
    );
    expect(category.categories[0]).toMatchObject({ code: "hall" });
    expect(category.categories[0]?.listings).toBeGreaterThanOrEqual(3);
  });
});
