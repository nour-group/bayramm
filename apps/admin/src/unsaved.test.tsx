// @vitest-environment jsdom
// Несохранённые правки: уход по ссылке, «назад» браузера и выход спрашивают; без правок и
// сразу после сохранения — не спрашивают; перезагрузка — beforeunload.
import type { StaffDictionaries, StaffMe, VendorDetail, VendorList } from "@bayramm/shared/api/staff";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { tokenStore } from "./session";
import { t } from "./texts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TOKEN = "T".repeat(43);
const VENDOR_ID = "aaaaaaaa-0000-0000-0000-000000000001";

const ADMIN: StaffMe = {
  id: "00000000-0000-0000-0000-00000000a001",
  role: "admin",
  displayName: "Test Admin",
  username: null,
  botLinked: true,
  permissions: ["catalog.read", "vendors.write", "vendor_users.write", "listings.write", "settings.write"],
};

const DICT: StaffDictionaries = {
  categories: [],
  districts: [],
  occasions: [],
  staff: [],
  settings: { minPhotos: 3, maxPhotos: 10, slaHours: 12 },
};

const VENDOR: VendorDetail = {
  id: VENDOR_ID,
  code: "V101",
  name: "Oqsaroy",
  legalForm: "ooo",
  contractNo: null,
  manager: null,
  createdAt: "2026-09-29T06:00:00.000Z",
  updatedAt: "2026-09-29T06:00:00.000Z",
  contacts: {
    legalName: null,
    stir: null,
    legalAddress: null,
    contactPerson: null,
    contactRole: null,
    telegramUsername: null,
  },
  checklist: {
    contract: { done: false, at: null, by: null },
    stir: { done: false, at: null, by: null },
    contacts: { done: false, at: null, by: null },
    pdConsent: { done: false, at: null, by: null },
  },
  users: [],
  listings: [],
  deleteBlocker: null,
};

const LIST: VendorList = { total: 0, items: [] };

