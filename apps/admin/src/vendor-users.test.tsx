// @vitest-environment jsdom
// Вход в кабинет вендора (pages/VendorUsers.tsx): приглашение с ролью и языком, статус и
// уведомления словами, правка, текст приглашения для партнёра, «убрать из кабинета». API —
// подменённый fetch; проверяем, что уходит на сервер и что видит сотрудник.
import type { AuthMethods } from "@bayramm/shared/api/account";
import type { StaffDictionaries, StaffMe, VendorDetail, VendorUser } from "@bayramm/shared/api/staff";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { tokenStore } from "./session";
import { apiErrorText, t } from "./texts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TOKEN = "T".repeat(43);
const VENDOR_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const OWNER_ID = "aaaaaaaa-0000-0000-0000-000000000011";
const MEMBER_ID = "aaaaaaaa-0000-0000-0000-000000000012";
const AT = "2026-09-29T06:00:00.000Z";

const staff = (permissions: StaffMe["permissions"]): StaffMe => ({
  id: "00000000-0000-0000-0000-00000000a002",
  role: "manager",
  displayName: "Test manager",
  username: null,
  permissions,
  botLinked: true,
});
const MANAGER = staff(["catalog.read", "vendors.write", "vendor_users.write", "vendor_phones.read"]);

const DICT: StaffDictionaries = {
  categories: [{ code: "hall", nameRu: "Тойхона", nameUz: "Toʻyxona", enabled: true }],
  districts: [],
  occasions: [],
  staff: [],
  settings: { minPhotos: 3, maxPhotos: 10, slaHours: 12 },
};

const METHODS: AuthMethods = {
  telegram: { bot: "bayramm_test_bot", loginDomain: null },
  phone: true,
  turnstileSiteKey: null,
  apps: { web: "https://web.example", vendor: "https://vendor.example", admin: "https://admin.example" },
};

const user = (patch: Partial<VendorUser> = {}): VendorUser => ({
  id: OWNER_ID,
  fullName: "Kamola",
  role: "owner",
  locale: "uz",
  status: "accepted",
  telegramLinked: true,
  telegramLinkedAt: AT,
  notifiable: true,
  accountLinked: true,
  lastLoginAt: AT,
  disabledAt: null,
  createdAt: AT,
  ...patch,
});

const mark = { done: false, at: null, by: null };
const vendor = (users: VendorUser[]): VendorDetail => ({
  id: VENDOR_ID,
  code: "V101",
  name: "Lola",
  legalForm: "ooo",
  contractNo: null,
  manager: null,
  createdAt: AT,
  updatedAt: AT,
  contacts: {
    legalName: null,
    stir: null,
    legalAddress: null,
    contactPerson: null,
    contactRole: null,
    telegramUsername: null,
  },
  checklist: { contract: mark, stir: mark, contacts: mark, pdConsent: mark },
  users,
  listings: [],
  deleteBlocker: null,
});

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
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

function mockApi(me: StaffMe, detail: VendorDetail, handlers: Record<string, Handler> = {}) {
  window.sessionStorage.setItem("bayramm.admin.session", TOKEN);
  const all: Record<string, Handler> = {
    "GET /api/staff/me": json(me),
    "GET /api/staff/dictionaries": json(DICT),
    "GET /api/auth/methods": json(METHODS),
    [`GET /api/staff/vendors/${VENDOR_ID}`]: json(detail),
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

async function mount() {
  window.history.replaceState(null, "", `/vendors/${VENDOR_ID}`);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
  await settle();
}

const panel = () => document.getElementById("users-title")?.closest("section") as HTMLElement;
const text = () => panel().textContent ?? "";
const buttons = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll("button")].filter((b) => b.textContent?.trim() === name);
const button = (scope: ParentNode, name: string) => buttons(scope, name)[0];
const radio = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll<HTMLLabelElement>("label.ui-radio")]
    .find((l) => l.textContent?.startsWith(label))
    ?.querySelector("input") as HTMLInputElement | undefined;
const invite = () => panel().querySelector<HTMLFormElement>(".vuser-invite") as HTMLFormElement;
const inputLabelled = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll<HTMLInputElement>("input")].find((i) => i.labels?.[0]?.textContent === label);

async function click(element: Element | null | undefined) {
  await act(async () => (element as HTMLElement | null | undefined)?.click());
  await settle();
}

