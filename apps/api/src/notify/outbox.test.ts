// Отправитель outbox без базы и без Telegram: fakeDb отдаёт взятые строки и данные
// для текста, клиент Telegram подменён
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { type BotApiMethods, type TelegramClient, TelegramError } from "../telegram/client";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { backoffSeconds, dispatchOutbox, failureOutcome, MAX_ATTEMPTS, MAX_DELAY_SECONDS } from "./outbox";
import type { OutboxRow } from "./render";

const REQUEST_ID = "eeeeeeee-0000-4000-8000-0000000000a1";
const VENDOR_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const VENDOR_USER_ID = "aaaaaaaa-0000-4000-8000-000000000011";
const CLIENT_ID = "cccccccc-0000-4000-8000-000000000001";
const STAFF_ID = "00000000-0000-4000-8000-00000000a001";
const URLS = { webAppUrl: "https://app.example", vendorAppUrl: "https://vendor.example" };
const NOW = new Date("2026-10-01T09:00:00Z");
const CREATED = new Date("2026-10-01T05:00:00Z");

const outboxRow = (patch: Partial<OutboxRow> = {}): OutboxRow => ({
  id: "0b0b0b0b-0000-4000-8000-000000000001",
  kind: "vendor.request_new",
  channel: "telegram",
  recipient_kind: "vendor_user",
  recipient_id: VENDOR_USER_ID,
  request_id: REQUEST_ID,
  payload: { request_id: REQUEST_ID },
  attempts: 1,
  ...patch,
});

interface World {
  rows?: OutboxRow[];
  vendorUser?: Record<string, unknown> | null;
  client?: Record<string, unknown> | null;
  staff?: Record<string, unknown> | null;
  deadRow?: Record<string, unknown> | null;
  /** Кто дал первый ответ по заявке (requests.first_response_by) */
  firstResponseBy?: string | null;
  revision?: Record<string, unknown> | null;
}

function db(world: World = {}) {
  const vendorUser =
    world.vendorUser === undefined
      ? {
          vendor_id: VENDOR_ID,
          locale: "ru",
          disabled_at: null,
          tg_linked_at: CREATED,
          telegram_chat_id: "5001",
        }
      : world.vendorUser;
  const client =
    world.client === undefined ? { locale: "uz", telegram_id: "7001", notifiable: true } : world.client;
  const staff =
    world.staff === undefined ? { active: true, role: "admin", telegram_chat_id: "9001" } : world.staff;
  return fakeDb((q: RecordedQuery) => {
    if (q.sql.includes("skip locked")) return world.rows ?? [outboxRow()];
    if (q.sql.includes('from "app"."vendor_users"')) return vendorUser ? [vendorUser] : [];
    if (q.sql.includes('from "app"."clients"')) return client ? [client] : [];
    if (q.sql.includes('from "app"."staff"')) return staff ? [staff] : [];
    if (q.sql.includes('from "app"."requests"')) {
      return [
        {
          public_no: "1001",
          event_date: "2026-12-12",
          guests: 200,
          client_id: CLIENT_ID,
          vendor_id: VENDOR_ID,
          created_at: CREATED,
          sla_due_at: new Date(CREATED.getTime() + 12 * 3_600_000),
          listing: "Test Hall",
          district_code: "chilonzor",
          name_ru: "Свадьба",
          name_uz: "Toʻy",
          public_code: "V101",
          first_response_by: world.firstResponseBy ?? null,
        },
      ];
    }
    if (q.sql.includes('from "app"."listing_revisions" as "rv"'))
      return world.revision ? [world.revision] : [];
    if (q.sql.includes('from "app"."outbox" as "o"')) return world.deadRow ? [world.deadRow] : [];
    return [];
  });
}

type Send = (params: BotApiMethods["sendMessage"]["params"]) => Promise<{ message_id: number }>;

function telegram(send: Send = async () => ({ message_id: 77 })) {
  const calls: BotApiMethods["sendMessage"]["params"][] = [];
  const client: TelegramClient = {
    call: (async (method: string, params: BotApiMethods["sendMessage"]["params"]) => {
      if (method !== "sendMessage") throw new Error(`неожиданный метод ${method}`);
      calls.push(params);
      return send(params);
    }) as TelegramClient["call"],
  };
  return { client, calls };
}

