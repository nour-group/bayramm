// Избранное клиента на настоящем Postgres ролью bayramm_api: отметка и снятие,
// только опубликованные, лимит, слияние гостевого списка, карточки для гостя,
// выгрузка и удаление аккаунта. Правила базы подробно — pgTAP 18_favorites.
//
// Площадки — свои на прогон (случайные слаги); после тестов снимаются с публикации.

import { randomBytes, randomUUID } from "node:crypto";
import type { ListingCards } from "@bayramm/shared/api";
import type { Favorites } from "@bayramm/shared/api/me";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addHallBanquets,
  adminClient,
  bearer,
  call,
  cleanup,
  loginToken,
  newTelegramUser,
  tgIdHash,
} from "./helpers";

let admin: Client;
const run = randomBytes(3).toString("hex");
const vendor = randomUUID();
const consentText = randomUUID();
const listings = { a: randomUUID(), b: randomUUID(), c: randomUUID(), draft: randomUUID() };

async function createListing(id: string, name: string, publish: boolean): Promise<void> {
  await admin.query(
    `insert into app.listings (id, vendor_id, slug, category_code, name, district_code, address_ru, address_uz,
                               description_ru, description_uz, price_from_uzs, price_unit, cap_min, cap_max)
     values ($1, $2, $3, 'hall', $4, 'bektemir', 'Адрес', 'Manzil', 'Описание', 'Tavsif', 100000, 'per_guest',
             50, 300)`,
    [id, vendor, `fav-${run}-${name}`, `Fav ${run} ${name}`],
  );
  await admin.query(
    "insert into pii.listing_contacts (listing_id, public_phone) values ($1, '+998000000777')",
    [id],
  );
  await addHallBanquets(admin, id, 100_000);
  for (const n of [1, 2, 3]) {
    await admin.query(
      `insert into app.photos (listing_id, status, moderation, storage_key, mime, bytes, width, height, sha256,
                               sort, no_faces_ack)
       values ($1, 'ready', 'approved', $2, 'image/webp', 1000, 1200, 900, $3, $4, true)`,
      [id, `listings/${id}/${randomUUID()}.webp`, randomBytes(32), n],
    );
  }
  if (publish) {
    await admin.query("update app.listings set status = 'review' where id = $1", [id]);
    await admin.query("update app.listings set status = 'active' where id = $1", [id]);
  }
}

beforeAll(async () => {
  admin = await adminClient();
  await admin.query(
    `insert into app.consent_texts (id, purpose, version, locale, body)
     values ($1, 'vendor_contact', $2, 'ru', 'Тест: данные контактного лица')`,
    [consentText, 1_000_000 + Math.floor(Math.random() * 1_000_000_000)],
  );
  await admin.query(
    `insert into app.vendor_accounts (id, legal_form, contract_no, contract_signed_at, stir_verified_at,
                                      contacts_confirmed_at, pd_consent_signed_at, pd_consent_text_id)
     values ($1, 'ooo', $2, now(), now(), now(), now(), $3)`,
    [vendor, `F-${run}`, consentText],
  );
  await createListing(listings.a, "a", true);
  await createListing(listings.b, "b", true);
  await createListing(listings.c, "c", true);
  await createListing(listings.draft, "draft", false);
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
  await cleanup(admin);
  await admin.end();
});

const put = (token: string, id: string) => call(`/me/favorites/${id}`, { method: "PUT", ...bearer(token) });
const del = (token: string, id: string) =>
  call(`/me/favorites/${id}`, { method: "DELETE", ...bearer(token) });
const merge = (token: string, listingIds: unknown) =>
  call("/me/favorites", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ listingIds }),
  });

async function list(token: string): Promise<string[]> {
  const res = await call("/me/favorites", bearer(token));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return ((await res.json()) as Favorites).items.map((card) => card.id);
}

