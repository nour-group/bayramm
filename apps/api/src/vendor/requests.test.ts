import { describe, expect, it } from "vitest";
import type { VendorActor } from "../db/actor";
import { ApiError } from "../errors";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import {
  formatInboxCursor,
  getRequest,
  type InboxCursor,
  idOrNotFound,
  listRequests,
  logCallAttempt,
  PAGE_LIMIT_DEFAULT,
  parseInboxCursor,
  parseListQuery,
  parsePatch,
  updateRequestStatus,
} from "./requests";

const ACTOR: VendorActor = {
  kind: "vendor_user",
  id: "aaaaaaaa-0000-0000-0000-000000000011",
  vendorId: "aaaaaaaa-0000-0000-0000-000000000001",
  role: "owner",
};
const REQUEST_ID = "eeeeeeee-0000-0000-0000-0000000000a1";
const LISTING_ID = "aaaaaaaa-0000-0000-0000-000000000101";

function row(patch: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    public_no: "1001",
    status: "new",
    decline_reason: null,
    listing_id: LISTING_ID,
    listing_name: "Test Hall",
    occasion_code: "toy",
    event_date: "2026-11-14",
    guests: 200,
    budget_min_uzs: "40000000",
    budget_max_uzs: null,
    created_at: new Date("2026-10-01T08:00:00Z"),
    sla_due_at: new Date("2026-10-01T20:00:00Z"),
    first_response_at: null,
    first_response_by: null,
    sla_breached: false,
    decline_note: null,
    contact_name: "Client",
    comment: "Вечер",
    ...patch,
  };
}

const isItemQuery = (q: RecordedQuery) => q.sql.startsWith('select "r"."id", "r"."public_no"');

