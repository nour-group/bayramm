// @vitest-environment jsdom
// Экраны панели v0.2: работа с заявкой, клиенты, уведомления, журнал, команда, настройки,
// правки карточек. API — подменённый fetch; проверяем, что уходит на сервер и что видит
// сотрудник его роли (права решает сервер — панель только не показывает лишнего).
import type {
  AuditList,
  ClientDetail,
  ClientList,
  ListingList,
  OutboxHealth,
  RevisionDetail,
  RevisionList,
  StaffDictionaries,
  StaffMe,
  StaffRequestDetail,
  StaffSettings,
  TeamList,
} from "@bayramm/shared/api/staff";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { tokenStore } from "./session";
import { t } from "./texts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TOKEN = "T".repeat(43);
const ME_ID = "00000000-0000-0000-0000-00000000a001";
const REQUEST_ID = "cccccccc-0000-0000-0000-000000000001";
const CLIENT_ID = "1a2b3c4d-0000-4000-8000-000000000001";
const LISTING_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const VENDOR_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const REVISION_ID = "dddddddd-0000-0000-0000-000000000001";
const OUTBOX_ID = "eeeeeeee-0000-0000-0000-000000000001";

const ADMIN: StaffMe["permissions"] = [
  "catalog.read",
  "vendors.write",
  "vendor_users.write",
  "listings.write",
  "listings.submit",
  "listings.publish",
  "listings.moderate",
  "listings.draft",
  "photos.moderate",
  "vendor_phones.read",
  "requests.read",
  "requests.write",
  "client_phones.read",
  "clients.read",
  "clients.block",
  "outbox.read",
  "outbox.retry",
  "audit.read",
  "settings.write",
  "team.manage",
  "revisions.moderate",
];
const MANAGER: StaffMe["permissions"] = [
  "catalog.read",
  "vendors.write",
  "listings.write",
  "listings.submit",
  "listings.draft",
  "vendor_phones.read",
  "requests.read",
  "requests.write",
  "clients.read",
  "clients.block",
  "outbox.read",
];
const MODERATOR: StaffMe["permissions"] = [
  "catalog.read",
  "listings.publish",
  "listings.moderate",
  "listings.draft",
  "photos.moderate",
  "vendor_phones.read",
  "revisions.moderate",
];

const staff = (role: StaffMe["role"], permissions: StaffMe["permissions"]): StaffMe => ({
  id: ME_ID,
  role,
  displayName: `Test ${role}`,
  username: null,
  permissions,
});

const DICT: StaffDictionaries = {
  categories: [],
  districts: [],
  occasions: [{ code: "toy", nameRu: "Свадьба", nameUz: "Toʻy" }],
  staff: [{ id: ME_ID, displayName: "Test admin", role: "admin" }],
  settings: { minPhotos: 3, maxPhotos: 10, slaHours: 12 },
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let container: HTMLDivElement;
let root: Root;
let calls: Call[];

type Handler = (body: unknown) => Response;
const json =
  (body: unknown, status = 200): Handler =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockApi(me: StaffMe, handlers: Record<string, Handler>) {
  window.sessionStorage.setItem("bayramm.admin.session", TOKEN);
  const all: Record<string, Handler> = {
    "GET /api/staff/me": json(me),
    "GET /api/staff/dictionaries": json(DICT),
    ...handlers,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const url = String(input);
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ method, url, body });
      const key = Object.keys(all).find(
        (k) => k === `${method} ${url}` || `${method} ${url}`.startsWith(`${k}?`),
      );
      return key ? (all[key] as Handler)(body) : new Response("{}", { status: 404 });
    }),
  );
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount(path: string) {
  window.history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
  await settle();
}

const text = () => container.textContent ?? "";
const buttons = (name: string) =>
  [...container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === name);
const button = (name: string) => buttons(name)[0];
const lastCall = (suffix: string) => calls.filter((c) => c.url.split("?")[0]?.endsWith(suffix)).at(-1);

async function click(element: Element | undefined) {
  await act(async () => (element as HTMLElement | undefined)?.click());
  await settle();
}

