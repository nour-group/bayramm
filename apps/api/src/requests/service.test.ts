// Заявки без базы: порядок шагов в транзакции, отказы до записи, дубликат
// (заранее и в гонке), чужая заявка — 404. С настоящим Postgres —
// test/integration/client-api.test.ts
import { DatabaseError } from "pg";
import { describe, expect, it } from "vitest";
import type { ClientActor } from "../db/actor";
import { ApiError, type PgError } from "../errors";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import type { CreateRequestInput } from "./input";
import { createRequest, listClientRequests, withdrawRequest } from "./service";

const CLIENT: ClientActor = { kind: "client", id: "cccccccc-0000-4000-8000-000000000001" };
const LISTING = "aaaaaaaa-0000-4000-8000-000000000101";
const VENDOR = "aaaaaaaa-0000-4000-8000-000000000001";
const TRANSFER = "dddddddd-0000-4000-8000-000000000001";
const NOTIFY = "dddddddd-0000-4000-8000-000000000002";
const CONSENT = "ffffffff-0000-4000-8000-000000000001";
const REQUEST = "eeeeeeee-0000-4000-8000-000000000001";
const EXISTING = "eeeeeeee-0000-4000-8000-000000000099";

const input: CreateRequestInput = {
  listingId: LISTING,
  occasionCode: "toy",
  eventDate: "2026-10-03",
  guests: 200,
  details: null,
  budgetMinUzs: null,
  budgetMaxUzs: 50_000_000,
  contactName: "Азиз",
  contactPhone: "+998000000123",
  comment: null,
  requestTransferConsentId: TRANSFER,
  notifyConsentId: null,
};

function pgError(code: string, extra: Partial<Omit<PgError, "code">> = {}): DatabaseError {
  const err = new DatabaseError("db error", 0, "error");
  Object.assign(err, { severity: "ERROR", code, ...extra });
  return err;
}

async function rejection(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("ожидался отказ");
}

const is = {
  listing: (q: RecordedQuery) =>
    q.sql.startsWith('select "id", "vendor_id", "category_code", "attributes" from "app"."listings"'),
  duplicate: (q: RecordedQuery) => q.sql.startsWith('select "id" from "app"."requests"'),
  occasion: (q: RecordedQuery) => q.sql.includes('from "app"."occasions"'),
  busy: (q: RecordedQuery) => q.sql.includes("app.listing_busy"),
  texts: (q: RecordedQuery) => q.sql.includes('from "app"."consent_texts"'),
  consent: (q: RecordedQuery) => q.sql.startsWith('insert into "app"."consents"'),
  request: (q: RecordedQuery) => q.sql.startsWith('insert into "app"."requests"'),
  contacts: (q: RecordedQuery) => q.sql.startsWith('insert into "pii"."request_contacts"'),
};

interface Script {
  listing?: unknown[];
  duplicate?: unknown[][];
  occasion?: unknown[];
  busy?: unknown[];
  texts?: unknown[];
  requestError?: Error;
}

function scriptedDb(script: Script = {}) {
  const duplicates = [...(script.duplicate ?? [])];
  return fakeDb((q) => {
    if (is.listing(q))
      return script.listing ?? [{ id: LISTING, vendor_id: VENDOR, category_code: "hall", attributes: {} }];
    if (is.duplicate(q)) return duplicates.shift() ?? [];
    if (is.occasion(q)) return script.occasion ?? [{ code: "toy" }];
    if (is.busy(q)) return script.busy ?? [];
    if (is.texts(q)) return script.texts ?? [{ id: TRANSFER, purpose: "request_transfer" }];
    if (is.consent(q)) return [{ id: CONSENT }];
    if (is.request(q)) {
      if (script.requestError) throw script.requestError;
      return [
        { id: REQUEST, public_no: "1042", status: "new", sla_due_at: new Date("2026-09-29T19:00:00Z") },
      ];
    }
    return [];
  });
}