/** База: строка заявки на запрос списка/карточки, остальное — из extra */
function dbWith(
  item: ReturnType<typeof row> | null,
  extra: (q: RecordedQuery) => unknown[] | null = () => null,
) {
  return fakeDb((q) => {
    const answer = extra(q);
    if (answer !== null) return answer;
    if (isItemQuery(q)) return item ? [item] : [];
    return [];
  });
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

describe("разбор запроса", () => {
  it("id не UUID — 404, как чужой", async () => {
    for (const id of ["1", "nope", `${REQUEST_ID}x`, "eeeeeeee-0000-0000-0000-0000000000g1"]) {
      const err = await rejection(async () => idOrNotFound(id));
      expect([err.status, err.code]).toEqual([404, "not_found"]);
    }
    expect(idOrNotFound(REQUEST_ID.toUpperCase())).toBe(REQUEST_ID);
  });

  it("список: вкладка, курсор и размер страницы", () => {
    expect(parseListQuery({})).toEqual({
      tab: "new",
      listingId: null,
      after: null,
      limit: PAGE_LIMIT_DEFAULT,
    });
    expect(parseListQuery({ tab: "closed", cursor: "1042", limit: "10" })).toEqual({
      tab: "closed",
      listingId: null,
      after: { kind: "newest", no: 1042 },
      limit: 10,
    });
    expect(parseListQuery({ tab: "active", cursor: "1.1790000000123456.1042" })).toEqual({
      tab: "active",
      listingId: null,
      after: { kind: "deadline", answered: true, dueUs: 1790000000123456, no: 1042 },
      limit: PAGE_LIMIT_DEFAULT,
    });
    for (const query of [
      { tab: "all" },
      { tab: "closed", cursor: "0" },
      { tab: "closed", cursor: "-1" },
      // курсор другой вкладки: у открытых — срок и номер, у закрытой — только номер
      { tab: "closed", cursor: "0.1790000000123456.1042" },
      { tab: "new", cursor: "1042" },
      { tab: "new", cursor: "2.1790000000123456.1042" },
      { tab: "new", cursor: "0.1790000000123456.0" },
      { tab: "new", cursor: "0.99999999999999999.1" },
      { limit: "0" },
      { limit: "51" },
      { listingId: "not-a-uuid" },
    ]) {
      expect(() => parseListQuery(query), JSON.stringify(query)).toThrow(ApiError);
    }
  });

  it("переход: только contacted, deal, declined; причина — только у отказа и обязательна", () => {
    expect(parsePatch({ status: "contacted" })).toEqual({ status: "contacted" });
    expect(parsePatch({ status: "deal", declineReason: null })).toEqual({ status: "deal" });
    expect(parsePatch({ status: "declined", declineReason: "busy", declineNote: "  занято  " })).toEqual({
      status: "declined",
      declineReason: "busy",
      declineNote: "занято",
    });
    expect(parsePatch({ status: "declined", declineReason: "other", declineNote: " " })).toEqual({
      status: "declined",
      declineReason: "other",
    });
    const bad = [
      null,
      [],
      { status: "viewed" },
      { status: "withdrawn" },
      { status: "expired" },
      { status: "declined" },
      { status: "declined", declineReason: "cheap" },
      { status: "declined", declineReason: "busy", declineNote: 5 },
      { status: "declined", declineReason: "busy", declineNote: "я".repeat(501) },
      { status: "contacted", declineReason: "busy" },
      { status: "deal", declineNote: "x" },
    ];
    for (const body of bad) {
      const err = (() => {
        try {
          parsePatch(body);
        } catch (e) {
          return e as ApiError;
        }
        return null;
      })();
      expect(err?.status, JSON.stringify(body)).toBe(422);
      expect(err?.code).toBe("invalid_input");
    }
  });
});

describe("курсор входящих", () => {
  it("туда и обратно", () => {
    for (const cursor of [
      { kind: "newest", no: 7 },
      { kind: "deadline", answered: false, dueUs: 1790000000123456, no: 1001 },
    ] satisfies InboxCursor[]) {
      const tab = cursor.kind === "newest" ? "closed" : "new";
      expect(parseInboxCursor(tab, formatInboxCursor(cursor))).toEqual(cursor);
    }
  });
});

describe("listRequests", () => {
  it("открытые вкладки: сначала ждущие ответа, по сроку — ближайший (и просроченный) сверху", async () => {
    const fake = fakeDb();
    await listRequests(fake.db, ACTOR, {
      tab: "new",
      listingId: null,
      after: { kind: "deadline", answered: false, dueUs: 1790000000123456, no: 1042 },
      limit: 20,
    });
    const list = fake.queries.find(isItemQuery);
    const answered = "(r.status not in ('new', 'viewed') or r.first_response_at is not null)";
    const due = "(extract(epoch from r.sla_due_at) * 1000000)::bigint";
    expect(list?.sql).toContain(`order by ${answered}, ${due}, "r"."public_no" limit $`);
    expect(list?.sql).toContain(`(${answered}, ${due}, r.public_no) > ($`);
    expect(list?.parameters).toEqual(expect.arrayContaining([false, 1790000000123456, 1042, 21]));
  });

  it("под актором вендора, по его вендору, статусы вкладки; закрытые — новые сверху", async () => {
    const fake = dbWith(row(), (q) =>
      q.sql.includes("group by")
        ? [
            { status: "new", n: 2 },
            { status: "contacted", n: 1 },
            { status: "deal", n: 4 },
          ]
        : null,
    );
    const page = await listRequests(fake.db, ACTOR, {
      tab: "closed",
      listingId: null,
      after: { kind: "newest", no: 1050 },
      limit: 20,
    });

    const [settings, list] = fake.queries;
    expect(settings?.parameters).toEqual(["vendor_user", ACTOR.id, ACTOR.vendorId]);
    expect(list?.sql).toContain(
      'where "r"."vendor_id" = $1 and "r"."status" in ($2, $3, $4, $5) and "r"."public_no" < $6',
    );
    expect(list?.sql).toContain('order by "r"."public_no" desc limit $7');
    expect(list?.parameters).toEqual([
      ACTOR.vendorId,
      "deal",
      "declined",
      "withdrawn",
      "expired",
      "1050",
      21,
    ]);
    // Телефон в список не попадает — только имя из видимого по согласию контакта
    expect(list?.sql).not.toContain("read_request_phone");
    expect(list?.sql).not.toContain("contact_phone");

    expect(page.counts).toEqual({ new: 2, active: 1, closed: 4 });
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([
      {
        id: REQUEST_ID,
        publicNo: 1001,
        status: "new",
        declineReason: null,
        listing: { id: LISTING_ID, name: "Test Hall" },
        occasionCode: "toy",
        eventDate: "2026-11-14",
        guests: 200,
        budgetMinUzs: 40_000_000,
        budgetMaxUzs: null,
        createdAt: "2026-10-01T08:00:00.000Z",
        sla: { dueAt: "2026-10-01T20:00:00.000Z", firstResponseAt: null, breached: false },
        firstResponseBy: null,
        contactName: "Client",
      },
    ]);
  });

  it("кто ответил первым — в списке и в карточке: менеджер Bayramm отличим от партнёра", async () => {
    const answered = new Date("2026-10-01T09:00:00Z");
    const byStaff = row({
      status: "contacted",
      first_response_at: answered,
      first_response_by: "staff",
    });
    const fake = dbWith(byStaff, (q) => (q.sql.includes("group by") ? [] : null));
    const page = await listRequests(fake.db, ACTOR, {
      tab: "active",
      listingId: null,
      after: null,
      limit: 20,
    });
    expect(page.items[0]?.firstResponseBy).toBe("staff");
    expect(page.items[0]?.sla.firstResponseAt).toBe(answered.toISOString());

    const detail = await getRequest(dbWith(byStaff).db, ACTOR, REQUEST_ID);
    expect(detail.firstResponseBy).toBe("staff");
    const byVendor = row({
      status: "contacted",
      first_response_at: answered,
      first_response_by: "vendor_user",
    });
    expect((await getRequest(dbWith(byVendor).db, ACTOR, REQUEST_ID)).firstResponseBy).toBe("vendor_user");
    // Первый ответ читается из столбца базы, а не выводится из журнала статусов
    const list = fake.queries.find(isItemQuery);
    expect(list?.sql).toContain('"r"."first_response_by"');
  });

  it("строк больше страницы — курсор на последнюю заявку страницы", async () => {
    const open = [
      row({ public_no: "1001", answered: false, due_us: "1790000000000001" }),
      row({ public_no: "1003", answered: false, due_us: "1790000000000002" }),
      row({ public_no: "1002", answered: true, due_us: "1790000000000000" }),
    ];
    const fake = fakeDb((q) => (isItemQuery(q) ? open : []));
    const page = await listRequests(fake.db, ACTOR, { tab: "new", listingId: null, after: null, limit: 2 });
    expect(page.items.map((i) => i.publicNo)).toEqual([1001, 1003]);
    expect(page.nextCursor).toBe("0.1790000000000002.1003");

    const closed = [row({ public_no: "1003" }), row({ public_no: "1002" }), row({ public_no: "1001" })];
    const fakeClosed = fakeDb((q) => (isItemQuery(q) ? closed : []));
    const last = await listRequests(fakeClosed.db, ACTOR, {
      tab: "closed",
      listingId: null,
      after: null,
      limit: 2,
    });
    expect(last.nextCursor).toBe("1002");
  });
});

describe("getRequest", () => {
  it("открытие отмечает новую просмотренной — только свою и только из new", async () => {
    const fake = dbWith(row({ status: "viewed" }));
    await getRequest(fake.db, ACTOR, REQUEST_ID);
    const update = fake.queries.find((q) => q.sql.startsWith("update"));
    expect(update?.sql).toBe(
      'update "app"."requests" set "status" = $1 where "id" = $2 and "vendor_id" = $3 and "status" = $4',
    );
    expect(update?.parameters).toEqual(["viewed", REQUEST_ID, ACTOR.vendorId, "new"]);
  });

  it("контакт виден — телефон через журналируемое чтение", async () => {
    const fake = dbWith(row({ status: "viewed" }), (q) => {
      if (q.sql.includes("pii.read_request_phone")) return [{ phone: "+998000000301" }];
      if (q.sql.includes("request_status_log"))
        return [{ to_status: "new", at: new Date("2026-10-01T08:00:00Z"), actor_kind: "system" }];
      return null;
    });
    const detail = await getRequest(fake.db, ACTOR, REQUEST_ID);
    expect(detail.contact).toEqual({ name: "Client", phone: "+998000000301", comment: "Вечер" });
    expect(detail.history).toEqual([{ status: "new", at: "2026-10-01T08:00:00.000Z", by: "system" }]);
    const read = fake.queries.find((q) => q.sql.includes("pii.read_request_phone"));
    expect(read?.parameters).toEqual([REQUEST_ID]);
    // Сырой телефон из таблицы не выбирается никогда
    expect(fake.queries.some((q) => q.sql.includes("contact_phone"))).toBe(false);
  });

  it("согласие отозвано (контакт не виден) — ни имени, ни телефона, и чтения нет", async () => {
    const fake = dbWith(row({ status: "withdrawn", contact_name: null, comment: null }));
    const detail = await getRequest(fake.db, ACTOR, REQUEST_ID);
    expect(detail.contact).toBeNull();
    expect(detail.contactName).toBeNull();
    expect(fake.queries.some((q) => q.sql.includes("read_request_phone"))).toBe(false);
  });

  it("чужая или несуществующая — 404 и откат", async () => {
    const fake = dbWith(null);
    const err = await rejection(() => getRequest(fake.db, ACTOR, REQUEST_ID));
    expect([err.status, err.code]).toEqual([404, "not_found"]);
    expect(fake.log.at(-1)).toBe("rollback");
  });
});

describe("updateRequestStatus", () => {
  it("отказ: статус, причина и комментарий одной записью по своей заявке", async () => {
    let calls = 0;
    const fake = fakeDb((q) => {
      if (!isItemQuery(q)) return [];
      calls++;
      return [row(calls === 1 ? { status: "viewed" } : { status: "declined", decline_reason: "busy" })];
    });
    const item = await updateRequestStatus(fake.db, ACTOR, REQUEST_ID, {
      status: "declined",
      declineReason: "busy",
      declineNote: "занято",
    });
    const update = fake.queries.find((q) => q.sql.startsWith("update"));
    expect(update?.sql).toBe(
      'update "app"."requests" set "status" = $1, "decline_reason" = $2, "decline_note" = $3 where "id" = $4 and "vendor_id" = $5',
    );
    expect(update?.parameters).toEqual(["declined", "busy", "занято", REQUEST_ID, ACTOR.vendorId]);
    expect(item.status).toBe("declined");
    expect(fake.log.at(-1)).toBe("commit");
  });

  it("«вернуть в активные» снимает причину отказа", async () => {
    const fake = dbWith(row({ status: "declined", decline_reason: "price" }));
    await updateRequestStatus(fake.db, ACTOR, REQUEST_ID, { status: "contacted" });
    const update = fake.queries.find((q) => q.sql.startsWith("update"));
    expect(update?.parameters).toEqual(["contacted", null, null, REQUEST_ID, ACTOR.vendorId]);
  });

  it("повтор того же действия — без записи", async () => {
    const fake = dbWith(row({ status: "contacted" }));
    const item = await updateRequestStatus(fake.db, ACTOR, REQUEST_ID, { status: "contacted" });
    expect(item.status).toBe("contacted");
    expect(fake.queries.some((q) => q.sql.startsWith("update"))).toBe(false);
  });

  it("чужая — 404 без попытки записи", async () => {
    const fake = dbWith(null);
    const err = await rejection(() =>
      updateRequestStatus(fake.db, ACTOR, REQUEST_ID, { status: "contacted" }),
    );
    expect(err.status).toBe(404);
    expect(fake.queries.some((q) => q.sql.startsWith("update"))).toBe(false);
  });
});

describe("logCallAttempt", () => {
  it("событие request.call_attempt без данных клиента", async () => {
    const fake = dbWith(row());
    await logCallAttempt(fake.db, ACTOR, REQUEST_ID);
    const insert = fake.queries.find((q) => q.sql.startsWith('insert into "app"."audit_log"'));
    expect(insert?.parameters).toEqual(["request.call_attempt", "request", REQUEST_ID, "vendor_cabinet"]);
  });

  it("чужая — 404, в журнал не пишется", async () => {
    const fake = dbWith(null);
    expect((await rejection(() => logCallAttempt(fake.db, ACTOR, REQUEST_ID))).status).toBe(404);
    expect(fake.queries.some((q) => q.sql.includes("audit_log"))).toBe(false);
  });
});