async function type(input: HTMLInputElement | undefined, value: string) {
  if (!input) throw new Error("нет поля");
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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

describe("приглашение в кабинет", () => {
  it("роль выбирают явно; номер — к виду +998…; на сервер — телефон, роль, язык и имя", async () => {
    const invited = user({
      id: MEMBER_ID,
      fullName: "Dilshod",
      role: "member",
      locale: "ru",
      status: "pending",
      telegramLinked: false,
      telegramLinkedAt: null,
      notifiable: false,
      accountLinked: false,
      lastLoginAt: null,
    });
    mockApi(MANAGER, vendor([user()]), {
      [`POST /api/staff/vendors/${VENDOR_ID}/users`]: json(invited, 201),
    });
    await mount();

    await type(inputLabelled(invite(), t.userName), "  Dilshod ");
    await type(inputLabelled(invite(), t.userPhone), "90 111-22-33");
    await click(button(invite(), t.vuInvite));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(invite().textContent).toContain(t.vuRoleRequired);

    await click(radio(invite(), t.vuRoles.member));
    expect(invite().textContent).toContain(t.vuRoleHints.member);
    await click(radio(invite(), t.vuLocales.ru));
    await click(button(invite(), t.vuInvite));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      phone: "+998901112233",
      role: "member",
      locale: "ru",
      fullName: "Dilshod",
    });
    expect(invite().textContent).toContain(t.vuInvited);
    expect(text()).toContain("Dilshod");
    expect(text()).toContain(t.vuStatus.pending);
    expect(text()).toContain(t.vuRoles.member);
    // Форма очищена: следующего снова выбирают с ролью явно
    expect(radio(invite(), t.vuRoles.member)?.checked).toBe(false);
  });

  it("номер не узбекский — запроса нет, ошибка у поля", async () => {
    mockApi(MANAGER, vendor([user()]));
    await mount();
    await type(inputLabelled(invite(), t.userPhone), "+7 912 000 00 00");
    await click(radio(invite(), t.vuRoles.owner));
    await click(button(invite(), t.vuInvite));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(invite().querySelector(".field-error")?.textContent).toBe(t.fieldErrors.phone);
  });

  it("владельца нет — первым приглашают его: сотрудника площадки не выбрать", async () => {
    mockApi(MANAGER, vendor([]), {
      [`POST /api/staff/vendors/${VENDOR_ID}/users`]: json(user({ status: "pending" }), 201),
    });
    await mount();
    expect(text()).toContain(t.usersEmpty);
    expect(radio(invite(), t.vuRoles.member)?.disabled).toBe(true);
    expect(radio(invite(), t.vuRoles.owner)?.checked).toBe(true);
    expect(invite().textContent).toContain(t.vuOwnerFirst);
    await type(inputLabelled(invite(), t.userPhone), "+998 90 111 22 33");
    await click(button(invite(), t.vuInvite));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      phone: "+998901112233",
      role: "owner",
      locale: "uz",
    });
  });

  it("номер уже подтверждён у аккаунта — «доступ открыт сразу»; отказ сервера — словами", async () => {
    mockApi(MANAGER, vendor([user()]), {
      [`POST /api/staff/vendors/${VENDOR_ID}/users`]: json({ error: { code: "vendor_user_exists" } }, 409),
    });
    await mount();
    await type(inputLabelled(invite(), t.userPhone), "901112233");
    await click(radio(invite(), t.vuRoles.owner));
    await click(button(invite(), t.vuInvite));
    expect(invite().textContent).toContain(apiErrorText("vendor_user_exists"));

    vi.unstubAllGlobals();
    act(() => root.unmount());
    container.remove();
    mockApi(MANAGER, vendor([user()]), {
      [`POST /api/staff/vendors/${VENDOR_ID}/users`]: json(user({ id: MEMBER_ID, role: "member" }), 201),
    });
    await mount();
    await type(inputLabelled(invite(), t.userPhone), "901112233");
    await click(radio(invite(), t.vuRoles.member));
    await click(button(invite(), t.vuInvite));
    expect(invite().textContent).toContain(t.vuInvitedAccepted);
  });

  it("без права на пользователей кабинета — ни приглашения, ни действий", async () => {
    mockApi(staff(["catalog.read", "vendor_phones.read"]), vendor([user()]));
    await mount();
    expect(text()).toContain("Kamola");
    expect(panel().querySelector(".vuser-invite")).toBeNull();
    expect(button(panel(), t.vuRemove)).toBeUndefined();
    expect(button(panel(), t.show)).toBeDefined();
  });
});