describe("createRequest", () => {
  it("одна транзакция под клиентом: проверки → согласие → заявка → контакты", async () => {
    const fake = scriptedDb();
    const created = await createRequest(fake.db, CLIENT, input, "tma", "2026-09-29");

    expect(created).toEqual({
      id: REQUEST,
      publicNo: 1042,
      status: "new",
      slaDueAt: "2026-09-29T19:00:00.000Z",
    });
    expect(fake.log.filter((l) => l === "begin")).toHaveLength(1);
    expect(fake.log.at(-1)).toBe("commit");
    expect(fake.queries[0]?.parameters).toEqual(["client", CLIENT.id, ""]);

    const steps = fake.queries.slice(1).map((q) => Object.entries(is).find(([, test]) => test(q))?.[0]);
    expect(steps).toEqual([
      "listing",
      "duplicate",
      "occasion",
      "busy",
      "texts",
      "consent",
      "request",
      "contacts",
    ]);
    // Занятость дня заявки — та же функция, что у каталога и календаря витрины
    expect(fake.queries.find(is.busy)?.parameters).toEqual([LISTING, "2026-10-03", "2026-10-03"]);

    const consent = fake.queries.find(is.consent);
    expect(consent?.parameters).toEqual([
      "client",
      CLIENT.id,
      "request_transfer",
      "grant",
      TRANSFER,
      LISTING,
      "tma",
    ]);
    const request = fake.queries.find(is.request);
    expect(request?.parameters).toEqual(
      expect.arrayContaining([
        CLIENT.id,
        LISTING,
        VENDOR,
        CONSENT,
        "toy",
        "2026-10-03",
        200,
        50_000_000,
        "tma",
      ]),
    );
    // Контакты — в pii, не в app.requests
    expect(request?.sql).not.toContain("contact");
    expect(fake.queries.find(is.contacts)?.parameters).toEqual([REQUEST, "Азиз", "+998000000123", null]);
  });

  it("с уведомлениями — второе согласие, без привязки к листингу", async () => {
    const fake = scriptedDb({
      texts: [
        { id: TRANSFER, purpose: "request_transfer" },
        { id: NOTIFY, purpose: "bot_notifications" },
      ],
    });
    await createRequest(fake.db, CLIENT, { ...input, notifyConsentId: NOTIFY }, "web");
    const consents = fake.queries.filter(is.consent);
    expect(consents).toHaveLength(2);
    expect(consents[1]?.parameters).toEqual([
      "client",
      CLIENT.id,
      "bot_notifications",
      "grant",
      NOTIFY,
      "web",
    ]);
  });

  it("листинг не опубликован или его нет — 404, ничего не пишется", async () => {
    const fake = scriptedDb({ listing: [] });
    expect(await rejection(() => createRequest(fake.db, CLIENT, input, "web"))).toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(fake.queries.some((q) => q.sql.startsWith("insert"))).toBe(false);
    expect(fake.log.at(-1)).toBe("rollback");
  });

  it("активная заявка на этот листинг и дату уже есть — 409 с existingId, ничего не пишется", async () => {
    const fake = scriptedDb({ duplicate: [[{ id: EXISTING }]] });
    const err = await rejection(() => createRequest(fake.db, CLIENT, input, "web"));
    expect(err.toBody()).toEqual({
      existingId: EXISTING,
      error: { code: "duplicate_request", message: "Request for this listing and date already exists" },
    });
    expect(err.status).toBe(409);
    expect(fake.queries.some((q) => q.sql.startsWith("insert"))).toBe(false);
    // Дубликат — без отозванных, как уникальный индекс
    expect(fake.queries.find(is.duplicate)?.sql).toContain('"status" <> $');
    expect(fake.queries.find(is.duplicate)?.parameters).toContain("withdrawn");
  });

  it("гонка: вставка упала на уникальном индексе — id победившей из новой транзакции", async () => {
    const fake = scriptedDb({
      duplicate: [[], [{ id: EXISTING }]],
      requestError: pgError("23505", { constraint: "requests_client_listing_date_uq" }),
    });
    const err = await rejection(() => createRequest(fake.db, CLIENT, input, "web"));
    expect(err).toMatchObject({ status: 409, code: "duplicate_request", extra: { existingId: EXISTING } });
    expect(fake.log.filter((l) => l === "begin")).toHaveLength(2);
    expect(fake.log).toContain("rollback");
  });

  it("прочие ошибки базы летят дальше (их переводит handleError)", async () => {
    const fake = scriptedDb({ requestError: pgError("BR014") });
    await expect(createRequest(fake.db, CLIENT, input, "web")).rejects.toMatchObject({ code: "BR014" });
  });

  it("день занят — 409 date_busy по дате, ничего не пишется", async () => {
    const fake = scriptedDb({ busy: [{ parts: ["all"] }] });
    const err = await rejection(() => createRequest(fake.db, CLIENT, input, "web"));
    expect(err).toMatchObject({ status: 409, code: "date_busy", details: ["eventDate"] });
    expect(fake.queries.some((q) => q.sql.startsWith("insert"))).toBe(false);
    expect(fake.log.at(-1)).toBe("rollback");
  });

  it("занята другая часть дня (у зала частей нет) — заявка проходит", async () => {
    const fake = scriptedDb({ busy: [{ parts: ["evening"] }] });
    await expect(createRequest(fake.db, CLIENT, input, "web")).resolves.toMatchObject({ status: "new" });
  });

  it("неизвестный повод — 400 до записи", async () => {
    const fake = scriptedDb({ occasion: [] });
    expect(await rejection(() => createRequest(fake.db, CLIENT, input, "web"))).toMatchObject({
      status: 400,
      details: ["occasionCode"],
    });
    expect(fake.queries.some((q) => q.sql.startsWith("insert"))).toBe(false);
  });

  it.each<[string, Partial<CreateRequestInput>, unknown[], string]>([
    ["текста нет", {}, [], "requestTransferConsentId"],
    ["текст другой цели", {}, [{ id: TRANSFER, purpose: "bot_notifications" }], "requestTransferConsentId"],
    [
      "уведомления — текст не той цели",
      { notifyConsentId: NOTIFY },
      [
        { id: TRANSFER, purpose: "request_transfer" },
        { id: NOTIFY, purpose: "client_service" },
      ],
      "notifyConsentId",
    ],
  ])("согласие: %s — 422 consent_required", async (_, patch, texts, field) => {
    const fake = scriptedDb({ texts });
    expect(
      await rejection(() => createRequest(fake.db, CLIENT, { ...input, ...patch }, "web")),
    ).toMatchObject({
      status: 422,
      code: "consent_required",
      details: [field],
    });
    expect(fake.queries.some((q) => q.sql.startsWith("insert"))).toBe(false);
  });
});