// Итог отправки — UPDATE строки outbox, не тот, что берёт строки (skip locked)
const finishQuery = (fake: ReturnType<typeof db>) =>
  fake.queries.find(
    (q) => q.sql.startsWith('update "app"."outbox" set "status"') && !q.sql.includes("skip locked"),
  );

let consoleSpies: MockInstance[];
const logged = () => consoleSpies.map((spy) => inspect(spy.mock.calls, { depth: 10 })).join("\n");

beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
});
afterEach(() => vi.restoreAllMocks());

async function run(world: World, send?: Send) {
  const fake = db(world);
  const tg = telegram(send);
  const report = await dispatchOutbox({ db: fake.db, telegram: tg.client, urls: URLS, now: () => NOW });
  return { fake, tg, report };
}

describe("dispatchOutbox: взять строки", () => {
  it("подошедшие pending/failed и брошенные sending — FOR UPDATE SKIP LOCKED, под system", async () => {
    const { fake } = await run({ rows: [] });
    const claim = fake.queries.find((q) => q.sql.includes("skip locked"));
    expect(claim?.sql).toContain('update "app"."outbox" set "status" = $1, "attempts" = "attempts" + $2');
    expect(claim?.sql).toContain("for update skip locked");
    expect(claim?.parameters).toEqual(expect.arrayContaining(["sending", "pending", "failed", 25]));
    expect(fake.queries[0]?.parameters).toEqual(["system", "", ""]);
  });
});

