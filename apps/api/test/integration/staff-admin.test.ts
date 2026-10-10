// Панель оператора на настоящем Postgres ролью bayramm_api: вендоры, чек-лист,
// пользователи кабинета, карточки и их статусы, фото, занятость, заявки, права
// ролей, журнал действий (пишет база) и журнал доступа к ПДн.
//
// Данные — со случайными названиями, СТИР и телефонами: тесты можно гонять
// повторно на одной базе. Вендоров и карточки не удаляем — у них история в
// журналах только на добавление.

import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { webpFixture } from "@bayramm/media/testing";
import { trimTrailingSlashes } from "@bayramm/shared";
import type { ListingService } from "@bayramm/shared/api/services";
import type {
  Availability,
  ContactMetrics,
  ListingDetail,
  ListingList,
  ListingSaveResult,
  PiiAccessList,
  RevealedListingContacts,
  RevisionList,
  StaffDictionaries,
  StaffMe,
  StaffPhoto,
  StaffRequestDetail,
  StaffRequestList,
  VendorDetail,
  VendorList,
  VendorUser,
} from "@bayramm/shared/api/staff";
import { type Client, Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import {
  adminClient,
  apiDatabaseUrl,
  ID_HASH_KEY,
  inviteStaff,
  makeEnv,
  newStaffUsername,
  staffLoginToken,
} from "./helpers";

const STORAGE_URL = trimTrailingSlashes(process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:54321");
const SERVICE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? "";

// Принятое сразу приглашение отправляет «вас добавили» сразу (kickOutbox) — не в настоящий Telegram
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input instanceof Request ? input.url : input).startsWith("https://api.telegram.org/")) {
    throw new TypeError("Telegram is offline in tests");
  }
  return realFetch(input, init);
});

let admin: Client;
const tokens = { admin: "", manager: "", moderator: "" };
type Who = keyof typeof tokens;

async function staffToken(role: Who): Promise<string> {
  const username = newStaffUsername();
  await inviteStaff(admin, { username, role, displayName: `Test ${role}` });
  return staffLoginToken(username);
}

