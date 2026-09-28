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
const langButton = (code: string) => container.querySelector(`button[lang="${code}"]`) as HTMLButtonElement;

beforeEach(() => {
  window.localStorage.clear();
  // В jsdom scrollTo не реализован и пишет об этом в консоль
  window.scrollTo = () => {};
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("оболочка кабинета вендора", () => {
  it("корень открывает заявки и переписывает адрес", () => {
    mount("/");
    expect(window.location.pathname).toBe("/requests");
    expect(heading()).toBe("Заявки");
    expect(link("Заявки").getAttribute("aria-current")).toBe("page");
  });

  it("переход по разделу без перезагрузки: адрес, aria-current, фокус на заголовке", () => {
    mount("/requests");
    act(() => link("Календарь").click());
    expect(window.location.pathname).toBe("/calendar");
    expect(heading()).toBe("Календарь");
    expect(link("Календарь").getAttribute("aria-current")).toBe("page");
    expect(link("Заявки").hasAttribute("aria-current")).toBe(false);
    expect(document.activeElement).toBe(container.querySelector("h1"));
  });

  it("назад в браузере возвращает раздел", () => {
    mount("/card");
    act(() => link("Заявки").click());
    act(() => {
      window.history.replaceState(null, "", "/card");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(heading()).toBe("Карточка");
  });

  it("вход — отдельная страница", () => {
    mount("/login");
    expect(heading()).toBe("Вход");
    expect(link("Вход").getAttribute("aria-current")).toBe("page");
  });

  it("неизвестный путь — «не найдена» со ссылкой на заявки", () => {
    mount("/nope");
    expect(heading()).toBe("Страница не найдена");
    expect(link("К заявкам").getAttribute("href")).toBe("/requests");
  });

  it("переключатель языка меняет тексты, lang у документа и запоминает выбор", () => {
    mount("/calendar");
    expect(document.documentElement.lang).toBe("ru");
    expect(langButton("ru").getAttribute("aria-pressed")).toBe("true");

    act(() => langButton("uz").click());
    expect(document.documentElement.lang).toBe("uz");
    expect(heading()).toBe("Taqvim");
    expect(langButton("uz").getAttribute("aria-pressed")).toBe("true");
    expect(langButton("ru").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Kabinet boʻlimlari");
    expect(document.title).toBe("Taqvim · Bayramm");

    act(() => root.unmount());
    container.remove();
    mount("/calendar");
    expect(heading()).toBe("Taqvim");
  });

  it("есть ссылка «К содержимому» на main", () => {
    mount("/requests");
    const skip = container.querySelector("a.skip");
    expect(skip?.getAttribute("href")).toBe("#main");
    expect(container.querySelector("main#main")).not.toBeNull();
  });
});
