// Списки панели без count(*) over (): страница читается сама, общее число — отдельным запросом,
// и только когда его не видно по странице (page-total.ts). Ответ тот же: { total, items }.
// Скорость на больших таблицах проверена на сгенерированных данных (отчёт R2-P); здесь — форма
// запросов и разбор страницы.

import type { AuditList, ClientList, StaffRequestList } from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { authenticate, requireStaff } from "../auth/session";
import type { AppEnv } from "../env";
import { handleError } from "../errors";
import { sections } from "../routes/staff";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { makeEnv } from "../testing/worker";
import { allOf, pageTotal } from "./page-total";

const ACCOUNT_ID = "acacacac-0000-0000-0000-000000000001";
const STAFF_ID = "00000000-0000-0000-0000-00000000a001";

const SESSION = {
  sessionId: "11111111-0000-0000-0000-000000000001",
  accountId: ACCOUNT_ID,
  app: "admin",
  via: "staff_elevation",
  proofAt: new Date(),
  accountDisabledAt: null,
  accountDeletedAt: null,
  clientId: null,
  clientBlocked: null,
  clientDeleted: null,
  staffId: STAFF_ID,
  staffRole: "admin",
  staffActive: true,
  staffAccountId: ACCOUNT_ID,
};

const AT = new Date("2026-10-01T05:00:00Z");

const requestRow = (n: number) => ({
  id: `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`,
  public_no: String(1000 + n),
  status: "new",
  sla_due_at: AT,
  first_response_at: null,
  first_response_by: null,
  occasion_code: "toy",
  event_date: "2026-12-01",
  guests: 100,
  day_parts: "{}",
  created_at: AT,
  listing_id: "bbbbbbbb-0000-4000-8000-000000000001",
  listing_name: "Hall",
  category_code: "hall",
  vendor_id: "aaaaaaaa-0000-4000-8000-000000000001",
  public_code: "V101",
  vendor_name: "Lola",
  sla: "ok",
  contact_name: "Азиза",
  reminders: 0,
});

const auditRow = (n: number) => ({
  id: String(n),
  at: AT,
  actor_kind: "staff",
  actor_id: STAFF_ID,
  action: "listing.update",
  object_type: "listing",
  object_id: "bbbbbbbb-0000-4000-8000-000000000001",
  detail: {},
  source: "admin",
});

const clientRow = (n: number) => ({
  id: `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`,
  created_at: AT,
  last_seen_at: AT,
  locale: "ru",
  blocked_at: null,
  deleted_at: null,
  display_first: "Азиза",
  display_last: "Каримова",
  last_no: null,
  last_status: null,
  last_listing: null,
  requests: 0,
  last_request_at: null,
  sign_in: ["telegram"],
});

/** Приложение панели; rows — строки страницы, count — что отвечает отдельный запрос числа записей */
function setup(page: { requests?: number; audit?: number; clients?: number }, count = 1234) {
  const rowsFor = (q: RecordedQuery) => {
    if (q.sql.includes('from "app"."sessions"')) return [SESSION];
    if (/select count\(\*\)::int as "n"/.test(q.sql) && !q.sql.includes("group by")) return [{ n: count }];
    if (q.sql.includes('from "app"."clients" as "c"') && q.sql.includes("limit"))
      return Array.from({ length: page.clients ?? 0 }, (_, i) => clientRow(i + 1));
    if (q.sql.includes('from "app"."requests" as "r"') && q.sql.includes("limit"))
      return Array.from({ length: page.requests ?? 0 }, (_, i) => requestRow(i + 1));
    if (q.sql.includes('from "app"."audit_log" as "a"') && q.sql.includes("limit"))
      return Array.from({ length: page.audit ?? 0 }, (_, i) => auditRow(i + 1));
    return [];
  };
  const fake = fakeDb(rowsFor);
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("db", fake.db);
    await next();
  });
  app.use(authenticate, requireStaff());
  app.route("/", sections);
  app.onError(handleError);
  const get = async <T>(path: string) => {
    const res = await app.request(
      path,
      { headers: { Authorization: `Bearer ${"t".repeat(43)}` } },
      makeEnv(),
    );
    expect(res.status, path).toBe(200);
    return (await res.json()) as T;
  };
  const counts = () =>
    fake.queries.filter((q) => /select count\(\*\)::int as "n"/.test(q.sql) && !q.sql.includes("group by"));
  return { fake, get, counts };
}

describe("pageTotal", () => {
  const never = async () => {
    throw new Error("считать не нужно");
  };

  it("неполная страница — конец виден по ней: offset + строки; пустая первая — ноль; без запроса числа", async () => {
    expect(await pageTotal(7, 50, 0, never)).toBe(7);
    expect(await pageTotal(7, 50, 100, never)).toBe(107);
    expect(await pageTotal(0, 50, 0, never)).toBe(0);
  });

  it("полная страница и пустая дальняя — число считает запрос", async () => {
    expect(await pageTotal(50, 50, 0, async () => 321)).toBe(321);
    expect(await pageTotal(0, 50, 200, async () => 12)).toBe(12);
  });

  it("allOf: пусто — true, иначе все условия через and", () => {
    const compile = (b: ReturnType<typeof allOf>) => {
      const fake = fakeDb();
      return b.compile(fake.db);
    };
    expect(compile(allOf([])).sql).toBe("true");
  });
});

