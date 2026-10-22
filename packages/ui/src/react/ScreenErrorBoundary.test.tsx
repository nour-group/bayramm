// @vitest-environment jsdom
import { act, type ComponentType, Suspense, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectivityProvider } from "./online";
import { chunkUrlOf, isChunkLoadError, retryableLazy, ScreenErrorBoundary } from "./ScreenErrorBoundary";
import { cleanup, click, render } from "./test/harness";

const TEXTS = { message: "Не удалось загрузить экран", retry: "Повторить" };
const CHUNK_URL = "https://bayramm.uz/assets/Docs-abc123.js";
const chunkError = () => new TypeError(`Failed to fetch dynamically imported module: ${CHUNK_URL}`);

beforeEach(() => {
  // React пишет пойманные границей ошибки в консоль — в тестах это шум
  vi.spyOn(console, "error").mockImplementation(() => {});
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
const alert = () => document.querySelector('[role="alert"].ui-screen-error');
const retryButton = () => alert()?.querySelector("button");

function Docs() {
  return <p id="docs">Документы</p>;
}

/** Загрузчик: сначала отказы (сколько fails), потом модуль */
function flaky(fails: number, error: () => unknown = chunkError) {
  let calls = 0;
  const load = vi.fn(async () => {
    calls += 1;
    if (calls <= fails) throw error();
    return { default: Docs };
  });
  return { load, Screen: retryableLazy(load) };
}

function mount(Screen: ComponentType, props: { reload?: () => void; resetKey?: unknown } = {}) {
  return render(
    <ConnectivityProvider>
      <ScreenErrorBoundary texts={TEXTS} reload={props.reload} resetKey={props.resetKey}>
        <Suspense fallback={<p id="loading">…</p>}>
          <Screen />
        </Suspense>
      </ScreenErrorBoundary>
    </ConnectivityProvider>,
  );
}

const offlineFetch = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 200 })),
  );

describe("ScreenErrorBoundary", () => {
  it("кусок не загрузился — строка и «Повторить» вместо пустого места; повтор грузит заново", async () => {
    offlineFetch();
    const { load, Screen } = flaky(1);
    const root = mount(Screen);
    await flush();
    expect(alert()?.textContent).toContain(TEXTS.message);
    expect(retryButton()?.textContent).toBe(TEXTS.retry);
    expect(root.textContent).not.toBe("");

    click(retryButton());
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(alert()).toBeNull();
    expect(document.getElementById("docs")?.textContent).toBe("Документы");
  });

  it("связь вернулась — повтор сам", async () => {
    offlineFetch();
    const { load, Screen } = flaky(1);
    mount(Screen);
    await flush();
    expect(alert()).not.toBeNull();

    act(() => void window.dispatchEvent(new Event("offline")));
    act(() => void window.dispatchEvent(new Event("online")));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(document.getElementById("docs")).not.toBeNull();
  });

  it("куска нет на сервере (404) — одна перезагрузка, второй раз за минуту — только по «Повторить»", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const reload = vi.fn();

    mount(flaky(5).Screen, { reload });
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(CHUNK_URL, { method: "HEAD", cache: "no-store" });
    expect(reload).toHaveBeenCalledTimes(1);

    // Страница перезагрузилась, а куска всё нет — сами больше не перезагружаем
    cleanup();
    mount(flaky(5).Screen, { reload });
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(alert()).not.toBeNull();
    click(retryButton());
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("кусок есть (сбой сети) — без перезагрузки", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const reload = vi.fn();
    mount(flaky(1).Screen, { reload });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(alert()).not.toBeNull();
  });

  it("ошибка в самом экране — строка с повтором, без проверки куска и перезагрузки", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const reload = vi.fn();
    let broken = true;
    function Broken() {
      if (broken) throw new Error("render failed");
      return <p id="fixed">ok</p>;
    }
    render(
      <ConnectivityProvider>
        <ScreenErrorBoundary texts={TEXTS} reload={reload}>
          <Broken />
        </ScreenErrorBoundary>
      </ConnectivityProvider>,
    );
    await flush();
    expect(alert()).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    broken = false;
    click(retryButton());
    expect(document.getElementById("fixed")).not.toBeNull();
  });

  it("другой экран (resetKey) — ошибка прежнего забыта, кусок грузится заново", async () => {
    offlineFetch();
    const { load, Screen } = flaky(1);
    let go: (key: string) => void = () => {};
    function Host() {
      const [key, setKey] = useState("/docs");
      go = setKey;
      return (
        <ScreenErrorBoundary texts={TEXTS} resetKey={key}>
          <Suspense fallback={null}>
            <Screen />
          </Suspense>
        </ScreenErrorBoundary>
      );
    }
    render(
      <ConnectivityProvider>
        <Host />
      </ConnectivityProvider>,
    );
    await flush();
    expect(alert()).not.toBeNull();
    act(() => go("/profile"));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(alert()).toBeNull();
  });
});

describe("отказ загрузки куска", () => {
  it("узнаёт тексты Chromium, Firefox, Safari и CSS Vite", () => {
    expect(isChunkLoadError(chunkError())).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module: /assets/a.js"))).toBe(
      true,
    );
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/Venue-1.css"))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError("строка")).toBe(false);
  });

  it("адрес куска — из текста ошибки", () => {
    expect(chunkUrlOf(chunkError())).toBe(CHUNK_URL);
    expect(chunkUrlOf(new Error("Unable to preload CSS for /assets/Venue-1.css"))).toBe(
      "/assets/Venue-1.css",
    );
    expect(chunkUrlOf(new TypeError("Importing a module script failed."))).toBeNull();
  });
});