describe("пользователь кабинета", () => {
  it("роль, статус, доходят ли уведомления, последний вход и язык — словами", async () => {
    mockApi(
      MANAGER,
      vendor([
        user(),
        user({ id: MEMBER_ID, fullName: null, role: "member", notifiable: false, lastLoginAt: null }),
      ]),
    );
    await mount();
    const [owner, member] = [...panel().querySelectorAll(".vuser")];
    expect(owner?.textContent).toContain(t.vuRoles.owner);
    expect(owner?.textContent).toContain(t.vuStatus.accepted);
    expect(owner?.textContent).toContain(t.vuNotifiable);
    expect(owner?.textContent).toContain("Последний вход:");
    expect(owner?.textContent).toContain(t.vuLocaleLine(t.vuLocales.uz));
    expect(member?.textContent).toContain(t.vuNoName);
    expect(member?.textContent).toContain(`${t.vuNotNotifiable} — ${t.vuOpenBot}`);
    expect(member?.textContent).toContain(t.vuNeverLoggedIn);
    // Вход есть — его можно отвязать; у ждущего входа — нечего
    expect(buttons(panel(), t.vuUnlink)).toHaveLength(2);
  });

  it("изменить: на сервер — только изменённое; последнего владельца сервер не понизит — ответ словами", async () => {
    mockApi(MANAGER, vendor([user(), user({ id: MEMBER_ID, fullName: "Dilshod", role: "member" })]), {
      [`PATCH /api/staff/vendors/${VENDOR_ID}/users/${OWNER_ID}`]: json(
        { error: { code: "vendor_last_owner" } },
        409,
      ),
    });
    await mount();
    const owner = panel().querySelector(".vuser") as HTMLElement;
    await click(button(owner, t.vuEdit));
    const form = owner.querySelector(".vuser-edit") as HTMLElement;
    await click(radio(form, t.vuRoles.member));
    await click(radio(form, t.vuLocales.ru));
    await click(button(form, t.save));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ role: "member", locale: "ru" });
    expect(form.textContent).toContain(apiErrorText("vendor_last_owner"));
  });

  it("убрать из кабинета — после подтверждения; пользователь пропадает из списка", async () => {
    mockApi(MANAGER, vendor([user(), user({ id: MEMBER_ID, fullName: "Dilshod", role: "member" })]), {
      [`DELETE /api/staff/vendors/${VENDOR_ID}/users/${MEMBER_ID}`]: json(null, 204),
    });
    await mount();
    const member = panel().querySelectorAll(".vuser")[1] as HTMLElement;
    await click(button(member, t.vuRemove));
    const dialog = document.querySelector<HTMLElement>("[role=alertdialog]");
    expect(dialog?.textContent).toContain(t.vuRemoveHint);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await click(button(dialog as HTMLElement, t.vuRemove));
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe(
      `/api/staff/vendors/${VENDOR_ID}/users/${MEMBER_ID}`,
    );
    expect(panel().querySelectorAll(".vuser")).toHaveLength(1);
    expect(text()).not.toContain("Dilshod");
  });

  it("скопировать приглашение: на языке партнёра — бот с «Я партнёр» и кабинет со входом", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    mockApi(MANAGER, vendor([user({ status: "pending", accountLinked: false })]));
    await mount();
    await click(button(panel(), t.vuCopy));
    const copied = String((writeText.mock.calls[0] as unknown[] | undefined)?.[0] ?? "");
    expect(copied).toContain("Assalomu alaykum, Kamola!");
    expect(copied).toContain("«Lola»");
    expect(copied).toContain("https://t.me/bayramm_test_bot?start=partner");
    expect(copied).toContain("https://vendor.example/?signin=1&lang=uz");
    expect(text()).toContain(t.vuCopied);
  });

  it("буфера обмена нет — текст в шторке, выделенный для копирования", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    mockApi(MANAGER, vendor([user({ locale: "ru" })]));
    await mount();
    await click(button(panel(), t.vuCopy));
    const area = document.querySelector<HTMLTextAreaElement>(".vuser-copy-text");
    expect(area?.value).toContain("Здравствуйте, Kamola!");
    expect(area?.value).toContain("https://vendor.example/?signin=1&lang=ru");
    expect(document.activeElement).toBe(area);
  });
});

describe("на телефоне", () => {
  it("действия с пользователем — в «Ещё»", async () => {
    vi.stubGlobal("matchMedia", (query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      return {
        matches: max ? 390 <= Number(max[1]) : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
    });
    mockApi(MANAGER, vendor([user()]));
    await mount();
    const card = panel().querySelector(".vuser") as HTMLElement;
    expect(button(card, t.vuRemove)).toBeUndefined();
    await click(card.querySelector(".btn-more"));
    const menu = [...document.querySelectorAll<HTMLElement>(".menu-item")].map((b) => b.textContent);
    expect(menu).toEqual([t.vuEdit, t.vuCopy, t.disable, t.vuUnlink, t.vuRemove]);
  });
});
