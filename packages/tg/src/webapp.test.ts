import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getWebApp,
  launchedFromTelegram,
  loadTelegramWebApp,
  SDK_STATE_ATTR,
  TELEGRAM_WEB_APP_SCRIPT,
} from "./webapp";

const webApp = { initData: "query_id=1&hash=abc", initDataUnsafe: { start_param: "vendor_zal-1" } };

describe("getWebApp", () => {
  it("внутри Telegram отдаёт SDK", () => {
    expect(getWebApp({ Telegram: { WebApp: webApp } })).toBe(webApp);
  });

  it("обычный браузер, старый клиент или пустая initData — null", () => {
    expect(getWebApp({})).toBeNull();
    expect(getWebApp(undefined)).toBeNull();
    expect(getWebApp({ Telegram: {} })).toBeNull();
    expect(getWebApp({ Telegram: { WebApp: { ...webApp, initData: "" } } })).toBeNull();
    expect(getWebApp({ Telegram: { WebApp: { initData: 42, initDataUnsafe: {} } } })).toBeNull();
    expect(getWebApp({ Telegram: { WebApp: { initData: "x" } } })).toBeNull();
  });

  it("без аргумента смотрит в globalThis", () => {
    expect(getWebApp()).toBeNull();
  });
});

/* Окно браузера без DOM: адрес, sessionStorage и document, который только
   запоминает добавленные скрипты и позволяет «загрузить» их вручную */
function fakeWindow(url: { hash?: string; search?: string } = {}, stored: string | null = null) {
  const scripts: { src: string; fire(type: "load" | "error"): void }[] = [];
  const win: Record<string, unknown> = {
    location: { hash: url.hash ?? "", search: url.search ?? "" },
    sessionStorage: { getItem: (key: string) => (key === "__telegram__initParams" ? stored : null) },
    document: {
      head: { append: (script: (typeof scripts)[number]) => scripts.push(script) },
      createElement: () => {
        const listeners: Record<string, () => void> = {};
        return {
          src: "",
          addEventListener: (type: string, listener: () => void) => {
            listeners[type] = listener;
          },
          fire: (type: "load" | "error") => listeners[type]?.(),
        };
      },
    },
  };
  const loadSdk = () => Object.assign(win, { Telegram: { WebApp: webApp } });
  return { win, scripts, loadSdk };
}

describe("launchedFromTelegram", () => {
  it("по параметрам запуска в адресе или по сохранённым SDK", () => {
    const launched = (hash: string, search = "", stored: string | null = null) =>
      launchedFromTelegram(fakeWindow({ hash, search }, stored).win);
    expect(launched("#tgWebAppData=query_id%3D1&tgWebAppVersion=8.0")).toBe(true);
    expect(launched("", "?tgWebAppStartParam=x")).toBe(true);
    expect(launched("#section", "?utm=1")).toBe(false);
    expect(launched("", "", "{}")).toBe(true);
  });

  it("запрещённое хранилище и не-окно — не Telegram", () => {
    const denied = {
      location: { hash: "", search: "" },
      sessionStorage: {
        getItem: () => {
          throw new Error("SecurityError");
        },
      },
    };
    expect(launchedFromTelegram(denied)).toBe(false);
    expect(launchedFromTelegram(undefined)).toBe(false);
  });
});

describe("loadTelegramWebApp", () => {
  afterEach(() => vi.useRealTimers());

  it("обычный браузер — null, чужой скрипт не грузится", async () => {
    const { win, scripts } = fakeWindow({ hash: "#top" });
    expect(await loadTelegramWebApp(win)).toBeNull();
    expect(scripts).toHaveLength(0);
  });

  it("SDK уже есть — сразу, без загрузки", async () => {
    const { win, scripts, loadSdk } = fakeWindow();
    loadSdk();
    expect(await loadTelegramWebApp(win)).toBe(webApp);
    expect(scripts).toHaveLength(0);
  });

  it("открыто из Telegram — один скрипт с telegram.org на все вызовы; после загрузки — SDK", async () => {
    const { win, scripts, loadSdk } = fakeWindow({ hash: "#tgWebAppData=x&tgWebAppVersion=8.0" });
    const first = loadTelegramWebApp(win);
    const second = loadTelegramWebApp(win);
    expect(scripts.map((s) => s.src)).toEqual([TELEGRAM_WEB_APP_SCRIPT]);
    loadSdk();
    scripts[0]?.fire("load");
    expect(await first).toBe(webApp);
    expect(await second).toBe(webApp);
  });

  it("скрипт не загрузился — null, следующий вызов пробует снова", async () => {
    const { win, scripts } = fakeWindow({ hash: "#tgWebAppData=x" });
    const attempt = loadTelegramWebApp(win);
    scripts[0]?.fire("error");
    expect(await attempt).toBeNull();
    void loadTelegramWebApp(win);
    expect(scripts).toHaveLength(2);
  });

  it("нет ответа дольше срока — null; опоздавший load старой попытки не мешает новой", async () => {
    vi.useFakeTimers();
    const { win, scripts } = fakeWindow({ hash: "#tgWebAppData=x" });
    const attempt = loadTelegramWebApp(win, 1_000);
    vi.advanceTimersByTime(1_000);
    expect(await attempt).toBeNull();
    const retry = loadTelegramWebApp(win, 1_000);
    scripts[0]?.fire("load");
    expect(loadTelegramWebApp(win, 1_000)).toBe(retry);
    expect(scripts).toHaveLength(2);
  });
});

