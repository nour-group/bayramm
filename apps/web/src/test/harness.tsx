import type { ListingDetail } from "@bayramm/shared/api";
import type { TelegramWebApp } from "@bayramm/tg/webapp";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../App";
import { createMockApi, demoListings, type MockOptions } from "../api/mock";
import type { ClientApi } from "../api/types";
import type { Identity, Services } from "../context";

/* Обвязка тестов экранов: настоящий App на jsdom с демо-API и замороженными часами.
   Без сторонних библиотек — react-dom/client и act, как в apps/vendor. */

// React ждёт этот флаг, чтобы act() дожидался эффектов
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** 1 октября 2026, 12:00 по Ташкенту */
export const NOW = Date.parse("2026-10-01T07:00:00Z");
export const TODAY = "2026-10-01";
export const LISTINGS: readonly ListingDetail[] = demoListings(TODAY);

export interface Mounted {
  readonly container: HTMLElement;
  readonly api: ClientApi;
  unmount(): void;
}

export interface MountOptions {
  readonly path?: string;
  readonly identity?: Identity;
  readonly webApp?: TelegramWebApp | null;
  readonly api?: ClientApi;
  readonly mock?: MockOptions;
}

let mounted: { root: Root; container: HTMLElement } | null = null;

export async function mount({
  path = "/",
  identity = "demo",
  webApp = null,
  api,
  mock,
}: MountOptions = {}): Promise<Mounted> {
  window.history.replaceState(null, "", path);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const services: Services = {
    api: api ?? createMockApi({ now: () => NOW, listings: LISTINGS, ...mock }),
    identity,
    webApp,
    mediaEnv: "production",
    now: () => NOW,
  };
  mounted = { root, container };
  await act(async () => root.render(<App services={services} />));
  await settle();
  return {
    container,
    api: services.api,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      mounted = null;
    },
  };
}

export function cleanup(): void {
  if (!mounted) return;
  const { root, container } = mounted;
  act(() => root.unmount());
  container.remove();
  mounted = null;
}

/** Дать отработать промисам демо-API и эффектам React */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Ждать, пока условие не вернёт значение */
export async function waitFor<T>(check: () => T | null | undefined | false, what = "условие"): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = check();
    if (value) return value;
    await settle(1);
  }
  throw new Error(`не дождались: ${what}`);
}

export const text = (root: ParentNode = document.body) => root.textContent ?? "";

/** Все тексты, которые видит или слышит человек: содержимое и подписи */
export function allHumanText(root: ParentNode = document.body): string {
  const attributes = [...root.querySelectorAll("[aria-label],[title],[placeholder],[alt]")].flatMap((el) =>
    ["aria-label", "title", "placeholder", "alt"].map((name) => el.getAttribute(name) ?? ""),
  );
  return [text(root), ...attributes, document.title].join("\n");
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error("нет элемента для нажатия");
  await act(async () => {
    (element as HTMLElement).click();
  });
  await settle();
}

const valueSetter = (element: HTMLElement) => {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, "value")?.set;
};

/** Ввод как у человека: React видит событие input/change */
export async function type(element: Element | null | undefined, value: string): Promise<void> {
  if (!element) throw new Error("нет поля для ввода");
  const field = element as HTMLInputElement;
  await act(async () => {
    valueSetter(field)?.call(field, value);
    field.dispatchEvent(
      new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
  await settle();
}

export const byText = <T extends Element = HTMLElement>(
  selector: string,
  content: string | RegExp,
): T | null =>
  ([...document.querySelectorAll<T>(selector)].find((el) =>
    typeof content === "string" ? el.textContent?.trim() === content : content.test(el.textContent ?? ""),
  ) ?? null) as T | null;

/** Выпадающий список набора: открыть и выбрать вариант по тексту */
export async function choose(trigger: Element | null | undefined, option: string): Promise<void> {
  await click(trigger);
  const item = [...document.querySelectorAll('[role="option"]')].find(
    (o) => o.textContent?.trim() === option,
  );
  if (!item) throw new Error(`нет варианта «${option}»`);
  await click(item);
}

/** Поле даты набора: открыть календарь и нажать день по началу его имени («15 окт») */
export async function pickDate(trigger: Element | null | undefined, day: string): Promise<void> {
  await click(trigger);
  await click(calendarDay(day));
}

/** День календаря по началу имени для диктора: «8 окт» → «8 окт, занято» */
export const calendarDay = (day: string) =>
  document.querySelector<HTMLButtonElement>(`button.ui-cal-day[aria-label^="${day}"]`);

/** Метка поля формы по началу текста подписи → связанный элемент */
export function field(labelStart: string): HTMLInputElement | null {
  const label = [...document.querySelectorAll("label")].find((l) =>
    l.textContent?.trim().startsWith(labelStart),
  );
  const id = label?.getAttribute("for");
  return id ? (document.getElementById(id) as HTMLInputElement | null) : null;
}

/** Поддельный SDK Telegram: всё, что вызвало приложение, пишется в calls */
export function fakeWebApp(overrides: Partial<TelegramWebApp> = {}) {
  const calls: string[] = [];
  const handlers: Record<string, (() => void) | undefined> = {};
  const button = (name: string) => ({
    setText: (value: string) => calls.push(`${name}.setText:${value}`),
    setParams: () => calls.push(`${name}.setParams`),
    show: () => calls.push(`${name}.show`),
    hide: () => calls.push(`${name}.hide`),
    enable: () => calls.push(`${name}.enable`),
    onClick: (handler: () => void) => {
      handlers[name] = handler;
      calls.push(`${name}.onClick`);
    },
    offClick: () => {
      handlers[name] = undefined;
      calls.push(`${name}.offClick`);
    },
  });
  const webApp: TelegramWebApp = {
    initData: "query_id=1&user=%7B%7D&hash=abc",
    initDataUnsafe: { user: { id: 42, first_name: "Aziza", last_name: "K", language_code: "ru" } },
    version: "8.0",
    isVersionAtLeast: (version: string) => Number.parseFloat(version) <= 8,
    MainButton: button("MainButton"),
    BackButton: button("BackButton"),
    ...overrides,
  };
  return { webApp, calls, press: (name: "MainButton" | "BackButton") => handlers[name]?.() };
}
