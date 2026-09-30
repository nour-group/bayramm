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
import type {
  Availability,
  ListingDetail,
  ListingList,
  StaffDictionaries,
  StaffMe,
  StaffPhoto,
  StaffRequestDetail,
  StaffRequestList,
  VendorDetail,
  VendorList,
  VendorUser,
} from "@bayramm/shared/api/staff";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../src/index";
import { adminClient, ID_HASH_KEY, inviteStaff, makeEnv, newStaffUsername, staffLoginToken } from "./helpers";

const STORAGE_URL = trimTrailingSlashes(process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:54321");
const SERVICE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? "";

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
    const manager = await ok<StaffMe>(api("manager", "GET", "/staff/me"));
    expect(manager.permissions).toContain("vendors.write");
    expect(manager.permissions).not.toContain("listings.publish");
  });

  it("справочники: районы, категории, сотрудники, минимум фото", async () => {
    const dict = await ok<StaffDictionaries>(api("manager", "GET", "/staff/dictionaries"));
    expect(dict.districts).toHaveLength(12);
    expect(dict.categories.filter((c) => c.enabled).map((c) => c.code)).toEqual(["hall"]);
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
    expect(user).toMatchObject({ telegramLinked: false, role: "owner", disabledAt: null });

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

  it("карточка: адрес из названия, пакеты, телефон; модератор не создаёт", async () => {
    const input = {
      vendorId: vendor.id,
      name: `Тойхона «Хумо» ${tag}`,
      districtCode: "chilonzor",
      priceFromUzs: 150_000,
      capMin: 50,
      capMax: 300,
      descriptionRu: "Зал на 300 гостей",
      descriptionUz: "300 mehmonga zal",
      packages: [
        {
          kind: "weekday",
          nameRu: "Будни",
          nameUz: "Ish kunlari",
          priceUzs: 150_000,
          priceUnit: "per_guest",
        },
        { kind: "weekend", nameRu: "Выходные", nameUz: "Dam olish kunlari", priceUzs: 180_000 },
      ],
      phone: phone(),
    };
    expect((await api("moderator", "POST", "/staff/listings", input)).status).toBe(403);
    listing = await ok<ListingDetail>(api("manager", "POST", "/staff/listings", input), 201);
    expect(listing).toMatchObject({ status: "draft", version: 1, hasPhone: true, categoryCode: "hall" });
    expect(listing.slug).toBe(`toyxona-xumo-${tag}`);
    expect(listing.packages.map((p) => p.kind)).toEqual(["weekday", "weekend"]);
    expect(listing.blockers.review).toEqual(["photos"]);
    expect(listing.blockers.active).toEqual(["photos", "contract", "stir", "contacts", "pd_consent"]);
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

  it("публикует модератор: фото одобряются, карточка в каталоге", async () => {
    listing = await ok<ListingDetail>(
      api("moderator", "POST", `/staff/listings/${listing.id}/publish`, { version: listing.version }),
    );
    expect(listing.status).toBe("active");
    expect(listing.publishedAt).not.toBeNull();
    expect(listing.photos.every((p) => p.moderation === "approved")).toBe(true);
    expect(listing.blockers.active).toEqual([]);
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
    expect(actions).toContain("listing_package.create");
    expect(actions).toContain("listing_contact.create");
    expect(
      rows.filter((r) => r.action === "listing.update" && (r.detail.to as string) === "suspended"),
    ).toHaveLength(1);
    expect(rows.map((r) => r.row).join()).not.toContain("+99890");
  });

  it("занятость: отметить и снять дни", async () => {
    const busy = await ok<Availability>(
      api("manager", "PUT", `/staff/listings/${listing.id}/availability`, {
        busy: ["2027-01-10", "2027-01-11"],
      }),
    );
    expect(busy.busy).toEqual([
      { day: "2027-01-10", source: "staff" },
      { day: "2027-01-11", source: "staff" },
    ]);
    await ok(api("manager", "PUT", `/staff/listings/${listing.id}/availability`, { free: ["2027-01-10"] }));
    const month = await ok<Availability>(
      api("moderator", "GET", `/staff/listings/${listing.id}/availability?from=2027-01-01&to=2027-01-31`),
    );
    expect(month.busy).toEqual([{ day: "2027-01-11", source: "staff" }]);
    expect(
      await error(
        api("manager", "PUT", `/staff/listings/${listing.id}/availability`, { busy: ["2027-02-30"] }),
      ),
    ).toMatchObject({ status: 422, details: ["busy"] });
    expect(
      (await api("moderator", "PUT", `/staff/listings/${listing.id}/availability`, { busy: [] })).status,
    ).toBe(403);
  });

  it("отключение пользователя кабинета и снятие привязки Telegram", async () => {
    const [user] = vendor.users;
    // Как после привязки ботом: хэш Telegram ID и время — вместе
    await admin.query("update app.vendor_users set tg_user_hash = $1, tg_linked_at = now() where id = $2", [
      randomBytes(32),
      user?.id,
    ]);
    const linked = await ok<VendorDetail>(api("moderator", "GET", `/staff/vendors/${vendor.id}`));
    expect(linked.users[0]).toMatchObject({ telegramLinked: true });
    expect(JSON.stringify(linked)).not.toMatch(/tg_user_hash|telegram_user_id/);
    expect(
      await error(
        api("manager", "PATCH", `/staff/vendors/${vendor.id}/users/${user?.id}`, { phone: phone() }),
      ),
    ).toMatchObject({ status: 409, code: "user_linked" });
    const unlinked = await ok<VendorUser>(
      api("manager", "POST", `/staff/vendors/${vendor.id}/users/${user?.id}/unlink`),
    );
    expect(unlinked.telegramLinked).toBe(false);

    const disabled = await ok<VendorUser>(
      api("manager", "POST", `/staff/vendors/${vendor.id}/users/${user?.id}/disable`),
    );
    expect(disabled.disabledAt).not.toBeNull();
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
      expect(item).toMatchObject({ status: "new", sla: "waiting", listing: { id: listing.id } });
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