/* Окно с настоящим «документом»: querySelector находит тег по адресу, как в браузере, а у тега
   есть атрибуты и remove(). Тег, который уже поставил public/boot.js, — параметр state */
function domWindow(state: "loading" | "loaded" | "failed" | null = null) {
  interface Tag {
    src: string;
    attrs: Map<string, string>;
    listeners: Record<string, () => void>;
    removed: boolean;
    addEventListener(type: string, listener: () => void): void;
    getAttribute(name: string): string | null;
    remove(): void;
    fire(type: "load" | "error"): void;
  }
  const tags: Tag[] = [];
  const make = (): Tag => {
    const tag: Tag = {
      src: "",
      attrs: new Map(),
      listeners: {},
      removed: false,
      addEventListener(type, listener) {
        tag.listeners[type] = listener;
      },
      getAttribute: (name) => tag.attrs.get(name) ?? null,
      remove() {
        tag.removed = true;
      },
      fire(type) {
        tag.listeners[type]?.();
      },
    };
    return tag;
  };
  const win: Record<string, unknown> = {
    location: { hash: "#tgWebAppData=x&tgWebAppVersion=8.0", search: "" },
    sessionStorage: { getItem: () => null },
    document: {
      head: { append: (tag: Tag) => tags.push(tag) },
      createElement: make,
      querySelector: (selector: string) =>
        selector === `script[src="${TELEGRAM_WEB_APP_SCRIPT}"]`
          ? (tags.find((tag) => !tag.removed && tag.src === TELEGRAM_WEB_APP_SCRIPT) ?? null)
          : null,
    },
  };
  if (state !== null) {
    const boot = make();
    boot.src = TELEGRAM_WEB_APP_SCRIPT;
    if (state !== "loading") boot.attrs.set(SDK_STATE_ATTR, state);
    tags.push(boot);
  }
  const loadSdk = () => Object.assign(win, { Telegram: { WebApp: webApp } });
  return { win, tags, loadSdk };
}

describe("loadTelegramWebApp: тег, который поставил boot.js", () => {
  afterEach(() => vi.useRealTimers());

  it("скрипт ещё в пути — ждём его же, второго тега нет", async () => {
    const { win, tags, loadSdk } = domWindow("loading");
    const first = loadTelegramWebApp(win);
    const second = loadTelegramWebApp(win);
    expect(tags).toHaveLength(1);
    loadSdk();
    tags[0]?.fire("load");
    expect(await first).toBe(webApp);
    expect(await second).toBe(webApp);
    expect(tags).toHaveLength(1);
  });

  it("скрипт уже выполнился, а SDK без initData — открыто не из Telegram: null сразу, без ожидания срока", async () => {
    const { win, tags } = domWindow("loaded");
    expect(await loadTelegramWebApp(win)).toBeNull();
    expect(tags).toHaveLength(1);
  });

  it("скрипт уже выполнился и SDK есть — он и отдаётся", async () => {
    const { win, tags, loadSdk } = domWindow("loaded");
    loadSdk();
    expect(await loadTelegramWebApp(win)).toBe(webApp);
    expect(tags).toHaveLength(1);
  });

  it("упал ещё до нас (data-state=failed) — тег убираем и пробуем новым", async () => {
    const { win, tags } = domWindow("failed");
    const attempt = loadTelegramWebApp(win);
    expect(tags).toHaveLength(2);
    expect(tags[0]?.removed).toBe(true);
    expect(tags[1]?.src).toBe(TELEGRAM_WEB_APP_SCRIPT);
    tags[1]?.fire("error");
    expect(await attempt).toBeNull();
  });

  it("упал при нас — тег убран, следующий вызов добавляет свежий", async () => {
    const { win, tags } = domWindow("loading");
    const attempt = loadTelegramWebApp(win);
    tags[0]?.fire("error");
    expect(await attempt).toBeNull();
    expect(tags[0]?.removed).toBe(true);
    void loadTelegramWebApp(win);
    expect(tags).toHaveLength(2);
  });

  it("срок вышел, а тег не упал — следующий вызов ждёт его же, а не добавляет ещё один", async () => {
    vi.useFakeTimers();
    const { win, tags, loadSdk } = domWindow("loading");
    const attempt = loadTelegramWebApp(win, 1_000);
    vi.advanceTimersByTime(1_000);
    expect(await attempt).toBeNull();
    const retry = loadTelegramWebApp(win, 1_000);
    expect(tags).toHaveLength(1);
    loadSdk();
    tags[0]?.fire("load");
    expect(await retry).toBe(webApp);
  });

  it("без boot.js — как прежде: свой тег, один на все вызовы", async () => {
    const { win, tags, loadSdk } = domWindow(null);
    const first = loadTelegramWebApp(win);
    void loadTelegramWebApp(win);
    expect(tags.map((tag) => tag.src)).toEqual([TELEGRAM_WEB_APP_SCRIPT]);
    loadSdk();
    tags[0]?.fire("load");
    expect(await first).toBe(webApp);
  });
});