let container: HTMLDivElement;
let root: Root;
let calls: string[];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockApi(extra: Record<string, (body: unknown) => Response> = {}) {
  window.sessionStorage.setItem("bayramm.admin.session", TOKEN);
  const handlers: Record<string, (body: unknown) => Response> = {
    "GET /api/staff/me": () => json(ADMIN),
    "GET /api/staff/dictionaries": () => json(DICT),
    "GET /api/staff/vendors": () => json(LIST),
    [`GET /api/staff/vendors/${VENDOR_ID}`]: () => json(VENDOR),
    "POST /api/staff/vendors": () => json(VENDOR, 201),
    [`PATCH /api/staff/vendors/${VENDOR_ID}`]: () => json({ ...VENDOR, name: "Oqsaroy Grand" }),
    "POST /api/auth/logout": () => new Response(null, { status: 204 }),
    ...extra,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const url = String(input);
      calls.push(`${method} ${url}`);
      const key = Object.keys(handlers).find(
        (k) => k === `${method} ${url}` || `${method} ${url}`.startsWith(`${k}?`),
      );
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      return key ? (handlers[key] as (b: unknown) => Response)(body) : new Response("{}", { status: 404 });
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

const navLink = (name: string) =>
  [...document.querySelectorAll<HTMLAnchorElement>("nav a")].find((a) =>
    a.textContent?.startsWith(name),
  ) as HTMLAnchorElement;
const buttonIn = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
const question = () => document.querySelector<HTMLElement>("[role=alertdialog]");
const nameField = () =>
  [...container.querySelectorAll<HTMLInputElement>("input")].find(
    (input) => input.labels?.[0]?.textContent === t.fields.name,
  ) as HTMLInputElement;

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
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

describe("несохранённые правки", () => {
  it("ничего не меняли — переход без вопроса", async () => {
    mockApi();
    await mount("/vendors/new");
    await click(navLink(t.vendors));
    expect(question()).toBeNull();
    expect(window.location.pathname).toBe("/vendors");
  });

  it("вписали и уходят по ссылке — «Уйти без сохранения?»: «Остаться» оставляет вписанное, «Уйти» уводит", async () => {
    mockApi();
    await mount("/vendors/new");
    await type(nameField(), "Navruz");
    await click(navLink(t.vendors));
    const sheet = question();
    expect(sheet?.textContent).toContain(t.unsavedTitle);
    expect(sheet?.textContent).toContain(t.unsavedText);
    expect(window.location.pathname).toBe("/vendors/new");

    await click(buttonIn(sheet as HTMLElement, t.unsavedStay));
    expect(question()).toBeNull();
    expect(window.location.pathname).toBe("/vendors/new");
    expect(nameField().value).toBe("Navruz");

    await click(navLink(t.vendors));
    await click(buttonIn(question() as HTMLElement, t.unsavedLeave));
    expect(window.location.pathname).toBe("/vendors");
    expect(calls).toContain("GET /api/staff/vendors?limit=100");
  });

  it("«назад» браузера с правками — экран остаётся, вопрос; «Уйти» — назад", async () => {
    mockApi();
    await mount("/vendors");
    await click(
      [...container.querySelectorAll<HTMLAnchorElement>("a")].find(
        (a) => a.textContent === t.newVendor,
      ) as HTMLAnchorElement,
    );
    expect(window.location.pathname).toBe("/vendors/new");
    await type(nameField(), "Navruz");

    await act(async () => window.history.back());
    await vi.waitFor(() => expect(question()).not.toBeNull());
    // Адрес — снова экрана с правками, вписанное на месте
    expect(window.location.pathname).toBe("/vendors/new");
    expect(nameField().value).toBe("Navruz");

    await click(buttonIn(question() as HTMLElement, t.unsavedLeave));
    await vi.waitFor(() => expect(window.location.pathname).toBe("/vendors"));
    await settle();
    expect(container.querySelector("h1")?.textContent).toBe(t.vendors);
  });

  it("сохранили — уход без вопроса; новый вендор после «Создать» открывается без вопроса", async () => {
    mockApi();
    await mount("/vendors/new");
    await type(nameField(), "Oqsaroy");
    // Категория первой витрины — свой список: открыть и выбрать
    await click(container.querySelector<HTMLElement>("button[aria-haspopup=listbox]") as HTMLElement);
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (o) => o.textContent === "Кортеж",
      ) as HTMLElement,
    );
    await click(buttonIn(container, t.createVendor));
    expect(question()).toBeNull();
    expect(window.location.pathname).toBe(`/vendors/${VENDOR_ID}`);

    await type(nameField(), "Oqsaroy Grand");
    await click(buttonIn(container, t.save));
    expect(calls).toContain(`PATCH /api/staff/vendors/${VENDOR_ID}`);
    await click(navLink(t.vendors));
    expect(question()).toBeNull();
    expect(window.location.pathname).toBe("/vendors");
  });

  it("перезагрузка и закрытие вкладки с правками — beforeunload; без правок — нет", async () => {
    mockApi();
    await mount("/vendors/new");
    const unload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(false);
    await type(nameField(), "Navruz");
    await settle();
    expect(unload()).toBe(true);
    await type(nameField(), "");
    await settle();
    expect(unload()).toBe(false);
  });

  it("выход с правками — тоже вопрос; «Уйти» — выход", async () => {
    mockApi();
    await mount("/vendors/new");
    await type(nameField(), "Navruz");
    await click(buttonIn(container, t.signOut));
    expect(question()?.textContent).toContain(t.unsavedTitle);
    expect(calls).not.toContain("POST /api/auth/logout");
    await click(buttonIn(question() as HTMLElement, t.unsavedLeave));
    expect(calls).toContain("POST /api/auth/logout");
    expect(container.querySelector("h1")?.textContent).toBe(t.login);
  });

  it("настройка: «Сохранить» — только когда значение изменено, уход с изменённой — вопрос", async () => {
    mockApi({
      "GET /api/staff/settings": () =>
        json({
          items: [{ key: "sla_hours", value: 12, updatedAt: "2026-09-29T06:00:00.000Z", updatedBy: null }],
        }),
    });
    await mount("/settings");
    const save = buttonIn(container, t.save);
    expect(save.disabled).toBe(true);
    const input = container.querySelector<HTMLInputElement>(".setting input") as HTMLInputElement;
    await type(input, "24");
    expect(buttonIn(container, t.save).disabled).toBe(false);
    await click(navLink(t.vendors));
    expect(question()?.textContent).toContain(t.unsavedTitle);
  });
});
