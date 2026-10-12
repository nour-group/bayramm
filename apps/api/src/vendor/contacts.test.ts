// Контакты витрины из кабинета без базы: какой путь выбирается по статусу витрины, кто может,
// что проверяется до базы. Правила базы (прямая запись закрыта на сайте, решение, журнал) — pgTAP
// (supabase/tests/29_vendor_photos_contacts.test.sql), на настоящей базе — test/integration/vendor.test.ts
import { describe, expect, it } from "vitest";
import type { VendorActor } from "../db/actor";
import { ApiError } from "../errors";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { parseContacts, saveContacts, withdrawContacts } from "./contacts";

const OWNER: VendorActor = {
  kind: "vendor_user",
  id: "aaaaaaaa-0000-0000-0000-000000000011",
  vendorId: "aaaaaaaa-0000-0000-0000-000000000001",
  role: "owner",
};
const MEMBER: VendorActor = { ...OWNER, role: "member" };
const LISTING_ID = "aaaaaaaa-0000-0000-0000-000000000101";

async function rejection(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("ожидался отказ");
}

interface World {
  /** null — чужая или нет такой */
  status: string | null;
  /** Нынешние контакты витрины (pii.read_listing_contacts) */
  contacts?: { phone: string | null; telegram: string | null };
  /** Что вернёт app.vendor_submit_contact_change: id запроса или null (значения те же) */
  submitted?: string | null;
}

function db(world: World) {
  return fakeDb((q: RecordedQuery) => {
    if (q.sql.includes("app.vendor_submit_contact_change")) return [{ id: world.submitted ?? null }];
    if (q.sql.includes("pii.read_listing_contacts"))
      return [world.contacts ?? { phone: "+998000000999", telegram: null }];
    if (q.sql.includes("app.contact_change_state")) return [];
    if (q.sql.includes('update "pii"."listing_contacts"')) return [{ listing_id: LISTING_ID }];
    if (q.sql.includes('from "app"."listings"') && world.status !== null)
      return [
        {
          id: LISTING_ID,
          slug: "hall",
          name: "Hall",
          status: world.status,
          status_reason: null,
          category_code: "hall",
          district_code: "yunusobod",
          address_ru: null,
          address_uz: null,
          description_ru: "Описание",
          description_uz: "Tavsif",
          price_from_uzs: "150000",
          price_unit: "per_guest",
          cap_min: 50,
          cap_max: 200,
          attributes: {},
          video_links: [],
          parallel_capacity: 1,
          blockers: [],
          review_blockers: [],
          min_photos: 3,
          max_photos: 10,
        },
      ];
    return [];
  });
}

const sqlOf = (fake: ReturnType<typeof db>) => fake.queries.map((q) => q.sql).join("\n");

describe("parseContacts", () => {
  it("телефон в любой записи → +998…, Telegram: @name, t.me/name, пусто — не нужен", () => {
    expect(parseContacts({ phone: "+998 00 123 45 67", telegram: "@lola_zali" })).toEqual({
      phone: "+998001234567",
      telegram: "lola_zali",
    });
    expect(parseContacts({ phone: "00 123 45 67", telegram: "https://t.me/lola_zali" })).toEqual({
      phone: "+998001234567",
      telegram: "lola_zali",
    });
    expect(parseContacts({ phone: "+998001234567" })).toEqual({ phone: "+998001234567", telegram: null });
    expect(parseContacts({ phone: "+998001234567", telegram: "" })).toEqual({
      phone: "+998001234567",
      telegram: null,
    });
    expect(parseContacts({ phone: "+998001234567", telegram: null }).telegram).toBeNull();
  });

  it("телефон обязателен и только Узбекистан; Telegram — по правилам: 422 invalid_input с именем поля", () => {
    const details = (body: unknown) => {
      try {
        parseContacts(body);
      } catch (err) {
        if (err instanceof ApiError) return [err.status, err.code, err.details];
      }
      return null;
    };
    expect(details({})).toEqual([422, "invalid_input", ["phone"]]);
    expect(details({ phone: null })).toEqual([422, "invalid_input", ["phone"]]);
    expect(details({ phone: "" })).toEqual([422, "invalid_input", ["phone"]]);
    expect(details({ phone: "+7 912 345 67 89" })).toEqual([422, "invalid_input", ["phone"]]);
    expect(details({ phone: "+998001234567", telegram: "ab" })).toEqual([422, "invalid_input", ["telegram"]]);
    expect(details({ phone: "+998001234567", telegram: "name_" })).toEqual([
      422,
      "invalid_input",
      ["telegram"],
    ]);
    expect(details({ phone: 998001234567 })).toEqual([422, "invalid_input", ["phone"]]);
    expect(details({ phone: "x", telegram: "y" })).toEqual([422, "invalid_input", ["phone", "telegram"]]);
  });

  it("тело не объект — 400", () => {
    for (const body of [null, "x", [], 42]) {
      expect(() => parseContacts(body)).toThrow(ApiError);
    }
  });
});