describe("dispatchOutbox: сообщения", () => {
  it("новая заявка вендору: номер, площадка, дата, гости, повод; кнопка — заявка в кабинете; без данных клиента", async () => {
    const { fake, tg, report } = await run({});
    expect(report).toEqual({ claimed: 1, sent: 1, retry: 0, dead: 0 });
    expect(tg.calls).toHaveLength(1);
    const message = tg.calls[0];
    expect(message?.chat_id).toBe(5001);
    for (const part of ["№1001", "Test Hall", "12.12.2026", "200 гостей", "Свадьба", "12 часов"]) {
      expect(message?.text).toContain(part);
    }
    expect(message?.text).not.toMatch(/\+?998\d{9}/);
    expect(message?.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "Открыть в кабинете", web_app: { url: `https://vendor.example/requests/${REQUEST_ID}` } }],
      ],
    });
    // В базу — только id и статусы, без текста
    const finish = finishQuery(fake);
    expect(finish?.parameters).toEqual(["sent", "77", null, outboxRow().id, "sending"]);
    // Клиент не запрашивается: вендору его данные не нужны
    expect(fake.queries.some((q) => q.sql.includes('from "app"."clients"'))).toBe(false);
  });

  it("напоминание вендору: сколько часов осталось", async () => {
    const { tg } = await run({
      rows: [outboxRow({ kind: "vendor.sla_reminder", payload: { request_id: REQUEST_ID, stage: 1 } })],
    });
    // создана в 05:00Z, срок — 17:00Z, сейчас 09:00Z: осталось 8 часов
    expect(tg.calls[0]?.text).toContain("осталось 8 часов");
  });

  it("напоминание от команды: без счёта часов (срок мог пройти), кнопка — заявка в кабинете", async () => {
    const { tg, report } = await run({
      rows: [
        outboxRow({
          kind: "vendor.ops_reminder",
          payload: { request_id: REQUEST_ID, staff_id: "00000000-0000-0000-0000-00000000a001" },
        }),
      ],
    });
    expect(report.sent).toBe(1);
    const text = tg.calls[0]?.text ?? "";
    expect(text).toContain("Команда Bayramm напоминает");
    expect(text).toContain("№1001");
    expect(text).not.toContain("осталось");
    expect(text).not.toMatch(/\+?998\d{9}/);
    expect(tg.calls[0]?.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "Открыть в кабинете", web_app: { url: `https://vendor.example/requests/${REQUEST_ID}` } }],
      ],
    });
  });

  it("клиенту — на его языке; отказ — «похожие»: каталог на дату, гостей и район заявки", async () => {
    const { tg } = await run({
      rows: [
        outboxRow({
          kind: "client.request_status",
          recipient_kind: "client",
          recipient_id: CLIENT_ID,
          payload: { request_id: REQUEST_ID, status: "declined" },
        }),
      ],
    });
    expect(tg.calls[0]?.chat_id).toBe(7001);
    expect(tg.calls[0]?.text).toContain("soʻrovni qabul qila olmaydi");
    expect(tg.calls[0]?.reply_markup).toEqual({
      inline_keyboard: [
        [
          {
            text: "Oʻxshashlarini koʻrish",
            web_app: { url: "https://app.example/?date=2026-12-12&guests=200&district=chilonzor" },
          },
        ],
      ],
    });
  });

  it("клиенту о статусе — кнопка открывает эту заявку в «Моих заявках»", async () => {
    for (const status of ["contacted", "deal"]) {
      const { tg } = await run({
        rows: [
          outboxRow({
            kind: "client.request_status",
            recipient_kind: "client",
            recipient_id: CLIENT_ID,
            payload: { request_id: REQUEST_ID, status },
          }),
        ],
      });
      expect(tg.calls[0]?.reply_markup, status).toEqual({
        inline_keyboard: [
          [{ text: "Soʻrovni ochish", web_app: { url: `https://app.example/requests?open=${REQUEST_ID}` } }],
        ],
      });
    }
  });

  it("«связались» отметил сотрудник — клиенту: команда связалась с площадкой; кнопка — та же заявка", async () => {
    const status = (firstResponseBy: string) =>
      run({
        firstResponseBy,
        rows: [
          outboxRow({
            kind: "client.request_status",
            recipient_kind: "client",
            recipient_id: CLIENT_ID,
            payload: { request_id: REQUEST_ID, status: "contacted" },
          }),
        ],
      });
    const team = await status("staff");
    const text = team.tg.calls[0]?.text ?? "";
    expect(text).toContain("Bayramm jamoasi");
    expect(text).toContain("Test Hall");
    expect(text).not.toContain("javob berdi");
    expect(text).not.toMatch(/\+?998\d{9}/);
    expect(team.tg.calls[0]?.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "Soʻrovni ochish", web_app: { url: `https://app.example/requests?open=${REQUEST_ID}` } }],
      ],
    });
    // Ответила сама площадка — как прежде
    const vendor = await status("vendor_user");
    expect(vendor.tg.calls[0]?.text).toContain("javob berdi");
  });

  it("правка карточки от партнёра — модератору: площадка, вендор, поля; менеджеру — нет", async () => {
    const revisionRow = (recipient: string) =>
      outboxRow({
        id: `0b0b0b0b-0000-4000-8000-00000000000${recipient === "moderator" ? 3 : 4}`,
        kind: "ops.revision_submitted",
        recipient_kind: "staff",
        recipient_id: STAFF_ID,
        request_id: null,
        payload: { revision_id: "0c0c0c0c-0000-4000-8000-000000000001" },
      });
    const revision = {
      status: "pending",
      payload: { price_from_uzs: 180000, description_ru: "Новое" },
      name: "Test Hall",
      public_code: "V101",
    };
    const moderator = await run({
      revision,
      staff: { active: true, role: "moderator", telegram_chat_id: "9002" },
      rows: [revisionRow("moderator")],
    });
    expect(moderator.report.sent).toBe(1);
    expect(moderator.tg.calls[0]?.chat_id).toBe(9002);
    for (const part of ["Test Hall", "V101", "цена, описание (рус.)"])
      expect(moderator.tg.calls[0]?.text).toContain(part);

    const manager = await run({
      revision,
      staff: { active: true, role: "manager", telegram_chat_id: "9003" },
      rows: [revisionRow("manager")],
    });
    expect(manager.tg.calls).toHaveLength(0);
    expect(manager.report.dead).toBe(1);

    // Правку уже отозвали — не о чем оповещать
    const withdrawn = await run({
      revision: { ...revision, status: "withdrawn" },
      rows: [revisionRow("moderator")],
    });
    expect(withdrawn.tg.calls).toHaveLength(0);
  });

  it("просрочка: клиенту — предложение посмотреть похожие, администратору — оповещение по-русски", async () => {
    const { tg } = await run({
      rows: [
        outboxRow({ kind: "client.sla_breach", recipient_kind: "client", recipient_id: CLIENT_ID }),
        outboxRow({
          id: "0b0b0b0b-0000-4000-8000-000000000002",
          kind: "ops.sla_breach",
          recipient_kind: "staff",
          recipient_id: STAFF_ID,
        }),
      ],
    });
    expect(tg.calls[0]?.text).toContain("12 soat ichida javob bermadi");
    expect(tg.calls[0]?.reply_markup).toEqual({
      inline_keyboard: [
        [
          {
            text: "Oʻxshashlarini koʻrish",
            web_app: { url: "https://app.example/?date=2026-12-12&guests=200&district=chilonzor" },
          },
        ],
      ],
    });
    expect(tg.calls[1]?.chat_id).toBe(9001);
    expect(tg.calls[1]?.text).toContain("V101");
  });

  it("недоставленное — администратору: вид, заявка, получатель и причина", async () => {
    const { tg } = await run({
      rows: [
        outboxRow({
          kind: "ops.outbox_dead",
          recipient_kind: "staff",
          recipient_id: STAFF_ID,
          request_id: null,
          payload: { outbox_id: "0b0b0b0b-0000-4000-8000-000000000009", kind: "vendor.request_new" },
        }),
      ],
      deadRow: {
        kind: "vendor.request_new",
        recipient_kind: "vendor_user",
        recipient_id: VENDOR_USER_ID,
        attempts: 1,
        last_error: "api 403: Forbidden: bot was blocked by the user",
        public_no: "1001",
      },
    });
    expect(tg.calls[0]?.text).toContain("vendor.request_new, заявка №1001");
    expect(tg.calls[0]?.text).toContain("vendor_user aaaaaaaa…");
    expect(tg.calls[0]?.text).toContain("bot was blocked");
  });
});