describe("избранное клиента", () => {
  it("без сессии — 401", async () => {
    expect((await call("/me/favorites")).status).toBe(401);
    expect((await call(`/me/favorites/${listings.a}`, { method: "PUT" })).status).toBe(401);
  });

  it("отметка и снятие: новые сверху, повтор безопасен, карточки как в каталоге", async () => {
    const token = await loginToken(newTelegramUser());
    expect(await list(token)).toEqual([]);
    expect((await put(token, listings.a)).status).toBe(204);
    expect((await put(token, listings.b)).status).toBe(204);
    expect((await put(token, listings.a)).status).toBe(204);
    expect(await list(token)).toEqual([listings.b, listings.a]);

    const res = await call("/me/favorites", bearer(token));
    const card = ((await res.json()) as Favorites).items[0];
    expect(card).toMatchObject({ id: listings.b, slug: `fav-${run}-b`, photoCount: 3, busyOnDate: null });

    expect((await del(token, listings.b)).status).toBe(204);
    expect((await del(token, listings.b)).status).toBe(204);
    expect(await list(token)).toEqual([listings.a]);
  });

  it("не опубликованную не отметить — 404; кривой id — 404", async () => {
    const token = await loginToken(newTelegramUser());
    expect((await put(token, listings.draft)).status).toBe(404);
    expect((await put(token, randomUUID())).status).toBe(404);
    expect((await put(token, "not-a-uuid")).status).toBe(404);
    expect(await list(token)).toEqual([]);
  });

  it("снятая с публикации площадка пропадает из списка без ошибок и возвращается с публикацией", async () => {
    const token = await loginToken(newTelegramUser());
    await put(token, listings.c);
    await put(token, listings.a);
    await admin.query("update app.listings set status = 'suspended', status_reason = 'тест' where id = $1", [
      listings.c,
    ]);
    try {
      expect(await list(token)).toEqual([listings.a]);
      const cards = await call(`/catalog/cards?ids=${listings.c},${listings.a}`);
      expect(((await cards.json()) as ListingCards).items.map((c) => c.id)).toEqual([listings.a]);
    } finally {
      await admin.query("update app.listings set status = 'active' where id = $1", [listings.c]);
    }
    expect(await list(token)).toEqual([listings.a, listings.c]);
  });

  it("чужие отметки не видны и не снимаются", async () => {
    const owner = await loginToken(newTelegramUser());
    const other = await loginToken(newTelegramUser());
    await put(owner, listings.a);
    expect(await list(other)).toEqual([]);
    expect((await del(other, listings.a)).status).toBe(204);
    expect(await list(owner)).toEqual([listings.a]);
  });

  it("слияние гостевого списка при входе: только опубликованные, без повторов", async () => {
    const token = await loginToken(newTelegramUser());
    await put(token, listings.b);
    const res = await merge(token, [listings.a, listings.draft, listings.b, randomUUID(), listings.a]);
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as Favorites).items.map((c) => c.id);
    expect(ids.sort()).toEqual([listings.a, listings.b].sort());
  });

  it("слияние: не массив, не UUID или больше 100 — 400", async () => {
    const token = await loginToken(newTelegramUser());
    for (const body of ["x", [42], ["nope"], Array.from({ length: 101 }, () => randomUUID())]) {
      expect((await merge(token, body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
  });

  it("выгрузка — с избранным; удаление аккаунта стирает его", async () => {
    const user = newTelegramUser();
    const token = await loginToken(user);
    await put(token, listings.a);
    const doc = (await (await call("/me/export", bearer(token))).json()) as {
      favorites: { listing: { id: string; slug: string | null }; savedAt: string }[];
    };
    expect(doc.favorites).toEqual([
      {
        listing: expect.objectContaining({ id: listings.a, slug: `fav-${run}-a` }),
        savedAt: expect.any(String),
      },
    ]);

    const count = async () =>
      (
        await admin.query(
          "select 1 from app.favorites f join app.clients c on c.id = f.client_id where c.tg_id_hash = $1",
          [tgIdHash(user.id)],
        )
      ).rowCount;
    expect(await count()).toBe(1);
    expect((await call("/me", { method: "DELETE", ...bearer(token) })).status).toBe(204);
    expect(await count()).toBe(0);
  });
});

describe("GET /catalog/cards — избранное гостя", () => {
  it("карточки опубликованных в порядке ids, без входа", async () => {
    const res = await call(
      `/catalog/cards?ids=${listings.b},${listings.draft},${randomUUID()},${listings.a}`,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as ListingCards).items.map((c) => c.id)).toEqual([listings.b, listings.a]);
  });

  it("без ids — пусто; кривые ids — 400", async () => {
    expect(((await (await call("/catalog/cards")).json()) as ListingCards).items).toEqual([]);
    expect((await call("/catalog/cards?ids=nope")).status).toBe(400);
    const many = Array.from({ length: 101 }, () => randomUUID()).join(",");
    expect((await call(`/catalog/cards?ids=${many}`)).status).toBe(400);
  });
});