/** Запрос к API от имени сотрудника; env — с ключом Storage, если он есть */
async function api(
  who: Who,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${tokens[who]}`, ...headers } };
  if (body instanceof Uint8Array) init.body = body as Uint8Array<ArrayBuffer>;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const env = { ...makeEnv(), SUPABASE_URL: STORAGE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY || "unset" };
  const res = await app.request(path, init, env, ctx);
  await Promise.all(pending);
  return res;
}

async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  if (r.status !== status) throw new Error(`ожидался ${status}, пришёл ${r.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function error(res: Response | Promise<Response>) {
  const r = await res;
  const body = (await r.json()) as { error: { code: string; details?: string[] } };
  return { status: r.status, code: body.error.code, details: body.error.details };
}

/** Сегодня по Ташкенту + n дней */
const day = (n: number) => {
  const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  return new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
};
const digits = (n: number) => Array.from({ length: n }, () => randomInt(0, 10)).join("");
const phone = () => `+99890${digits(7)}`;
const tag = randomBytes(3).toString("hex");

beforeAll(async () => {
  admin = await adminClient();
  tokens.admin = await staffToken("admin");
  tokens.manager = await staffToken("manager");
  tokens.moderator = await staffToken("moderator");
});

afterAll(async () => {
  await admin?.end();
});

describe("GET /staff/me и справочники", () => {
  it("права по роли — для панели", async () => {
    const me = await ok<StaffMe>(api("moderator", "GET", "/staff/me"));
    expect(me.role).toBe("moderator");
    expect(me.permissions).toContain("listings.publish");
    expect(me.permissions).not.toContain("vendors.write");
    expect(me.permissions).not.toContain("requests.read");
    // Пишет ли бот сотруднику: от этого зависят оповещения команды (баннер в панели)
    expect(typeof me.botLinked).toBe("boolean");
    const manager = await ok<StaffMe>(api("manager", "GET", "/staff/me"));
    expect(manager.permissions).toContain("vendors.write");
    expect(manager.permissions).not.toContain("listings.publish");
  });

  it("справочники: районы, категории, сотрудники, минимум фото", async () => {
    const dict = await ok<StaffDictionaries>(api("manager", "GET", "/staff/dictionaries"));
    expect(dict.districts).toHaveLength(12);
    expect(dict.categories.filter((c) => c.enabled).map((c) => c.code)).toEqual([
      "zags",
      "hall",
      "car",
      "photo",
      "studio",
      "restaurant",
      "flowers",
      "attire",
      "gifts",
      "food",
      "cake",
      "decor",
    ]);
    expect(dict.settings.minPhotos).toBeGreaterThanOrEqual(3);
    expect(dict.staff.some((s) => s.displayName === "Test manager")).toBe(true);
  });
});

describe("вендор → карточка → проверка → публикация", () => {
  const stir = digits(9);
  const contactPhone = phone();
  const userPhone = phone();
  let vendor: VendorDetail;
  let listing: ListingDetail;

  it("модератор вендора не заводит (403), менеджер — да; телефон только пишется", async () => {
    expect((await api("moderator", "POST", "/staff/vendors", { name: `Mod ${tag}` })).status).toBe(403);
    vendor = await ok<VendorDetail>(
      api("manager", "POST", "/staff/vendors", {
        name: `Oqsaroy ${tag}`,
        legalForm: "ooo",
        legalName: `OOO Oqsaroy ${tag}`,
        contactPerson: "Test Person",
        phone: contactPhone.replace(/(\d{2})(\d{3})(\d{2})(\d{2})$/, " $1 $2-$3-$4"),
        telegramUsername: "@test_person",
      }),
      201,
    );
    expect(vendor.code).toMatch(/^V\d+$/);
    expect(vendor.contacts).toMatchObject({
      legalName: `OOO Oqsaroy ${tag}`,
      telegramUsername: "test_person",
    });
    expect(JSON.stringify(vendor)).not.toContain(contactPhone.slice(4));
  });

  it("ошибки ввода — списком полей", async () => {
    expect(
      await error(api("manager", "POST", "/staff/vendors", { name: "x", stir: "12", phone: "+7 912 000" })),
    ).toEqual({ status: 422, code: "invalid_input", details: ["name", "stir", "phone"] });
  });

  it("поиск по названию, СТИР и телефону пользователя кабинета", async () => {
    await ok(api("manager", "PATCH", `/staff/vendors/${vendor.id}`, { stir }));
    const user = await ok<VendorUser>(
      api("manager", "POST", `/staff/vendors/${vendor.id}/users`, { phone: userPhone, fullName: "Owner" }),
      201,
    );
    // Без роли — владелец (так заводили до приглашений); номер ещё никто не подтвердил
    expect(user).toMatchObject({
      telegramLinked: false,
      role: "owner",
      status: "pending",
      notifiable: false,
      disabledAt: null,
    });

    for (const q of [`oqsaroy ${tag}`, stir, userPhone, vendor.code]) {
      const list = await ok<VendorList>(api("moderator", "GET", `/staff/vendors?q=${encodeURIComponent(q)}`));
      expect(
        list.items.map((v) => v.id),
        q,
      ).toContain(vendor.id);
    }
    const miss = await ok<VendorList>(api("manager", "GET", `/staff/vendors?q=${digits(9)}`));
    expect(miss.items.map((v) => v.id)).not.toContain(vendor.id);
  });

  it("пользователь кабинета: псевдоним телефона — HMAC(ID_HASH_KEY, +998…); повтор номера — 409", async () => {
    const { rows } = await admin.query<{ phone_hash: Buffer }>(
      "select phone_hash from app.vendor_users where vendor_id = $1",
      [vendor.id],
    );
    expect(rows[0]?.phone_hash).toEqual(createHmac("sha256", ID_HASH_KEY).update(userPhone).digest());
    expect(
      await error(api("manager", "POST", `/staff/vendors/${vendor.id}/users`, { phone: userPhone })),
    ).toMatchObject({ status: 409, code: "phone_taken" });
  });

  it("телефоны — только через «показать», чтение — в журнале доступа к ПДн", async () => {
    const phones = await ok<{ phone: string }>(
      api("moderator", "POST", `/staff/vendors/${vendor.id}/phones`, { reason: "проверка" }),
    );
    expect(phones.phone).toBe(contactPhone);
    const { rows } = await admin.query(
      "select actor_kind, purpose, reason from app.pii_access_log where subject_id = $1",
      [vendor.id],
    );
    expect(rows).toEqual([{ actor_kind: "staff", purpose: "staff_vendor_contact", reason: "проверка" }]);
  });

  it("карточка: адрес из названия, телефон, банкеты — услугами; модератор не создаёт", async () => {
    const input = {
      vendorId: vendor.id,
      name: `Тойхона «Хумо» ${tag}`,
      districtCode: "chilonzor",
      capMin: 50,
      capMax: 300,
      descriptionRu: "Зал на 300 гостей",
      descriptionUz: "300 mehmonga zal",
      phone: phone(),
    };
    expect((await api("moderator", "POST", "/staff/listings", input)).status).toBe(403);
    listing = await ok<ListingDetail>(api("manager", "POST", "/staff/listings", input), 201);
    expect(listing).toMatchObject({
      status: "draft",
      hasPhone: true,
      categoryCode: "hall",
      priceFromUzs: null,
    });
    expect(listing.slug).toBe(`toyxona-xumo-${tag}`);
    expect(listing).not.toHaveProperty("packages");
    // Цены — только услугами: от менеджера — на проверку, одобрит публикация
    for (const [type, priceUzs] of [
      ["banquet_weekday", 150_000],
      ["banquet_weekend", 180_000],
    ] as const) {
      await ok(
        api("manager", "POST", `/staff/listings/${listing.id}/services`, {
          type,
          priceUzs,
          priceUnit: "per_guest",
        }),
        201,
      );
    }
    listing = await ok<ListingDetail>(api("manager", "GET", `/staff/listings/${listing.id}`));
    expect(listing.services.map((s) => [s.type, s.status])).toEqual([
      ["banquet_weekday", "review"],
      ["banquet_weekend", "review"],
    ]);
    // Цена «от» — из услуг (до публикации — и из отправленных на проверку), не из тела
    expect(listing.priceFromUzs).toBe(150_000);
    expect(listing.blockers.review).toEqual(["photos"]);
    expect(listing.blockers.active).toEqual([
      "price",
      "packages",
      "photos",
      "contract",
      "stir",
      "contacts",
      "pd_consent",
    ]);
    expect(listing.history).toMatchObject([{ from: null, to: "draft", actorKind: "staff" }]);
  });

  it("правка по устаревшей версии — 409 version_conflict", async () => {
    const edited = await ok<ListingDetail>(
      api("manager", "PATCH", `/staff/listings/${listing.id}`, { version: listing.version, capMax: 320 }),
    );
    expect(edited.version).toBe(listing.version + 1);
    expect(
      await error(
        api("manager", "PATCH", `/staff/listings/${listing.id}`, { version: listing.version, capMax: 1 }),
      ),
    ).toMatchObject({ status: 409, code: "version_conflict" });
    listing = edited;
  });

  it("Telegram для клиентов — рядом с телефоном: @ и ссылка t.me понимаются, показ — вместе с номером", async () => {
    expect(
      await error(
        api("manager", "PATCH", `/staff/listings/${listing.id}`, {
          version: listing.version,
          telegram: "not a name",
        }),
      ),
    ).toMatchObject({ status: 422, code: "invalid_input", details: ["telegram"] });
    listing = await ok<ListingDetail>(
      api("manager", "PATCH", `/staff/listings/${listing.id}`, {
        version: listing.version,
        telegram: "https://t.me/humo_hall",
      }),
    );
    expect(listing).toMatchObject({ hasPhone: true, hasTelegram: true });
    const contacts = await ok<RevealedListingContacts>(
      api("admin", "POST", `/staff/listings/${listing.id}/phone`, { reason: "проверка" }),
    );
    expect(contacts.telegram).toBe("humo_hall");
    expect(contacts.phone).toMatch(/^\+998\d{9}$/);
  });

  it("контакты витрин в метриках: только числа; неверный период — 422", async () => {
    const body = await ok<ContactMetrics>(api("moderator", "GET", "/staff/metrics/contacts?days=30"));
    expect(body).toMatchObject({ days: 30, category: null });
    expect(Array.isArray(body.items)).toBe(true);
    expect(await error(api("moderator", "GET", "/staff/metrics/contacts?days=0"))).toMatchObject({
      status: 422,
      details: ["days"],
    });
  });

  it("без фото на проверку не уйти: 422 publish_blocked со списком", async () => {
    expect(
      await error(
        api("manager", "POST", `/staff/listings/${listing.id}/submit`, { version: listing.version }),
      ),
    ).toEqual({ status: 422, code: "publish_blocked", details: ["photos"] });
  });

  it("фото: загрузка, порядок, обложка", async () => {
    if (!SERVICE_KEY) {
      // Без Storage — готовые фото прямо в базу (как их оставил бы сервер)
      for (let n = 0; n < 3; n++) {
        await admin.query(
          `insert into app.photos (listing_id, status, storage_key, mime, bytes, width, height, sha256, sort, no_faces_ack)
           values ($1, 'ready', $2, 'image/webp', 1000, 1600, 1200, $3, $4, true)`,
          [listing.id, `listings/${listing.id}/${randomUUID()}.webp`, randomBytes(32), n],
        );
      }
    } else {
      // Без подтверждения «лиц нет» фото не принимается
      const res = await api(
        "manager",
        "POST",
        `/staff/listings/${listing.id}/photos`,
        webpFixture({ width: 640, height: 480 }),
      );
      expect(await error(res)).toMatchObject({ status: 422, code: "no_faces_ack_required" });
      for (let n = 0; n < 3; n++) {
        await ok<StaffPhoto>(
          api(
            "manager",
            "POST",
            `/staff/listings/${listing.id}/photos`,
            webpFixture({ width: 640 + n, height: 480 }),
            { "content-type": "image/webp", "X-No-Faces": "1" },
          ),
          201,
        );
      }
    }
    const photos = await ok<StaffPhoto[]>(api("moderator", "GET", `/staff/listings/${listing.id}/photos`));
    expect(photos).toHaveLength(3);
    expect(photos.every((p) => p.moderation === "pending")).toBe(true);

    const reversed = photos.map((p) => p.id).reverse();
    const ordered = await ok<StaffPhoto[]>(
      api("manager", "PUT", `/staff/listings/${listing.id}/photos/order`, { ids: reversed }),
    );
    expect(ordered.map((p) => p.id)).toEqual(reversed);
    expect(
      await error(
        api("manager", "PUT", `/staff/listings/${listing.id}/photos/order`, { ids: reversed.slice(1) }),
      ),
    ).toMatchObject({ status: 422, details: ["ids"] });

    const last = reversed[2] as string;
    const covered = await ok<StaffPhoto[]>(
      api("manager", "POST", `/staff/listings/${listing.id}/photos/${last}/cover`),
    );
    expect(covered[0]).toMatchObject({ id: last, isCover: true });
    expect(covered.filter((p) => p.isCover)).toHaveLength(1);
  });

  it("на проверку — менеджер; публиковать менеджер не может", async () => {
    listing = await ok<ListingDetail>(api("manager", "GET", `/staff/listings/${listing.id}`));
    listing = await ok<ListingDetail>(
      api("manager", "POST", `/staff/listings/${listing.id}/submit`, {
        version: listing.version,
        reason: "готово",
      }),
    );
    expect(listing.status).toBe("review");
    expect(listing.history[0]).toMatchObject({ from: "draft", to: "review", reason: "готово" });
    expect(
      (await api("manager", "POST", `/staff/listings/${listing.id}/publish`, { version: listing.version }))
        .status,
    ).toBe(403);
    const queue = await ok<ListingList>(api("moderator", "GET", "/staff/listings?status=review"));
    expect(queue.items.map((l) => l.id)).toContain(listing.id);
    expect(queue.counts.review).toBeGreaterThanOrEqual(1);
  });

  it("непроверенный вендор не публикуется: блокеры чек-листа", async () => {
    expect(
      await error(
        api("moderator", "POST", `/staff/listings/${listing.id}/publish`, { version: listing.version }),
      ),
    ).toEqual({
      status: 422,
      code: "publish_blocked",
      details: ["contract", "stir", "contacts", "pd_consent"],
    });
  });

  it("чек-лист: отметки с автором; согласие — только по действующему тексту", async () => {
    for (const item of ["contract", "stir", "contacts"]) {
      vendor = await ok<VendorDetail>(
        api("manager", "POST", `/staff/vendors/${vendor.id}/checklist`, { item, done: true }),
      );
    }
    expect(vendor.checklist.stir).toMatchObject({ done: true, by: "Test manager" });

    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from app.consent_texts where purpose = 'vendor_contact'
        and published_at <= now() and (retired_at is null or retired_at > now())`,
    );
    if (rows[0]?.n === 0) {
      expect(
        await error(
          api("manager", "POST", `/staff/vendors/${vendor.id}/checklist`, { item: "pdConsent", done: true }),
        ),
      ).toMatchObject({ status: 409, code: "consent_text_missing" });
      await admin.query(
        `insert into app.consent_texts (purpose, version, locale, body)
         values ('vendor_contact', 900 + $1::int, 'ru', 'Тестовый текст согласия')`,
        [randomInt(0, 99)],
      );
    }
    vendor = await ok<VendorDetail>(
      api("manager", "POST", `/staff/vendors/${vendor.id}/checklist`, { item: "pdConsent", done: true }),
    );
    expect(Object.values(vendor.checklist).every((mark) => mark.done)).toBe(true);
  });

  it("публикует модератор: фото и услуги одобряются, карточка в каталоге", async () => {
    listing = await ok<ListingDetail>(
      api("moderator", "POST", `/staff/listings/${listing.id}/publish`, { version: listing.version }),
    );
    expect(listing.status).toBe("active");
    expect(listing.publishedAt).not.toBeNull();
    expect(listing.photos.every((p) => p.moderation === "approved")).toBe(true);
    expect(listing.services.every((s) => s.status === "active")).toBe(true);
    expect(listing.blockers.active).toEqual([]);
  });

  it("опубликованную карточку менеджер меняет правкой: описание — на модерацию, адрес — сразу, цена — предложением услуги", async () => {
    const saved = await ok<ListingSaveResult>(
      api("manager", "PATCH", `/staff/listings/${listing.id}`, {
        version: listing.version,
        // Полей цены у карточки больше нет: неизвестное поле тело не меняет
        priceFromUzs: 1,
        descriptionRu: "Зал на 300 гостей, своя кухня",
        addressRu: "Чиланзар, 7-й квартал",
      }),
    );
    expect(saved.sentForModeration).toEqual(["descriptionRu"]);
    // Клиенты видят прежнюю цену и описание, пока не решит модератор
    expect(saved).toMatchObject({
      priceFromUzs: 150_000,
      descriptionRu: "Зал на 300 гостей",
      addressRu: "Чиланзар, 7-й квартал",
    });
    expect(saved.pendingRevision).toMatchObject({
      fields: ["descriptionRu"],
      proposedBy: { kind: "staff", name: "Test manager" },
    });
    listing = saved;
    // Цена будней — предложением правки услуги: до решения клиенты видят прежнюю
    const weekday = listing.services.find((s) => s.type === "banquet_weekday");
    const proposed = await ok<ListingService>(
      api("manager", "PATCH", `/staff/listings/${listing.id}/services/${weekday?.id}`, { priceUzs: 170_000 }),
    );
    expect(proposed).toMatchObject({
      status: "active",
      priceUzs: 150_000,
      proposal: { changes: { priceUzs: 170_000 } },
    });

    // Пока правка ждёт — следующая правка модерируемых полей: 409 revision_pending, ничего не сохранено
    expect(
      await error(
        api("manager", "PATCH", `/staff/listings/${listing.id}`, {
          version: listing.version,
          name: `Хумо ${tag}`,
          capMax: 310,
        }),
      ),
    ).toMatchObject({ status: 409, code: "revision_pending" });
    // Очистить модерируемое поле опубликованной карточки нельзя
    expect(
      await error(
        api("manager", "PATCH", `/staff/listings/${listing.id}`, {
          version: listing.version,
          descriptionUz: null,
        }),
      ),
    ).toMatchObject({ status: 422, details: ["descriptionUz"] });

    const queue = await ok<RevisionList>(
      api("moderator", "GET", "/staff/revisions?status=pending&limit=100"),
    );
    const item = queue.items.find((r) => r.id === saved.pendingRevision?.id);
    expect(item?.proposedBy).toEqual({ kind: "staff", name: "Test manager" });

    // Решает модератор — правка применяется к карточке, предложение — к услуге
    await ok(api("moderator", "POST", `/staff/revisions/${saved.pendingRevision?.id}/approve`));
    await ok(api("moderator", "POST", `/staff/services/${weekday?.id}/approve`));
    listing = await ok<ListingDetail>(api("manager", "GET", `/staff/listings/${listing.id}`));
    expect(listing).toMatchObject({
      priceFromUzs: 170_000,
      descriptionRu: "Зал на 300 гостей, своя кухня",
      pendingRevision: null,
    });

    // Администратор решает сам — правит сразу
    const direct = await ok<ListingSaveResult>(
      api("admin", "PATCH", `/staff/listings/${listing.id}`, {
        version: listing.version,
        descriptionUz: "300 mehmonga zal, oshxona bor",
      }),
    );
    expect(direct.sentForModeration).toEqual([]);
    expect(direct.descriptionUz).toBe("300 mehmonga zal, oshxona bor");
    listing = direct;
  });

  it("база не даёт менеджеру обойти модерацию и в обход API", async () => {
    const managerId = await inviteStaff(admin, { username: newStaffUsername(), role: "manager" });
    const client = new PgClient({ connectionString: apiDatabaseUrl });
    await client.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.actor_kind', 'staff', true), set_config('app.actor_id', $1, true)",
        [managerId],
      );
      await client.query("savepoint services");
      await expect(
        client.query("update app.listing_services set price_uzs = 1 where listing_id = $1", [listing.id]),
      ).rejects.toMatchObject({ code: "BR005" });
      await client.query("rollback to savepoint services");
      await expect(
        client.query("update app.listings set description_ru = 'x' where id = $1", [listing.id]),
      ).rejects.toMatchObject({ code: "BR005" });
    } finally {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
  });

  it("новые фото опубликованной карточки — в очереди «Новые фото», пока модератор не решит", async () => {
    const photoId = randomUUID();
    await admin.query(
      `insert into app.photos (id, listing_id, status, storage_key, mime, bytes, width, height, sha256, sort, no_faces_ack)
       values ($1, $2, 'ready', $3, 'image/webp', 1000, 1600, 1200, $4, 9, true)`,
      [photoId, listing.id, `listings/${listing.id}/${randomUUID()}.webp`, randomBytes(32)],
    );
    const queue = await ok<ListingList>(api("moderator", "GET", "/staff/listings?photos=pending&limit=100"));
    const item = queue.items.find((l) => l.id === listing.id);
    expect(item?.photos.pending).toBe(1);
    // Любые витрины, кроме отклонённых: фото черновика тоже можно одобрить до публикации
    expect(queue.items.every((l) => l.status !== "rejected" && l.photos.pending > 0)).toBe(true);

    // Отказ без причины — нет: партнёр должен знать, что переснять
    expect(
      await error(
        api("moderator", "POST", `/staff/listings/${listing.id}/photos/${photoId}/moderation`, {
          decision: "declined",
        }),
      ),
    ).toMatchObject({ status: 422, details: ["reason"] });
    const photos = await ok<StaffPhoto[]>(
      api("moderator", "POST", `/staff/listings/${listing.id}/photos/${photoId}/moderation`, {
        decision: "declined",
        reason: "  Размыто — нужен кадр при свете  ",
      }),
    );
    expect(photos.find((p) => p.id === photoId)?.declineReason).toBe("Размыто — нужен кадр при свете");
    const after = await ok<ListingList>(api("moderator", "GET", "/staff/listings?photos=pending&limit=100"));
    expect(after.items.map((l) => l.id)).not.toContain(listing.id);
    // Одобрили — причины нет
    const approved = await ok<StaffPhoto[]>(
      api("moderator", "POST", `/staff/listings/${listing.id}/photos/${photoId}/moderation`, {
        decision: "approved",
      }),
    );
    expect(approved.find((p) => p.id === photoId)?.declineReason).toBeNull();
  });

  it("снять отметку чек-листа нельзя, пока карточка опубликована", async () => {
    expect(
      await error(
        api("manager", "POST", `/staff/vendors/${vendor.id}/checklist`, { item: "contract", done: false }),
      ),
    ).toMatchObject({ status: 409, code: "checklist_locked" });
  });

  it("приостановка — только с причиной; причина — в истории", async () => {
    expect(
      await error(
        api("moderator", "POST", `/staff/listings/${listing.id}/suspend`, { version: listing.version }),
      ),
    ).toMatchObject({ status: 422, details: ["reason"] });
    listing = await ok<ListingDetail>(
      api("moderator", "POST", `/staff/listings/${listing.id}/suspend`, {
        version: listing.version,
        reason: "Ремонт",
      }),
    );
    expect(listing).toMatchObject({ status: "suspended", statusReason: "Ремонт" });
    expect(listing.history[0]).toMatchObject({ from: "active", to: "suspended", reason: "Ремонт" });
    expect(
      await error(
        api("moderator", "POST", `/staff/listings/${listing.id}/submit`, { version: listing.version }),
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await error(
        api("manager", "POST", `/staff/listings/${listing.id}/submit`, { version: listing.version }),
      ),
    ).toMatchObject({ status: 409, code: "illegal_transition" });
  });

  it("журнал действий пишет база: кто и какие поля, без телефонов", async () => {
    const { rows } = await admin.query<{ action: string; detail: Record<string, unknown>; row: string }>(
      `select action, detail, to_jsonb(a)::text as row from app.audit_log a
        where object_type = 'listing' and object_id = $1 order by id`,
      [listing.id],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("listing.create");
    // Пакеты панели v0.1 — услуги зала
    expect(actions).toContain("listing_service.create");
    expect(actions).toContain("listing_contact.create");
    expect(
      rows.filter((r) => r.action === "listing.update" && (r.detail.to as string) === "suspended"),
    ).toHaveLength(1);
    expect(rows.map((r) => r.row).join()).not.toContain("+99890");
  });

  it("занятость: отметить и снять дни — от версии календаря", async () => {
    const url = `/staff/listings/${listing.id}/availability`;
    const [d1, d2] = [day(200), day(201)];
    const start = await ok<Availability>(api("moderator", "GET", `${url}?from=${d1}&to=${d2}`));
    expect(start.busy).toEqual([]);
    const busy = await ok<Availability>(
      api("manager", "PUT", url, { version: start.version, busy: [d1, d2] }),
    );
    expect(busy.busy).toEqual([
      { day: d1, source: "staff" },
      { day: d2, source: "staff" },
    ]);
    expect(busy.version).toBeGreaterThan(start.version);
    const freed = await ok<Availability>(api("manager", "PUT", url, { version: busy.version, free: [d1] }));
    const month = await ok<Availability>(api("moderator", "GET", `${url}?from=${d1}&to=${d2}`));
    expect(month.busy).toEqual([{ day: d2, source: "staff" }]);
    expect(month.version).toBe(freed.version);
    expect(
      await error(api("manager", "PUT", url, { version: month.version, busy: ["2027-02-30"] })),
    ).toMatchObject({ status: 422, details: ["busy"] });
    expect(await error(api("manager", "PUT", url, { busy: [d1] }))).toMatchObject({
      status: 422,
      details: ["version"],
    });
    expect((await api("moderator", "PUT", url, { version: month.version, busy: [] })).status).toBe(403);
  });

  it("занятость: устаревшая версия — 409 calendar_conflict; прошедший день — 422", async () => {
    const url = `/staff/listings/${listing.id}/availability`;
    const seen = await ok<Availability>(api("manager", "GET", url));
    // Тем временем календарь поменялся (отметка вендора, другой сотрудник)
    await admin.query("insert into app.availability (listing_id, day, source) values ($1, $2, 'vendor')", [
      listing.id,
      day(210),
    ]);
    expect(
      await error(api("manager", "PUT", url, { version: seen.version, busy: [day(211)] })),
    ).toMatchObject({
      status: 409,
      code: "calendar_conflict",
    });
    const fresh = await ok<Availability>(api("manager", "GET", url));
    expect(
      await error(api("manager", "PUT", url, { version: fresh.version, busy: [day(-1)], free: [day(-2)] })),
    ).toEqual({ status: 422, code: "date_out_of_range", details: ["busy", "free"] });
    await ok(api("manager", "PUT", url, { version: fresh.version, busy: [day(0)] }));
  });

  it("отключение пользователя кабинета и снятие привязки Telegram", async () => {
    const [user] = vendor.users;
    // Как после привязки ботом: хэш Telegram ID и время — вместе
    await admin.query("update app.vendor_users set tg_user_hash = $1, tg_linked_at = now() where id = $2", [
      randomBytes(32),
      user?.id,
    ]);
    const linked = await ok<VendorDetail>(api("moderator", "GET", `/staff/vendors/${vendor.id}`));
    // Привязан, но бот не знает его чат — уведомления не доходят, панель говорит это отдельно
    expect(linked.users[0]).toMatchObject({ telegramLinked: true, status: "accepted", notifiable: false });
    expect(JSON.stringify(linked)).not.toMatch(/tg_user_hash|telegram_user_id/);
    expect(
      await error(
        api("manager", "PATCH", `/staff/vendors/${vendor.id}/users/${user?.id}`, { phone: phone() }),
      ),
    ).toMatchObject({ status: 409, code: "user_linked" });
    const unlinked = await ok<VendorUser>(
      api("manager", "POST", `/staff/vendors/${vendor.id}/users/${user?.id}/unlink`),
    );
    expect(unlinked).toMatchObject({ telegramLinked: false, status: "pending" });

    const disabled = await ok<VendorUser>(
      api("manager", "POST", `/staff/vendors/${vendor.id}/users/${user?.id}/disable`),
    );
    expect(disabled.disabledAt).not.toBeNull();
    expect(disabled.status).toBe("disabled");
    const enabled = await ok<VendorUser>(
      api("manager", "POST", `/staff/vendors/${vendor.id}/users/${user?.id}/enable`),
    );
    expect(enabled.disabledAt).toBeNull();
  });

  describe("заявки", () => {
    let requestId = "";
    const clientPhone = phone();

    beforeAll(async () => {
      // Опубликовать снова и завести заявку, как её создаст клиентское приложение
      listing = await ok<ListingDetail>(
        api("moderator", "POST", `/staff/listings/${listing.id}/publish`, { version: listing.version }),
      );
      const client = randomUUID();
      const text = randomUUID();
      const consent = randomUUID();
      await admin.query("insert into app.clients (id, tg_id_hash) values ($1, $2)", [
        client,
        randomBytes(32),
      ]);
      await admin.query(
        "insert into app.consent_texts (id, purpose, version, locale, body) values ($1, 'request_transfer', $2, 'ru', 'Тест')",
        [text, 1000 + randomInt(0, 100_000)],
      );
      await admin.query(
        `insert into app.consents (id, subject_kind, subject_id, purpose, action, text_id, scope_listing_id, source)
         values ($1, 'client', $2, 'request_transfer', 'grant', $3, $4, 'tma')`,
        [consent, client, text, listing.id],
      );
      const { rows } = await admin.query<{ id: string }>(
        `insert into app.requests (client_id, listing_id, vendor_id, consent_id, occasion_code, event_date, guests, source)
         values ($1, $2, $3, $4, 'toy', current_date + 40, 150, 'tma') returning id`,
        [client, listing.id, vendor.id, consent],
      );
      requestId = rows[0]?.id ?? "";
      await admin.query(
        "insert into pii.request_contacts (request_id, contact_name, contact_phone, comment) values ($1, 'Client', $2, 'Нужен зал')",
        [requestId, clientPhone],
      );
    });

    it("список: срок ответа идёт; модератору заявки недоступны", async () => {
      const list = await ok<StaffRequestList>(api("manager", "GET", "/staff/requests?sla=waiting"));
      const item = list.items.find((r) => r.id === requestId);
      // Чья заявка — имя из неё; телефона в списке нет
      expect(item).toMatchObject({
        status: "new",
        sla: "waiting",
        contactName: "Client",
        listing: { id: listing.id },
      });
      expect(JSON.stringify(list)).not.toContain(clientPhone.slice(4));
      expect(list.counts.waiting).toBeGreaterThanOrEqual(1);
      expect((await api("moderator", "GET", "/staff/requests")).status).toBe(403);
    });

    it("заявка: имя и комментарий видны, телефона в ответе нет", async () => {
      const detail = await ok<StaffRequestDetail>(api("manager", "GET", `/staff/requests/${requestId}`));
      expect(detail).toMatchObject({ contactName: "Client", comment: "Нужен зал", contactPurged: false });
      expect(detail.history).toMatchObject([{ from: null, to: "new" }]);
      expect(JSON.stringify(detail)).not.toContain(clientPhone.slice(4));
    });

    it("телефон клиента: только администратор и только с причиной; чтение — в журнале", async () => {
      expect(
        (await api("manager", "POST", `/staff/requests/${requestId}/client-phone`, { reason: "x" })).status,
      ).toBe(403);
      expect(
        await error(api("admin", "POST", `/staff/requests/${requestId}/client-phone`, {})),
      ).toMatchObject({
        status: 422,
        details: ["reason"],
      });
      const revealed = await ok<{ phone: string }>(
        api("admin", "POST", `/staff/requests/${requestId}/client-phone`, {
          reason: "Клиент просит перезвонить",
        }),
      );
      expect(revealed.phone).toBe(clientPhone);
      const { rows } = await admin.query(
        "select actor_kind, purpose, reason from app.pii_access_log where subject_id = $1",
        [requestId],
      );
      expect(rows).toEqual([
        { actor_kind: "staff", purpose: "staff_reveal", reason: "Клиент просит перезвонить" },
      ]);
      // В журнале панели — чья заявка словами, номера нет
      const detail = await ok<StaffRequestDetail>(api("manager", "GET", `/staff/requests/${requestId}`));
      const pii = await ok<PiiAccessList>(api("admin", "GET", `/staff/audit/pii?object=${requestId}`));
      expect(pii.items).toMatchObject([
        { subjectKind: "request_contact", subjectLabel: `№${detail.publicNo}`, purpose: "staff_reveal" },
      ]);
      expect(JSON.stringify(pii)).not.toContain(clientPhone.slice(4));
    });

    it("кому звонить: телефоны вендора и карточки", async () => {
      const phones = await ok<{ phone: string; listingPhone: string }>(
        api("manager", "POST", `/staff/requests/${requestId}/vendor-phone`),
      );
      expect(phones.phone).toBe(contactPhone);
      expect(phones.listingPhone).toMatch(/^\+99890\d{7}$/);
    });
  });
});

describe("пользователи кабинета: приглашение, владелец, «убрать из кабинета»", () => {
  const ownerPhone = phone();
  const memberPhone = phone();
  const knownPhone = phone();
  const usersOf = (vendorId: string) => `/staff/vendors/${vendorId}/users`;
  let vendor: VendorDetail;
  let owner: VendorUser;
  let member: VendorUser;

  beforeAll(async () => {
    vendor = await ok<VendorDetail>(
      api("manager", "POST", "/staff/vendors", { name: `Kabinet ${tag}` }),
      201,
    );
  });

  it("модератор не приглашает; сотрудника площадки без владельца — 409 vendor_last_owner", async () => {
    expect(
      (await api("moderator", "POST", usersOf(vendor.id), { phone: memberPhone, role: "member" })).status,
    ).toBe(403);
    expect(
      await error(api("manager", "POST", usersOf(vendor.id), { phone: memberPhone, role: "member" })),
    ).toMatchObject({ status: 409, code: "vendor_last_owner" });
  });

  it("приглашение ждёт входа: роль и язык — как выбрали; в журнале — без имени и номера", async () => {
    owner = await ok<VendorUser>(
      api("manager", "POST", usersOf(vendor.id), {
        phone: ownerPhone,
        fullName: "Kamola",
        role: "owner",
        locale: "ru",
      }),
      201,
    );
    expect(owner).toMatchObject({
      fullName: "Kamola",
      role: "owner",
      locale: "ru",
      status: "pending",
      notifiable: false,
      accountLinked: false,
      lastLoginAt: null,
    });
    member = await ok<VendorUser>(
      api("manager", "POST", usersOf(vendor.id), { phone: memberPhone, role: "member", locale: "uz" }),
      201,
    );
    expect(member).toMatchObject({ role: "member", locale: "uz", status: "pending" });
    const { rows } = await admin.query<{ detail: unknown }>(
      "select detail from app.audit_log where action = 'vendor_user.invite' and object_id = $1",
      [member.id],
    );
    expect(rows).toEqual([
      { detail: { vendor_id: vendor.id, role: "member", via: "phone", accepted: false } },
    ]);
    expect(JSON.stringify(rows)).not.toContain(memberPhone.slice(4));
  });

  it("номер уже подтверждён у аккаунта с Telegram — принято сразу, уведомления доходят, «вас добавили» — в очереди", async () => {
    // Аккаунт с этим номером и Telegram; бот уже может ему писать как клиенту
    const telegramId = 700_000_000 + randomInt(0, 99_999_999);
    const tgHash = createHmac("sha256", ID_HASH_KEY).update(String(telegramId)).digest();
    const {
      rows: [account],
    } = await admin.query<{ id: string }>("insert into app.accounts default values returning id");
    await admin.query(
      `insert into app.account_identities (account_id, kind, value_hash) values
         ($1, 'phone', $2), ($1, 'telegram', $3)`,
      [account?.id, createHmac("sha256", ID_HASH_KEY).update(knownPhone).digest(), tgHash],
    );
    await admin.query("insert into pii.account_profiles (account_id, telegram_id) values ($1, $2)", [
      account?.id,
      telegramId,
    ]);
    await admin.query("insert into app.clients (account_id, tg_id_hash, can_message) values ($1, $2, true)", [
      account?.id,
      tgHash,
    ]);

    const accepted = await ok<VendorUser>(
      api("manager", "POST", usersOf(vendor.id), { phone: knownPhone, role: "member", locale: "uz" }),
      201,
    );
    expect(accepted).toMatchObject({
      status: "accepted",
      accountLinked: true,
      telegramLinked: true,
      notifiable: true,
    });
    const { rows } = await admin.query<{ kind: string; payload: unknown }>(
      "select kind, payload from app.outbox where recipient_kind = 'vendor_user' and recipient_id = $1",
      [accepted.id],
    );
    expect(rows).toEqual([{ kind: "vendor.access_granted", payload: { vendor_id: vendor.id } }]);
  });

  it("последнего владельца не понизить, не отключить и не убрать — 409 vendor_last_owner", async () => {
    const url = `${usersOf(vendor.id)}/${owner.id}`;
    expect(await error(api("manager", "PATCH", url, { role: "member" }))).toMatchObject({
      status: 409,
      code: "vendor_last_owner",
    });
    expect(await error(api("manager", "POST", `${url}/disable`))).toMatchObject({
      status: 409,
      code: "vendor_last_owner",
    });
    expect(await error(api("manager", "DELETE", url))).toMatchObject({
      status: 409,
      code: "vendor_last_owner",
    });
    // Имя и язык — можно
    const renamed = await ok<VendorUser>(
      api("manager", "PATCH", url, { fullName: "Kamola K.", locale: "uz" }),
    );
    expect(renamed).toMatchObject({ fullName: "Kamola K.", locale: "uz", role: "owner" });
  });

  it("убрать из кабинета — 204: ни пользователя, ни профиля; повтор — 404; в журнале — remove", async () => {
    const url = `${usersOf(vendor.id)}/${member.id}`;
    expect((await api("moderator", "DELETE", url)).status).toBe(403);
    expect((await api("manager", "DELETE", url)).status).toBe(204);
    const detail = await ok<VendorDetail>(api("manager", "GET", `/staff/vendors/${vendor.id}`));
    expect(detail.users.map((u) => u.id)).not.toContain(member.id);
    const { rows: profiles } = await admin.query(
      "select 1 from pii.vendor_user_profiles where vendor_user_id = $1",
      [member.id],
    );
    expect(profiles).toEqual([]);
    expect((await api("manager", "DELETE", url)).status).toBe(404);
    const { rows } = await admin.query<{ detail: unknown }>(
      "select detail from app.audit_log where action = 'vendor_user.remove' and object_id = $1",
      [member.id],
    );
    expect(rows).toEqual([{ detail: { vendor_id: vendor.id, role: "member", had_account: false } }]);
  });
});