describe("dispatchOutbox: кому уже нельзя писать — dead без отправки", () => {
  it.each([
    [
      "пользователь вендора отвязан",
      {
        vendorUser: {
          vendor_id: VENDOR_ID,
          locale: "ru",
          disabled_at: null,
          tg_linked_at: null,
          telegram_chat_id: "5001",
        },
      },
      "skipped: vendor_user_unlinked",
    ],
    [
      "пользователь вендора отключён",
      {
        vendorUser: {
          vendor_id: VENDOR_ID,
          locale: "ru",
          disabled_at: CREATED,
          tg_linked_at: CREATED,
          telegram_chat_id: "5001",
        },
      },
      "skipped: vendor_user_unlinked",
    ],
    [
      "пользователь чужого вендора",
      {
        vendorUser: {
          vendor_id: "bbbbbbbb-0000-4000-8000-000000000001",
          locale: "ru",
          disabled_at: null,
          tg_linked_at: CREATED,
          telegram_chat_id: "5001",
        },
      },
      "skipped: recipient_mismatch",
    ],
  ] as const)("%s", async (_name, world, error) => {
    const { tg, fake, report } = await run(world as World);
    expect(tg.calls).toHaveLength(0);
    expect(report.dead).toBe(1);
    expect(finishQuery(fake)?.parameters).toEqual(["dead", error, outboxRow().id, "sending"]);
  });

  it("клиент отозвал согласие после постановки в очередь", async () => {
    const { tg, fake } = await run({
      rows: [outboxRow({ kind: "client.sla_breach", recipient_kind: "client", recipient_id: CLIENT_ID })],
      client: { locale: "ru", telegram_id: "7001", notifiable: false },
    });
    expect(tg.calls).toHaveLength(0);
    expect(finishQuery(fake)?.parameters).toEqual([
      "dead",
      "skipped: client_not_notifiable",
      outboxRow().id,
      "sending",
    ]);
  });

  it("неизвестный вид и канал sms", async () => {
    for (const patch of [{ kind: "vendor.unknown" }, { channel: "sms" }]) {
      const { tg, report } = await run({ rows: [outboxRow(patch)] });
      expect(tg.calls).toHaveLength(0);
      expect(report.dead).toBe(1);
    }
  });
});