describe("GET /requests", () => {
  it("страница короче лимита — total по ней, count не нужен, окна в запросе нет", async () => {
    const { fake, get, counts } = setup({ requests: 3 });
    const body = await get<StaffRequestList>("/requests?limit=50");
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(counts()).toHaveLength(0);
    expect(fake.queries.some((q) => q.sql.includes("over ()"))).toBe(false);
  });

  it("полная страница — отдельный count: без соединений, пока по витрине и вендору не ищут", async () => {
    const { get, counts } = setup({ requests: 2 });
    const body = await get<StaffRequestList>("/requests?limit=2&status=new&sla=late");
    expect(body.total).toBe(1234);
    const [count] = counts();
    expect(count?.sql).toContain('from "app"."requests" as "r"');
    expect(count?.sql).not.toContain("join");
    // Те же условия, что у страницы
    expect(count?.sql).toContain("r.status = ");
    expect(count?.parameters).toContain("new");
  });

  it("поиск и раздел — count с соединениями; витрина — по r.listing_id", async () => {
    const searched = setup({ requests: 2 });
    await searched.get<StaffRequestList>("/requests?limit=2&q=lola&category=hall");
    expect(searched.counts()[0]?.sql).toContain("inner join");
    expect(searched.counts()[0]?.sql).toContain("l.category_code = ");
    expect(searched.counts()[0]?.sql).toContain("ilike");

    const listing = setup({ requests: 2 });
    await listing.get<StaffRequestList>("/requests?limit=2&listingId=bbbbbbbb-0000-4000-8000-000000000001");
    expect(listing.counts()[0]?.sql).not.toContain("join");
    expect(listing.counts()[0]?.sql).toContain("r.listing_id = ");
  });

  it("часть дня: заявки на эту часть; весь день — без частей, только у категорий с календарём", async () => {
    const evening = setup({ requests: 2 });
    const body = await evening.get<StaffRequestList>("/requests?limit=2&part=evening");
    expect(body.items[0]?.dayParts).toEqual([]);
    expect(evening.counts()[0]?.sql).toContain("::app.day_part = any (r.day_parts)");
    expect(evening.counts()[0]?.parameters).toContain("evening");
    expect(evening.counts()[0]?.sql).not.toContain("join");

    const whole = setup({ requests: 2 });
    await whole.get<StaffRequestList>("/requests?limit=2&part=whole");
    expect(whole.counts()[0]?.sql).toContain("cardinality(r.day_parts) = 0");
    expect(whole.counts()[0]?.sql).toContain("inner join");

    const unknown = setup({ requests: 2 });
    await unknown.get<StaffRequestList>("/requests?limit=2&part=night");
    expect(unknown.counts()[0]?.sql).not.toContain("day_parts");
  });

  it("дальняя пустая страница — total настоящий, а не ноль", async () => {
    const { get, counts } = setup({ requests: 0 }, 77);
    const body = await get<StaffRequestList>("/requests?limit=50&offset=500");
    expect(body.total).toBe(77);
    expect(body.items).toEqual([]);
    expect(counts()).toHaveLength(1);
  });
});

describe("GET /audit", () => {
  it("короткая страница — без count; полная — отдельный count с теми же фильтрами; окна нет", async () => {
    const short = setup({ audit: 4 });
    const shortBody = await short.get<AuditList>("/audit");
    expect(shortBody.total).toBe(4);
    expect(short.counts()).toHaveLength(0);
    expect(short.fake.queries.some((q) => q.sql.includes("over ()"))).toBe(false);

    const full = setup({ audit: 2 });
    const body = await full.get<AuditList>("/audit?limit=2&type=listing&action=listing&from=2026-10-01");
    expect(body.total).toBe(1234);
    const [count] = full.counts();
    expect(count?.sql).toContain('from "app"."audit_log" as "a"');
    expect(count?.sql).toContain('"a"."object_type" = ');
    expect(count?.sql).toContain('"a"."action" like ');
    expect(count?.sql).toContain('"a"."at" >= ');
    // Страница — порядок под индекс (at desc, id desc)
    const page = full.fake.queries.find((q) => q.sql.includes("limit") && q.sql.includes('"a"."detail"'));
    expect(page?.sql).toContain('order by "a"."at" desc, "a"."id" desc');
  });

  it("журнал доступа к ПДн — те же правила, свои колонки", async () => {
    const { fake, get, counts } = setup({});
    const body = await get<AuditList>("/audit/pii?type=client&action=client_phone");
    expect(body.total).toBe(0);
    expect(counts()).toHaveLength(0);
    const page = fake.queries.find((q) => q.sql.includes('from "app"."pii_access_log"'));
    expect(page?.sql).toContain('"a"."subject_kind" = ');
    expect(page?.sql).toContain('"a"."purpose" like ');
    expect(page?.sql).not.toContain("over ()");
  });
});

describe("GET /clients", () => {
  it("короткая страница — без count; полная — count по клиентам, без профилей и последних заявок", async () => {
    const short = setup({ clients: 5 });
    expect((await short.get<ClientList>("/clients")).total).toBe(5);
    expect(short.counts()).toHaveLength(0);

    const full = setup({ clients: 2 });
    const body = await full.get<ClientList>("/clients?limit=2&blocked=1");
    expect(body.total).toBe(1234);
    const [count] = full.counts();
    expect(count?.sql).toContain('from "app"."clients" as "c"');
    expect(count?.sql).not.toContain("join");
    expect(count?.sql).toContain("c.blocked_at is not null");
    expect(full.fake.queries.some((q) => q.sql.includes("over ()"))).toBe(false);
  });
});