describe("PUT /vendor/listings/:id/contacts", () => {
  const next = { phone: "+998000000555", telegram: "lola_zali" };

  it("черновик, отклонённая, лид — сохраняется сразу: телефон, потом Telegram; запроса нет", async () => {
    for (const status of ["draft", "rejected", "lead"]) {
      const fake = db({ status });
      const result = await saveContacts(fake.db, OWNER, LISTING_ID, next, "staging");
      expect(result.sentForModeration, status).toBe(false);
      expect(result.listing.id).toBe(LISTING_ID);
      const updates = fake.queries.filter((q) => q.sql.startsWith('update "pii"."listing_contacts"'));
      expect(
        updates.map((q) => q.parameters[0]),
        status,
      ).toEqual(["+998000000555", "lola_zali"]);
      expect(sqlOf(fake), status).not.toContain("vendor_submit_contact_change");
      // Под актором партнёра, одной транзакцией
      expect(fake.log[0]).toBe("begin");
      expect(fake.log.at(-1)).toBe("commit");
      expect(fake.queries[0]?.parameters).toEqual(["vendor_user", OWNER.id, OWNER.vendorId]);
    }
  });

  it("на проверке, опубликована, приостановлена — запросом: контакты витрины не пишутся", async () => {
    for (const status of ["review", "active", "suspended"]) {
      const fake = db({ status, submitted: "c0c0c0c0-0000-4000-8000-000000000001" });
      const result = await saveContacts(fake.db, OWNER, LISTING_ID, next, "staging");
      expect(result.sentForModeration, status).toBe(true);
      const call = fake.queries.find((q) => q.sql.includes("app.vendor_submit_contact_change"));
      expect(call?.parameters, status).toEqual([LISTING_ID, "+998000000555", "lola_zali"]);
      expect(sqlOf(fake), status).not.toContain('update "pii"."listing_contacts"');
      expect(sqlOf(fake), status).not.toContain('insert into "pii"."listing_contacts"');
    }
  });

  it("Telegram можно убрать: у витрины на сайте — запросом с null", async () => {
    const fake = db({ status: "active", submitted: "c0c0c0c0-0000-4000-8000-000000000001" });
    await saveContacts(fake.db, OWNER, LISTING_ID, { phone: "+998000000999", telegram: null }, "staging");
    const call = fake.queries.find((q) => q.sql.includes("app.vendor_submit_contact_change"));
    expect(call?.parameters).toEqual([LISTING_ID, "+998000000999", null]);
  });

  it("значения те же, что сейчас, — 422 no_changes (и на сайте, и вне него); ничего не пишется", async () => {
    const same = db({ status: "active", submitted: null });
    const onSite = await rejection(() =>
      saveContacts(same.db, OWNER, LISTING_ID, { phone: "+998000000999", telegram: null }, "staging"),
    );
    expect([onSite.status, onSite.code]).toEqual([422, "no_changes"]);
    const draft = db({ status: "draft", contacts: { phone: "+998000000555", telegram: "lola_zali" } });
    const direct = await rejection(() => saveContacts(draft.db, OWNER, LISTING_ID, next, "staging"));
    expect([direct.status, direct.code]).toEqual([422, "no_changes"]);
    expect(sqlOf(draft)).not.toContain('update "pii"."listing_contacts"');
  });

  it("у витрины контактов ещё нет: телефон вписывается (UPDATE → INSERT), Telegram следом", async () => {
    const fake = fakeDb((q) => {
      if (q.sql.includes("pii.read_listing_contacts")) return [{ phone: null, telegram: null }];
      if (q.sql.includes('update "pii"."listing_contacts" set "public_phone"')) return [];
      if (q.sql.includes('update "pii"."listing_contacts" set "public_telegram"'))
        return [{ listing_id: LISTING_ID }];
      if (q.sql.includes('from "app"."listings"'))
        return [{ id: LISTING_ID, status: "draft", category_code: "hall" }];
      return [];
    });
    await saveContacts(fake.db, OWNER, LISTING_ID, next, "staging");
    const inserted = fake.queries.find((q) => q.sql.startsWith('insert into "pii"."listing_contacts"'));
    expect(inserted?.parameters).toEqual([LISTING_ID, "+998000000555"]);
  });

  it("сотрудник площадки — 403 vendor_owner_required до базы; чужая витрина — 404", async () => {
    const fake = db({ status: "draft" });
    const member = await rejection(() => saveContacts(fake.db, MEMBER, LISTING_ID, next, "staging"));
    expect([member.status, member.code]).toEqual([403, "vendor_owner_required"]);
    expect(fake.queries).toEqual([]);
    const missing = await rejection(() =>
      saveContacts(db({ status: null }).db, OWNER, LISTING_ID, next, "staging"),
    );
    expect(missing.status).toBe(404);
  });
});

describe("POST /vendor/listings/:id/contact-change/withdraw", () => {
  it("владелец отзывает ждущий запрос: функция базы, ответ — витрина", async () => {
    const fake = db({ status: "active" });
    const listing = await withdrawContacts(fake.db, OWNER, LISTING_ID, "staging");
    expect(listing.id).toBe(LISTING_ID);
    const call = fake.queries.find((q) => q.sql.includes("app.vendor_withdraw_contact_change"));
    expect(call?.parameters).toEqual([LISTING_ID]);
  });

  it("сотрудник площадки — 403 до базы; чужая — 404 без вызова функции", async () => {
    const fake = db({ status: "active" });
    const member = await rejection(() => withdrawContacts(fake.db, MEMBER, LISTING_ID, "staging"));
    expect([member.status, member.code]).toEqual([403, "vendor_owner_required"]);
    expect(fake.queries).toEqual([]);
    const other = db({ status: null });
    expect((await rejection(() => withdrawContacts(other.db, OWNER, LISTING_ID, "staging"))).status).toBe(
      404,
    );
    expect(sqlOf(other)).not.toContain("vendor_withdraw_contact_change");
  });
});
