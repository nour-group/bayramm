/* Обвязка тестов набора: react-dom/client и act, без сторонних библиотек (как в apps/*). */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type UiTexts, UiTextsProvider } from "../texts";

// React ждёт этот флаг, чтобы act() дожидался эффектов
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

export const TEXTS: UiTexts = { close: "Закрыть", clear: "Очистить" };

let mounted: { root: Root; container: HTMLElement } | null = null;

export function render(node: ReactNode): HTMLElement {
  cleanup();
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  act(() => root.render(<UiTextsProvider texts={TEXTS}>{node}</UiTextsProvider>));
  return container;
}

export function cleanup(): void {
  if (!mounted) return;
  const { root, container } = mounted;
  act(() => root.unmount());
  container.remove();
  mounted = null;
  document.body.replaceChildren();
  document.documentElement.className = "";
}

export function click(target: Element | null | undefined): void {
  if (!target) throw new Error("нет элемента для нажатия");
  act(() => (target as HTMLElement).click());
}

export function press(target: Element | null | undefined, key: string, init: KeyboardEventInit = {}): void {
  if (!target) throw new Error("нет элемента для клавиши");
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

export function mouseDown(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
}

/** Ввод как у человека: React видит событие input */
export function type(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Имя по aria-labelledby: тексты указанных элементов через пробел */
export function labelledBy(element: Element | null): string {
  const ids = element?.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ");
}

/** Ширина окна: уже 560px — шторка, шире — панель у поля */
export function setViewport(width: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
}

/** Каждый вызов focus() записывается вместе с параметрами */
export function spyFocus(): { calls: { element: HTMLElement; options: FocusOptions | undefined }[] } {
  const calls: { element: HTMLElement; options: FocusOptions | undefined }[] = [];
  const original = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function focus(this: HTMLElement, options?: FocusOptions) {
    calls.push({ element: this, options });
    original.call(this, options);
  };
  spies.push(() => {
    HTMLElement.prototype.focus = original;
  });
  return { calls };
}

const spies: (() => void)[] = [];

export function restoreSpies(): void {
  for (const restore of spies.splice(0)) restore();
}
