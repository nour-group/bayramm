// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";

// React ждёт этот флаг, чтобы act() дожидался эффектов
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

function mount(path: string) {
  window.history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<App />));
}

const heading = () => container.querySelector("h1")?.textContent;
const link = (name: string) =>
  [...container.querySelectorAll("a")].find((a) => a.textContent?.trim() === name) as HTMLAnchorElement;

beforeEach(() => {
  // В jsdom scrollTo не реализован и пишет об этом в консоль
  window.scrollTo = () => {};
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("оболочка панели оператора", () => {
  it("корень открывает вендоров и переписывает адрес", () => {
    mount("/");
    expect(window.location.pathname).toBe("/vendors");
    expect(heading()).toBe("Вендоры");
    expect(link("Вендоры").getAttribute("aria-current")).toBe("page");
  });

  it.each([
    ["Модерация", "/moderation"],
    ["Заявки", "/requests"],
    ["Клиенты", "/clients"],
  ])("переход в «%s» без перезагрузки", (name, path) => {
    mount("/vendors");
    act(() => link(name).click());
    expect(window.location.pathname).toBe(path);
    expect(heading()).toBe(name);
    expect(link(name).getAttribute("aria-current")).toBe("page");
    expect(document.activeElement).toBe(container.querySelector("h1"));
    expect(document.title).toBe(`${name} · Bayramm`);
  });

  it("неизвестный путь — «не найдена» со ссылкой на вендоров", () => {
    mount("/nope");
    expect(heading()).toBe("Страница не найдена");
    expect(link("К вендорам").getAttribute("href")).toBe("/vendors");
  });

  it("есть ссылка «К содержимому» на main", () => {
    mount("/vendors");
    expect(container.querySelector("a.skip")?.getAttribute("href")).toBe("#main");
    expect(container.querySelector("main#main")).not.toBeNull();
  });
});
