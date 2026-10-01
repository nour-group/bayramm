// @vitest-environment jsdom
import { ConnectivityProvider } from "@bayramm/ui/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vendorDict } from "./i18n";
import { Lazy, type Part, SCREENS } from "./screens";

// Раздел из своей части сборки: загрузка, отказ без сети с повтором, затем сам раздел
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const t = vendorDict.ru;

/** Часть сборки, которая грузится по команде теста: fail — отказ (нет связи), ok — модуль */
function controlled() {
  let value: string | undefined;
  let attempts = 0;
  let settle: { ok(): void; fail(): void } = { ok() {}, fail() {} };
  const part: Part<string> = {
    peek: () => value,
    load: () => {
      attempts += 1;
      return new Promise<string>((resolve, reject) => {
        settle = {
          ok() {
            value = "раздел";
            resolve(value);
          },
          fail: () => reject(new TypeError("Failed to fetch dynamically imported module")),
        };
      });
    },
  };
  return { part, settle: () => settle, attempts: () => attempts };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (part: Part<string>) =>
  act(async () =>
    root.render(
      <ConnectivityProvider>
        <Lazy part={part} t={t}>
          {(text) => <h1>{text}</h1>}
        </Lazy>
      </ConnectivityProvider>,
    ),
  );

describe("Lazy: раздел из своей части сборки", () => {
  it("пока грузится — «Загрузка…», затем раздел", async () => {
    const piece = controlled();
    await render(piece.part);
    expect(container.textContent).toBe(t.loading);
    await act(async () => piece.settle().ok());
    expect(container.querySelector("h1")?.textContent).toBe("раздел");
  });

  it("не загрузилось — ошибка с «Повторить»; повтор грузит снова", async () => {
    const piece = controlled();
    await render(piece.part);
    await act(async () => piece.settle().fail());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(t.loadFailed);
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === t.retry);
    await act(async () => retry?.click());
    expect(piece.attempts()).toBe(2);
    await act(async () => piece.settle().ok());
    expect(container.querySelector("h1")?.textContent).toBe("раздел");
  });

  it("связь вернулась — раздел грузится сам", async () => {
    const piece = controlled();
    await render(piece.part);
    await act(async () => piece.settle().fail());
    await act(async () => void window.dispatchEvent(new Event("offline")));
    await act(async () => void window.dispatchEvent(new Event("online")));
    expect(piece.attempts()).toBe(2);
  });

  it("загруженный раздел отдаётся сразу, без «Загрузка…»", async () => {
    // test-setup.ts загрузил все разделы заранее
    expect(SCREENS.calendar.peek()).toBeDefined();
    await act(async () =>
      root.render(
        <ConnectivityProvider>
          <Lazy part={SCREENS.calendar} t={t}>
            {(module) => <h1>{typeof module.Calendar}</h1>}
          </Lazy>
        </ConnectivityProvider>,
      ),
    );
    expect(container.querySelector("h1")?.textContent).toBe("function");
  });
});