async function type(input: Element | null, value: string) {
  const element = input as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

beforeEach(() => {
  calls = [];
  window.scrollTo = () => {};
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  tokenStore.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

// ════════════════════════════════════════════════════════════════════════════

const REQUEST: StaffRequestDetail = {
  id: REQUEST_ID,
  publicNo: 1001,
  status: "new",
  sla: "overdue",
  slaDueAt: "2026-09-29T06:00:00.000Z",
  firstResponseAt: null,
  firstResponseBy: null,
  occasionCode: "toy",
  eventDate: "2026-11-10",
  guests: 150,
  createdAt: "2026-09-28T18:00:00.000Z",
  listing: { id: LISTING_ID, name: "Oqsaroy Hall" },
  vendor: { id: VENDOR_ID, code: "V101", name: "Oqsaroy" },
  reminders: 1,
  budgetMinUzs: null,
  budgetMaxUzs: null,
  declineReason: null,
  declineNote: null,
  firstViewedAt: null,
  slaBreachedAt: null,
  source: "tma",
  contactName: "Client",
  comment: null,
  contactPurged: false,
  history: [],
  timeline: [
    { kind: "created", at: "2026-09-28T18:00:00.000Z" },
    {
      kind: "reminder",
      at: "2026-09-28T22:00:00.000Z",
      source: "auto",
      stage: 1,
      by: null,
      recipients: 2,
      delivered: 1,
      failed: 1,
    },
    { kind: "due", at: "2026-09-29T06:00:00.000Z", passed: true },
  ],
  notes: [{ id: "n1", text: "Вендор в отпуске", authorName: "Test manager", at: "2026-09-29T07:00:00.000Z" }],
  awaiting: true,
  vendorReachable: 2,
  nextReminderAt: null,
};

describe("заявка: работа с заявкой", () => {
  it("срок ответа по шагам и заметки видны; «Напомнить» уходит на сервер", async () => {
    const reminded: StaffRequestDetail = { ...REQUEST, nextReminderAt: "2026-09-29T08:30:00.000Z" };
    mockApi(staff("manager", MANAGER), {
      [`GET /api/staff/requests/${REQUEST_ID}`]: json(REQUEST),
      [`POST /api/staff/requests/${REQUEST_ID}/remind`]: json(reminded),
    });
    await mount(`/requests/${REQUEST_ID}`);
    const steps = [...container.querySelectorAll(".timeline li")].map((li) => li.textContent);
    expect(steps).toHaveLength(3);
    expect(steps[1]).toContain(t.reminderAuto(1));
    expect(steps[1]).toContain(t.reminderDelivery(2, 1, 1));
    expect(text()).toContain("Вендор в отпуске");

    await click(button(t.remindVendor));
    expect(lastCall("/remind")?.method).toBe("POST");
    expect(text()).toContain(t.remindSent);
    // Пауза 30 минут: кнопка неактивна, в подсказке — когда можно снова
    expect(button(t.remindVendor)?.disabled).toBe(true);
    expect(text()).toContain("Следующее напоминание");
  });

  it("вендор не привязал Telegram — напомнить нельзя, подсказка «позвоните»", async () => {
    mockApi(staff("manager", MANAGER), {
      [`GET /api/staff/requests/${REQUEST_ID}`]: json({ ...REQUEST, vendorReachable: 0 }),
    });
    await mount(`/requests/${REQUEST_ID}`);
    expect(button(t.remindVendor)?.disabled).toBe(true);
    expect(text()).toContain(t.remindUnreachable);
  });

  it("«Связались» — подтверждение в панели, комментарий уходит на сервер", async () => {
    const contacted: StaffRequestDetail = {
      ...REQUEST,
      status: "contacted",
      sla: "ops_contacted",
      awaiting: false,
      firstResponseBy: "staff",
      firstResponseAt: "2026-09-29T07:00:00.000Z",
    };
    mockApi(staff("manager", MANAGER), {
      [`GET /api/staff/requests/${REQUEST_ID}`]: json(REQUEST),
      [`POST /api/staff/requests/${REQUEST_ID}/contacted`]: json(contacted),
    });
    await mount(`/requests/${REQUEST_ID}`);
    await click(button(t.markContacted));
    const form = container.querySelector(".confirm") as HTMLFormElement;
    expect(form.textContent).toContain(t.markContactedHint);
    await type(form.querySelector("textarea"), "Созвонились");
    await click([...form.querySelectorAll("button")].find((b) => b.textContent === t.markContacted));
    expect(lastCall("/contacted")?.body).toEqual({ comment: "Созвонились" });
    expect(text()).toContain(t.sla.ops_contacted);
    expect(text()).toContain(t.notAwaiting);
  });

  it("заметка: добавляется; модератору без права — ни действий, ни формы", async () => {
    mockApi(staff("manager", MANAGER), {
      [`GET /api/staff/requests/${REQUEST_ID}`]: json(REQUEST),
      [`POST /api/staff/requests/${REQUEST_ID}/notes`]: json(
        {
          ...REQUEST,
          notes: [
            ...REQUEST.notes,
            { id: "n2", text: "Перезвонить в 18:00", authorName: "Test manager", at: "x" },
          ],
        },
        201,
      ),
    });
    await mount(`/requests/${REQUEST_ID}`);
    const form = container.querySelector(".note-form") as HTMLFormElement;
    await type(form.querySelector("textarea"), "Перезвонить в 18:00");
    await click(button(t.addNote));
    expect(lastCall("/notes")?.body).toEqual({ text: "Перезвонить в 18:00" });
    expect(text()).toContain("Перезвонить в 18:00");
  });

  it("список: очередь «Требуют действия» — sla=late, счётчик — просроченные и нарушенные", async () => {
    mockApi(staff("manager", MANAGER), {
      "GET /api/staff/requests": json({
        total: 0,
        items: [],
        counts: {
          waiting: 1,
          overdue: 2,
          breached: 3,
          answered: 0,
          answered_late: 0,
          ops_contacted: 0,
          closed: 0,
        },
      }),
    });
    await mount("/requests");
    const late = button(`${t.slaLate}5`);
    expect(late).toBeDefined();
    await click(late);
    expect(calls.at(-1)?.url).toContain("sla=late");
  });
});

// ════════════════════════════════════════════════════════════════════════════

const CLIENT: ClientDetail = {
  id: CLIENT_ID,
  ref: "C-1a2b3c4d",
  createdAt: "2026-09-01T06:00:00.000Z",
  lastSeenAt: "2026-09-28T06:00:00.000Z",
  locale: "uz",
  blocked: false,
  deleted: false,
  requests: 1,
  lastRequestAt: "2026-09-28T18:00:00.000Z",
  canMessage: true,
  deletedAt: null,
  blockedInfo: null,
  profile: { firstName: "Aziza", lastName: null, username: "aziza_t" },
  requestList: [
    {
      id: REQUEST_ID,
      publicNo: 1001,
      status: "new",
      sla: "waiting",
      eventDate: "2026-11-10",
      createdAt: "2026-09-28T18:00:00.000Z",
      listing: { id: LISTING_ID, name: "Oqsaroy Hall" },
    },
  ],
  consents: [
    {
      purpose: "request_transfer",
      action: "grant",
      textVersion: 1,
      source: "tma",
      at: "2026-09-28T18:00:00.000Z",
      listing: { id: LISTING_ID, name: "Oqsaroy Hall" },
    },
  ],
};

describe("клиенты", () => {
  it("список — только псевдонимы; поиск уходит как q", async () => {
    const list: ClientList = {
      total: 1,
      items: [
        {
          id: CLIENT_ID,
          ref: "C-1a2b3c4d",
          createdAt: CLIENT.createdAt,
          lastSeenAt: null,
          locale: "uz",
          blocked: true,
          deleted: false,
          requests: 3,
          lastRequestAt: null,
        },
      ],
    };
    mockApi(staff("manager", MANAGER), { "GET /api/staff/clients": json(list) });
    await mount("/clients");
    expect(text()).toContain("C-1a2b3c4d");
    expect(text()).toContain(t.clientBlocked);
    const search = container.querySelector("input[type=search]");
    await type(search, "1001");
    await click(button(t.search));
    expect(calls.at(-1)?.url).toContain("q=1001");
  });

  it("клиент: имя, заявки, согласия; блокировка — только с причиной", async () => {
    const blocked: ClientDetail = {
      ...CLIENT,
      blocked: true,
      blockedInfo: { at: "2026-09-29T07:00:00.000Z", reason: "Спам заявками", by: "Test manager" },
    };
    mockApi(staff("manager", MANAGER), {
      [`GET /api/staff/clients/${CLIENT_ID}`]: json(CLIENT),
      [`POST /api/staff/clients/${CLIENT_ID}/block`]: json(blocked),
    });
    await mount(`/clients/${CLIENT_ID}`);
    expect(container.querySelector("h1")?.textContent).toContain("C-1a2b3c4d");
    expect(text()).toContain("Aziza");
    expect(text()).toContain(t.consentPurposes.request_transfer);
    // Менеджеру телефон клиента не показывается
    expect(text()).not.toContain(t.clientPhoneReason);

    await click(button(t.block));
    const form = container.querySelector(".confirm") as HTMLFormElement;
    const submit = [...form.querySelectorAll("button")].find((b) => b.textContent === t.block);
    expect(submit?.disabled).toBe(true);
    await type(form.querySelector("textarea"), "Спам заявками");
    await click(submit);
    expect(lastCall("/block")?.body).toEqual({ reason: "Спам заявками" });
    expect(text()).toContain("Спам заявками");
    expect(button(t.unblock)).toBeDefined();
  });

  it("администратор: телефон — с причиной", async () => {
    mockApi(staff("admin", ADMIN), {
      [`GET /api/staff/clients/${CLIENT_ID}`]: json(CLIENT),
      [`POST /api/staff/clients/${CLIENT_ID}/phone`]: json({ phone: "+998001112233" }),
    });
    await mount(`/clients/${CLIENT_ID}`);
    const form = [...container.querySelectorAll(".confirm")].find((f) =>
      f.textContent?.includes(t.clientPhoneReason),
    );
    await type(form?.querySelector("input") ?? null, "Жалоба вендора");
    await click(form?.querySelector("button") ?? undefined);
    expect(lastCall("/phone")?.body).toEqual({ reason: "Жалоба вендора" });
    expect(text()).toContain("+998 00 111 22 33");
  });
});

// ════════════════════════════════════════════════════════════════════════════

const HEALTH: OutboxHealth = {
  counts: { pending: 2, sending: 0, sent: 40, failed: 1, dead: 1 },
  oldestPendingAt: "2026-09-29T06:00:00.000Z",
  deadTotal: 1,
  dead: [
    {
      id: OUTBOX_ID,
      kind: "vendor.request_new",
      recipientKind: "vendor_user",
      recipientRef: "aaaaaaaa",
      attempts: 8,
      error: "api 403: Forbidden: bot was blocked by the user",
      createdAt: "2026-09-29T05:00:00.000Z",
      lastAttemptAt: "2026-09-29T05:30:00.000Z",
      request: { id: REQUEST_ID, publicNo: 1001 },
    },
  ],
};

describe("уведомления", () => {
  it("менеджер видит счётчики и причины, но не повторяет", async () => {
    mockApi(staff("manager", MANAGER), { "GET /api/staff/outbox": json(HEALTH) });
    await mount("/notifications");
    const stats = [...container.querySelectorAll(".stat")].map((s) => s.textContent);
    expect(stats).toContain(`2${t.outboxCounts.pending}`);
    expect(text()).toContain("bot was blocked by the user");
    expect(text()).toContain(t.noticeKinds["vendor.request_new"]);
    expect(button(t.retry)).toBeUndefined();
  });

  it("администратор повторяет недоставленное", async () => {
    mockApi(staff("admin", ADMIN), {
      "GET /api/staff/outbox": json(HEALTH),
      [`POST /api/staff/outbox/${OUTBOX_ID}/retry`]: json({ ...HEALTH, deadTotal: 0, dead: [] }),
    });
    await mount("/notifications");
    await click(button(t.retry));
    expect(lastCall("/retry")?.method).toBe("POST");
    expect(text()).toContain(t.outboxDeadEmpty);
  });
});

// ════════════════════════════════════════════════════════════════════════════

describe("журнал", () => {
  const LIST: AuditList = {
    total: 1,
    items: [
      {
        id: "1",
        at: "2026-09-29T07:00:00.000Z",
        actorKind: "staff",
        actor: { id: ME_ID, name: "Test manager" },
        action: "listing.update",
        objectType: "listing",
        objectId: LISTING_ID,
        detail: { fields: ["name", "price_from_uzs"], vendor_id: VENDOR_ID },
        source: "admin",
      },
    ],
  };

  it("фильтры из адреса уходят на сервер; подробности — имена полей, как записаны", async () => {
    mockApi(staff("admin", ADMIN), { "GET /api/staff/audit": json(LIST) });
    await mount(`/audit?type=listing&object=${LISTING_ID}`);
    const url = calls.find((c) => c.url.startsWith("/api/staff/audit"))?.url ?? "";
    expect(url).toContain("type=listing");
    expect(url).toContain(`object=${LISTING_ID}`);
    expect(text()).toContain(t.auditActions["listing.update"]);
    expect(text()).toContain("fields: name, price_from_uzs");
    expect(container.querySelector(`a[href="/listings/${LISTING_ID}"]`)).not.toBeNull();
  });

  it("вкладка «Просмотры телефонов» — журнал доступа к ПДн", async () => {
    mockApi(staff("admin", ADMIN), {
      "GET /api/staff/audit": json(LIST),
      "GET /api/staff/audit/pii": json({
        total: 1,
        items: [
          {
            id: "7",
            at: "2026-09-29T07:00:00.000Z",
            actorKind: "staff",
            actor: { id: ME_ID, name: "Test admin" },
            subjectKind: "request_contact",
            subjectId: REQUEST_ID,
            field: "phone",
            purpose: "staff_reveal",
            reason: "Клиент просит перезвонить",
          },
        ],
      }),
    });
    await mount("/audit");
    await click(button(t.auditTabs.pii));
    expect(calls.at(-1)?.url).toContain("/api/staff/audit/pii");
    expect(text()).toContain("Клиент просит перезвонить");
    expect(window.location.search).toBe("?tab=pii");
  });
});

// ════════════════════════════════════════════════════════════════════════════

describe("команда", () => {
  const TEAM: TeamList = {
    items: [
      {
        id: ME_ID,
        displayName: "Test admin",
        username: "test_admin",
        invitedBy: "telegram",
        role: "admin",
        active: true,
        accepted: true,
        linked: true,
        linkedAt: "2026-09-01T06:00:00.000Z",
        createdAt: "2026-09-01T06:00:00.000Z",
        self: true,
      },
      {
        id: "00000000-0000-0000-0000-00000000a002",
        displayName: "Test manager",
        username: "test_manager",
        invitedBy: "telegram",
        role: "manager",
        active: true,
        accepted: false,
        linked: false,
        linkedAt: null,
        createdAt: "2026-09-01T06:00:00.000Z",
        self: false,
      },
      {
        id: "00000000-0000-0000-0000-00000000a003",
        displayName: "Test phone",
        username: null,
        invitedBy: "phone",
        role: "moderator",
        active: true,
        accepted: true,
        linked: false,
        linkedAt: null,
        createdAt: "2026-09-01T06:00:00.000Z",
        self: false,
      },
    ],
  };
  // Текстовые поля формы приглашения: радиокнопки «Как войдёт» — не они
  const inviteInputs = (form: HTMLFormElement) => [...form.querySelectorAll("input:not([type=radio])")];

  it("себя — без действий; отключение — через подтверждение", async () => {
    mockApi(staff("admin", ADMIN), {
      "GET /api/staff/team": json(TEAM),
      "POST /api/staff/team/00000000-0000-0000-0000-00000000a002/deactivate": json({
        items: [TEAM.items[0], { ...TEAM.items[1], active: false }],
      }),
    });
    await mount("/team");
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows[0]?.textContent).toContain(t.you);
    expect(rows[0]?.querySelector("button")).toBeNull();
    expect(rows[1]?.textContent).toContain(t.memberPending);
    // Приглашённый по телефону: номера в списке нет, приглашение уже принято
    expect(rows[2]?.textContent).toContain(t.invitedByPhone);
    expect(rows[2]?.textContent).toContain(t.memberAccepted);

    // Первая кнопка строки — список ролей (Select набора), отключение — по тексту
    await click([...(rows[1]?.querySelectorAll("button") ?? [])].find((b) => b.textContent === t.deactivate));
    expect(calls.some((c) => c.url.endsWith("/deactivate"))).toBe(false);
    const confirm = container.querySelector(".confirm") as HTMLFormElement;
    await click([...confirm.querySelectorAll("button")].find((b) => b.textContent === t.deactivate));
    expect(lastCall("/deactivate")?.method).toBe("POST");
    expect(text()).toContain(t.memberInactive);
  });

  it("приглашение: имя, имя пользователя Telegram и роль уходят на сервер", async () => {
    mockApi(staff("admin", ADMIN), {
      "GET /api/staff/team": json(TEAM),
      "POST /api/staff/team": json(TEAM, 201),
    });
    await mount("/team");
    const form = container.querySelector("form.fs") as HTMLFormElement;
    const [name, username] = inviteInputs(form);
    await type(name ?? null, "Новый модератор");
    await type(username ?? null, "@new_moderator");
    // Роль — свой список (Select): открыть и выбрать вариант; системного select нет
    expect(form.querySelector("select")).toBeNull();
    await click(form.querySelector("button[aria-haspopup=listbox]") ?? undefined);
    await click(
      [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === t.roles.moderator),
    );
    await click(button(t.invite));
    expect(lastCall("/team")?.body).toEqual({
      displayName: "Новый модератор",
      username: "@new_moderator",
      role: "moderator",
    });
    expect(text()).toContain(t.invited);
  });

  it("приглашение по телефону: номер приводится к +998…, неверный — ошибка у поля без запроса", async () => {
    mockApi(staff("admin", ADMIN), {
      "GET /api/staff/team": json(TEAM),
      "POST /api/staff/team": json(TEAM, 201),
    });
    await mount("/team");
    const form = container.querySelector("form.fs") as HTMLFormElement;
    // Выключенный вход по телефону (API не ответило) — подсказка об этом
    await click(
      [...form.querySelectorAll("label.ui-radio")].find(
        (l) => l.textContent === t.inviteByPhone,
      ) as HTMLElement,
    );
    expect(text()).toContain(t.inviteHintPhoneOff);
    const [name, phone] = inviteInputs(form);
    expect(phone?.getAttribute("type")).toBe("tel");
    await type(name ?? null, "Новый менеджер");
    await type(phone ?? null, "+7 900 123 45 67");
    await click(button(t.invite));
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/team"))).toBe(false);
    expect(form.querySelector(".field-error")?.textContent).toBe(t.fieldErrors.phone);

    await type(phone ?? null, "00 123-45-67");
    await click(button(t.invite));
    expect(lastCall("/team")?.body).toEqual({
      displayName: "Новый менеджер",
      role: "manager",
      phone: "+998001234567",
    });
    expect(text()).toContain(t.invited);
  });

  it("менеджеру раздела нет в навигации", async () => {
    mockApi(staff("manager", MANAGER), { "GET /api/staff/vendors": json({ total: 0, items: [] }) });
    await mount("/vendors");
    const nav = [...container.querySelectorAll(".nav a")].map((a) => a.textContent);
    expect(nav).not.toContain(t.team);
    expect(nav).not.toContain(t.settings);
    expect(nav).not.toContain(t.audit);
  });
});

// ════════════════════════════════════════════════════════════════════════════

describe("настройки", () => {
  const SETTINGS: StaffSettings = {
    items: [
      { key: "sla_hours", value: 12, updatedAt: "2026-09-01T06:00:00.000Z", updatedBy: null },
      { key: "sla_reminder_hours", value: [4, 8], updatedAt: "2026-09-01T06:00:00.000Z", updatedBy: null },
      {
        key: "quiet_hours",
        value: { from: "22:00", to: "08:00" },
        updatedAt: "2026-09-01T06:00:00.000Z",
        updatedBy: null,
      },
    ],
  };

  it("значение уходит числом; ошибка — у этой настройки", async () => {
    mockApi(staff("admin", ADMIN), {
      "GET /api/staff/settings": json(SETTINGS),
      "PUT /api/staff/settings/sla_hours": json(
        { error: { code: "invalid_input", message: "x", details: ["sla_hours"] } },
        422,
      ),
      "PUT /api/staff/settings/sla_reminder_hours": json(SETTINGS),
    });
    await mount("/settings");
    const forms = [...container.querySelectorAll("form.setting")];
    await type(forms[0]?.querySelector("input") ?? null, "6");
    await click(forms[0]?.querySelector("button[type=submit]") ?? undefined);
    expect(lastCall("/sla_hours")?.body).toEqual({ value: 6 });
    expect(forms[0]?.textContent).toContain(t.settingInvalid);

    const [first, second] = [...(forms[1]?.querySelectorAll("input") ?? [])];
    await type(first ?? null, "2");
    await type(second ?? null, "");
    await click(forms[1]?.querySelector("button[type=submit]") ?? undefined);
    expect(lastCall("/sla_reminder_hours")?.body).toEqual({ value: [2] });
    expect(forms[1]?.textContent).toContain(t.saved);

    // Числа — текст с цифровой клавиатурой, тихие часы — свой список времени, не системные
    expect(container.querySelector('input[type="number"], input[type="time"]')).toBeNull();
    expect(forms[0]?.querySelector("input")?.inputMode).toBe("numeric");
    const times = [...(forms[2]?.querySelectorAll("button[aria-haspopup=listbox]") ?? [])];
    expect(times.map((b) => b.textContent)).toEqual(["22:00", "08:00"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════

describe("правки карточек", () => {
  const EMPTY_LISTINGS: ListingList = {
    total: 0,
    items: [],
    counts: { lead: 0, draft: 0, review: 0, active: 0, suspended: 0, rejected: 0 },
  };
  const REVISION: RevisionDetail = {
    id: REVISION_ID,
    status: "pending",
    submittedAt: "2026-09-29T06:00:00.000Z",
    decidedAt: null,
    listing: { id: LISTING_ID, name: "Oqsaroy Hall", status: "active" },
    vendor: { id: VENDOR_ID, code: "V101", name: "Oqsaroy" },
    proposedBy: { kind: "partner", name: null },
    fields: ["name", "priceFromUzs"],
    stale: true,
    changes: [
      { field: "name", before: "Oqsaroy Hall", after: "Oqsaroy Grand" },
      { field: "priceFromUzs", before: 150000, after: 180000 },
    ],
    valid: true,
    decisionReason: null,
    decidedBy: null,
  };

  it("очередь в модерации — правки со ссылкой на сравнение", async () => {
    const list: RevisionList = { total: 1, items: [REVISION] };
    mockApi(staff("moderator", MODERATOR), {
      "GET /api/staff/listings": json({
        total: 0,
        items: [],
        counts: { lead: 0, draft: 0, review: 0, active: 0, suspended: 0, rejected: 0 },
      }),
      "GET /api/staff/revisions": json(list),
    });
    await mount("/moderation");
    expect(container.querySelector(`a[href="/revisions/${REVISION_ID}"]`)?.textContent).toBe("Oqsaroy Hall");
    expect(text()).toContain(t.revisionStale);
    expect(text()).toContain(t.proposedBy("partner", null));
    // Новых фото нет — пустая очередь словами
    expect(text()).toContain(t.photoQueueEmpty);
  });

  it("правку предложил менеджер — в очереди и в сравнении видно кто", async () => {
    const byStaff: RevisionDetail = { ...REVISION, proposedBy: { kind: "staff", name: "Test manager" } };
    mockApi(staff("moderator", MODERATOR), {
      "GET /api/staff/listings": json(EMPTY_LISTINGS),
      "GET /api/staff/revisions": json({ total: 1, items: [byStaff] } satisfies RevisionList),
      [`GET /api/staff/revisions/${REVISION_ID}`]: json(byStaff),
    });
    await mount("/moderation");
    expect(text()).toContain(t.proposedBy("staff", "Test manager"));
    act(() => root.unmount());
    container.remove();

    await mount(`/revisions/${REVISION_ID}`);
    expect(text()).toContain(t.proposedBy("staff", "Test manager"));
    expect(container.querySelector("thead")?.textContent).toContain(t.revisionProposed.staff);
  });

  it("новые фото: опубликованные карточки с фото на решении — ссылка на карточку и сколько ждут", async () => {
    const PHOTO_LISTING_ID = "bbbbbbbb-0000-0000-0000-000000000002";
    const queue: ListingList = {
      total: 1,
      items: [
        {
          id: PHOTO_LISTING_ID,
          name: "Lola zali",
          status: "active",
          slug: "lola",
          districtCode: null,
          priceFromUzs: 150000,
          priceUnit: "per_guest",
          capMax: 200,
          updatedAt: "2026-09-29T06:00:00.000Z",
          blockers: [],
          statusReason: null,
          capMin: 20,
          submittedAt: null,
          vendor: { id: VENDOR_ID, code: "V102", name: "Lola" },
          photos: { ready: 6, approved: 4, pending: 2 },
        },
      ],
      counts: EMPTY_LISTINGS.counts,
    };
    mockApi(staff("moderator", MODERATOR), {
      // Очередь фото — свой запрос; карточки на проверке — остальные запросы списка
      "GET /api/staff/listings?photos=pending&limit=100": json(queue),
      "GET /api/staff/listings": json(EMPTY_LISTINGS),
      "GET /api/staff/revisions": json({ total: 0, items: [] } satisfies RevisionList),
    });
    await mount("/moderation");
    expect(calls.some((c) => c.url === "/api/staff/listings?photos=pending&limit=100")).toBe(true);
    const section = container.querySelector("section[aria-labelledby=photo-queue-title]");
    expect(section?.querySelector("h2")?.textContent).toBe(t.photoQueue);
    expect(section?.querySelector(`a[href="/listings/${PHOTO_LISTING_ID}"]`)?.textContent).toBe("Lola zali");
    expect(section?.textContent).toContain(t.pendingPhotos(2));
    expect(section?.textContent).toContain("Lola · V102");
    // Остальные очереди пусты
    expect(text()).toContain(t.moderationEmpty);
    expect(text()).toContain(t.revisionsEmpty);
  });

  it("сравнение «сейчас / предлагает»; отклонить — только с причиной", async () => {
    mockApi(staff("moderator", MODERATOR), {
      [`GET /api/staff/revisions/${REVISION_ID}`]: json(REVISION),
      [`POST /api/staff/revisions/${REVISION_ID}/decline`]: json({
        ...REVISION,
        status: "declined",
        decisionReason: "Не совпадает с вывеской",
        decidedBy: "Test moderator",
        decidedAt: "2026-09-29T07:00:00.000Z",
      }),
    });
    await mount(`/revisions/${REVISION_ID}`);
    const rows = [...container.querySelectorAll("tbody tr")].map((r) => r.textContent);
    expect(rows[0]).toContain("Oqsaroy Hall");
    expect(rows[0]).toContain("Oqsaroy Grand");
    expect(rows[1]).toMatch(/180\s000 сум/);

    await click(button(t.revisionDecline));
    const form = container.querySelector(".confirm") as HTMLFormElement;
    const submit = [...form.querySelectorAll("button")].find((b) => b.textContent === t.revisionDecline);
    expect(submit?.disabled).toBe(true);
    await type(form.querySelector("textarea"), "Не совпадает с вывеской");
    await click(submit);
    expect(lastCall("/decline")?.body).toEqual({ reason: "Не совпадает с вывеской" });
    expect(text()).toContain(t.revisionStatus.declined);
    expect(button(t.revisionApprove)).toBeUndefined();
  });

  it("правка не проходит проверку — «Одобрить» неактивна", async () => {
    mockApi(staff("moderator", MODERATOR), {
      [`GET /api/staff/revisions/${REVISION_ID}`]: json({ ...REVISION, valid: false }),
    });
    await mount(`/revisions/${REVISION_ID}`);
    expect(button(t.revisionApprove)?.disabled).toBe(true);
    expect(text()).toContain(t.revisionInvalid);
  });
});