function requestRow(patch: Record<string, unknown> = {}) {
  return {
    id: REQUEST,
    public_no: "1042",
    status: "new",
    decline_reason: null,
    event_date: "2026-10-03",
    guests: 200,
    occasion_code: "toy",
    created_at: new Date("2026-09-29T07:00:00Z"),
    sla_due_at: new Date("2026-09-29T19:00:00Z"),
    first_response_at: null,
    sla_breached: false,
    listing_id: LISTING,
    slug: "hall-1",
    name: "Hall 1",
    district_code: "chilonzor",
    cover_key: null,
    cover_width: null,
    cover_height: null,
    ...patch,
  };
}

const isList = (q: RecordedQuery) => q.sql.includes('from "app"."requests" as "r"');

describe("listClientRequests", () => {
  it("свои заявки под клиентом, новые сверху; срок ответа — в базе", async () => {
    const fake = fakeDb((q) =>
      isList(q)
        ? [
            requestRow({
              status: "declined",
              decline_reason: "busy",
              first_response_at: new Date("2026-09-29T08:00:00Z"),
              cover_key: "k.webp",
              cover_width: 10,
              cover_height: 20,
            }),
          ]
        : [],
    );
    const items = await listClientRequests(fake.db, CLIENT);
    const query = fake.queries.find(isList);
    expect(query?.sql).toContain('where "r"."client_id" = $');
    expect(query?.sql).toContain('order by "r"."created_at" desc, "r"."id" desc limit $');
    expect(query?.sql).toContain(
      "(r.status in ('new', 'viewed') and r.first_response_at is null and r.sla_due_at <= now()) as \"sla_breached\"",
    );
    expect(items).toEqual([
      {
        id: REQUEST,
        publicNo: 1042,
        status: "declined",
        declineReason: "busy",
        eventDate: "2026-10-03",
        guests: 200,
        occasionCode: "toy",
        createdAt: "2026-09-29T07:00:00.000Z",
        slaDueAt: "2026-09-29T19:00:00.000Z",
        firstResponseAt: "2026-09-29T08:00:00.000Z",
        slaBreached: false,
        listing: {
          id: LISTING,
          slug: "hall-1",
          name: "Hall 1",
          cover: { key: "k.webp", width: 10, height: 20 },
          districtCode: "chilonzor",
        },
      },
    ]);
  });
});

describe("withdrawRequest", () => {
  const isLock = (q: RecordedQuery) => q.sql.includes("for update");
  const isUpdate = (q: RecordedQuery) => q.sql.startsWith('update "app"."requests"');

  it("чужая или несуществующая — 404 (RLS её не покажет), ничего не меняется", async () => {
    const fake = fakeDb();
    expect(await rejection(() => withdrawRequest(fake.db, CLIENT, REQUEST, "web"))).toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(fake.queries.some(isUpdate)).toBe(false);
    expect(fake.queries.find(isLock)?.parameters).toEqual([REQUEST, CLIENT.id]);
  });

  it("своя: источник — в GUC для журнала статусов, статус — withdrawn", async () => {
    const fake = fakeDb((q) => {
      if (isLock(q)) return [{ id: REQUEST, status: "viewed" }];
      if (isList(q)) return [requestRow({ status: "withdrawn" })];
      return [];
    });
    const result = await withdrawRequest(fake.db, CLIENT, REQUEST, "tma");
    expect(result.status).toBe("withdrawn");
    const guc = fake.queries.find((q) => q.sql.includes("'app.source'"));
    expect(guc?.parameters).toEqual(["tma"]);
    expect(fake.queries.find(isUpdate)?.parameters).toEqual(["withdrawn", REQUEST]);
    expect(fake.log.at(-1)).toBe("commit");
  });

  it("уже отозванная — без UPDATE (повтор безопасен)", async () => {
    const fake = fakeDb((q) => {
      if (isLock(q)) return [{ id: REQUEST, status: "withdrawn" }];
      if (isList(q)) return [requestRow({ status: "withdrawn" })];
      return [];
    });
    expect((await withdrawRequest(fake.db, CLIENT, REQUEST, "web")).status).toBe("withdrawn");
    expect(fake.queries.some(isUpdate)).toBe(false);
  });

  it("из итогового статуса — ошибка триггера переходов летит дальше (409)", async () => {
    const fake = fakeDb((q) => {
      if (isLock(q)) return [{ id: REQUEST, status: "deal" }];
      if (isUpdate(q)) throw pgError("BR002");
      return [];
    });
    await expect(withdrawRequest(fake.db, CLIENT, REQUEST, "web")).rejects.toMatchObject({ code: "BR002" });
    expect(fake.log.at(-1)).toBe("rollback");
  });
});