describe("dispatchOutbox: ошибки Telegram", () => {
  const apiError = (status: number, description: string, retryAfter?: number) => async () => {
    throw new TelegramError("sendMessage", "api", status, description, retryAfter);
  };

  it("429 — повтор через retry_after + 1 с, попытка не считается", async () => {
    const { fake, report } = await run({}, apiError(429, "Too Many Requests: retry after 17", 17));
    expect(report.retry).toBe(1);
    const finish = finishQuery(fake);
    expect(finish?.sql).toContain("greatest(attempts - 1, 0)");
    expect(finish?.parameters).toEqual([
      "failed",
      18,
      "api 429: Too Many Requests: retry after 17",
      outboxRow().id,
      "sending",
    ]);
  });

  it("403 клиенту — dead сразу и can_message снят", async () => {
    const { fake, report } = await run(
      { rows: [outboxRow({ kind: "client.sla_breach", recipient_kind: "client", recipient_id: CLIENT_ID })] },
      apiError(403, "Forbidden: bot was blocked by the user"),
    );
    expect(report.dead).toBe(1);
    expect(finishQuery(fake)?.parameters).toEqual([
      "dead",
      "api 403: Forbidden: bot was blocked by the user",
      outboxRow().id,
      "sending",
    ]);
    const clients = fake.queries.find((q) => q.sql.startsWith('update "app"."clients"'));
    expect(clients?.parameters).toEqual([false, CLIENT_ID]);
  });

  it("400 (чата нет) — dead сразу; вендору can_message не трогаем", async () => {
    const { fake, report } = await run({}, apiError(400, "Bad Request: chat not found"));
    expect(report.dead).toBe(1);
    expect(fake.queries.some((q) => q.sql.startsWith('update "app"."clients"'))).toBe(false);
  });

  it("сеть — повтор с растущей паузой; после MAX_ATTEMPTS — dead", async () => {
    const network = async () => {
      throw new TelegramError("sendMessage", "network", 0);
    };
    const retry = await run({ rows: [outboxRow({ attempts: 3 })] }, network);
    expect(finishQuery(retry.fake)?.parameters).toEqual([
      "failed",
      120,
      "network",
      outboxRow().id,
      "sending",
    ]);

    const last = await run({ rows: [outboxRow({ attempts: MAX_ATTEMPTS })] }, network);
    expect(finishQuery(last.fake)?.parameters).toEqual([
      "dead",
      "attempts_exhausted: network",
      outboxRow().id,
      "sending",
    ]);
  });

  it("одна строка упала — остальные отправляются; в лог — без текста сообщений", async () => {
    let n = 0;
    const { report, tg } = await run(
      { rows: [outboxRow(), outboxRow({ id: "0b0b0b0b-0000-4000-8000-000000000002" })] },
      async () => {
        n++;
        if (n === 1) throw new TelegramError("sendMessage", "timeout", 0);
        return { message_id: 78 };
      },
    );
    expect(report).toEqual({ claimed: 2, sent: 1, retry: 1, dead: 0 });
    expect(tg.calls).toHaveLength(2);
    expect(logged()).not.toContain("Test Hall");
  });
});

describe("политика повторов", () => {
  it("30 с × 2^(n−1), не дольше часа", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffSeconds)).toEqual([30, 60, 120, 240, 480, 960, 1920, 3600]);
    expect(backoffSeconds(20)).toBe(MAX_DELAY_SECONDS);
  });

  it("429 без retry_after — базовая пауза", () => {
    expect(failureOutcome(new TelegramError("sendMessage", "api", 429), 1)).toMatchObject({
      status: "failed",
      delaySeconds: 31,
      countAttempt: false,
    });
  });

  it("5xx и неизвестные ошибки — повтор; 401 (не тот токен) — повтор, не dead", () => {
    expect(failureOutcome(new TelegramError("sendMessage", "api", 502), 1)).toMatchObject({
      status: "failed",
    });
    expect(failureOutcome(new TelegramError("sendMessage", "api", 401), 1)).toMatchObject({
      status: "failed",
    });
    expect(failureOutcome(new Error("boom"), 1)).toMatchObject({ status: "failed", error: "internal_error" });
  });
});
