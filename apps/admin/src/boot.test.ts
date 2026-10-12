// @vitest-environment jsdom
import { runInNewContext } from "node:vm";
import { contentSecurityPolicy } from "@bayramm/edge";
import {
  getWebApp,
  launchedFromTelegram,
  loadTelegramWebApp,
  SDK_STATE_ATTR,
  TELEGRAM_WEB_APP_SCRIPT,
} from "@bayramm/tg/webapp";
import { afterEach, describe, expect, it } from "vitest";
import OTHER_BOOT from "../../vendor/public/boot.js?raw";
import HTML from "../index.html?raw";
import BOOT from "../public/boot.js?raw";

/* public/boot.js открыт из Telegram — заказывает SDK Mini App сразу, до бандла. Его правило
   «открыто из Telegram» обязано совпадать с правилом приложения (getWebApp / launchedFromTelegram,
   по которому loadTelegramWebApp решает, грузить ли SDK): каждый случай прогоняется через оба. */

interface Case {
  readonly name: string;
  readonly url: string;
  readonly session?: Record<string, string>;
  /** SDK уже лежит в window.Telegram (как в сквозных тестах) */
  readonly sdk?: boolean;
  readonly telegram: boolean;
}

const LAUNCH = "#tgWebAppData=query_id%3D1%26user%3D%257B%2522id%2522%253A1%257D&tgWebAppVersion=8.0";

const CASES: readonly Case[] = [
  { name: "обычный браузер — SDK не нужен", url: "/", telegram: false },
  { name: "якорь на странице — не Telegram", url: "/requests#section", telegram: false },
  { name: "параметры запуска в адресе (#tgWebApp…)", url: `/${LAUNCH}`, telegram: true },
  { name: "параметры запуска в query (?tgWebAppStartParam=)", url: "/?tgWebAppStartParam=x", telegram: true },
  {
    name: "перезагрузка Mini App: параметры только в копии SDK во вкладке",
    url: "/",
    session: { __telegram__initParams: "{}" },
    telegram: true,
  },
  { name: "SDK уже в window — второй раз не грузим", url: "/", sdk: true, telegram: true },
];

function setUp(c: Case): void {
  window.history.replaceState(null, "", c.url);
  for (const [key, value] of Object.entries(c.session ?? {})) window.sessionStorage.setItem(key, value);
  Object.defineProperty(window, "Telegram", {
    value: c.sdk ? { WebApp: { initData: "query_id=1&hash=h", initDataUnsafe: {} } } : undefined,
    configurable: true,
    writable: true,
  });
}

/** boot.js в отдельном контексте: window — настоящий jsdom, скрипты ставятся в его <head> */
function runBoot(storage: { sessionStorage: unknown } = { sessionStorage: window.sessionStorage }): void {
  const scope = {
    document,
    location: window.location,
    sessionStorage: storage.sessionStorage,
    Telegram: (window as { Telegram?: unknown }).Telegram,
  };
  runInNewContext(BOOT, { window: scope });
}

const sdkTags = () =>
  [...document.head.querySelectorAll<HTMLScriptElement>("script")].filter(
    (script) => script.getAttribute("src") === TELEGRAM_WEB_APP_SCRIPT,
  );

afterEach(() => {
  window.sessionStorage.clear();
  document.head.replaceChildren();
});

describe("public/boot.js", () => {
  for (const c of CASES) {
    it(c.name, () => {
      setUp(c);
      runBoot();
      // Решение приложения — то же
      expect(getWebApp(window) !== null || launchedFromTelegram(window)).toBe(c.telegram);
      // Тег SDK — только когда открыто из Telegram и SDK ещё нет в окне
      expect(sdkTags()).toHaveLength(c.telegram && !c.sdk ? 1 : 0);
    });
  }

  it("тег: адрес из CSP, async, в <head>; второй запуск тега не добавляет", () => {
    setUp(CASES[2] as Case);
    runBoot();
    runBoot();
    const [tag] = sdkTags();
    expect(sdkTags()).toHaveLength(1);
    expect(tag?.async).toBe(true);
    expect(tag?.parentElement).toBe(document.head);
    expect(BOOT).toContain(`"${TELEGRAM_WEB_APP_SCRIPT}"`);
    expect(contentSecurityPolicy({ telegramWebApp: true })).toContain(TELEGRAM_WEB_APP_SCRIPT);
  });

  it("loadTelegramWebApp ждёт этот же тег и не добавляет второй", async () => {
    setUp(CASES[2] as Case);
    runBoot();
    const attempt = loadTelegramWebApp(window);
    expect(sdkTags()).toHaveLength(1);
    Object.defineProperty(window, "Telegram", {
      value: { WebApp: { initData: "query_id=1&hash=h", initDataUnsafe: {} } },
      configurable: true,
      writable: true,
    });
    sdkTags()[0]?.dispatchEvent(new Event("load"));
    expect(await attempt).not.toBeNull();
    expect(sdkTags()).toHaveLength(1);
  });

  it("SDK не загрузился: тег помечен и убран, приложение пробует заново своим", async () => {
    setUp(CASES[2] as Case);
    runBoot();
    const first = sdkTags()[0];
    first?.dispatchEvent(new Event("error"));
    expect(first?.getAttribute(SDK_STATE_ATTR)).toBe("failed");
    expect(sdkTags()).toHaveLength(0);
    const attempt = loadTelegramWebApp(window);
    expect(sdkTags()).toHaveLength(1);
    sdkTags()[0]?.dispatchEvent(new Event("error"));
    expect(await attempt).toBeNull();
  });

  it("хранилище запрещено (старый вебвью) — без ошибок, не Telegram", () => {
    setUp(CASES[0] as Case);
    const broken = {
      getItem() {
        throw new Error("SecurityError");
      },
    };
    expect(() => runBoot({ sessionStorage: broken })).not.toThrow();
    expect(sdkTags()).toHaveLength(0);
  });

  it("встроенных обработчиков и записи HTML нет (CSP, правило no-unsafe-sinks)", () => {
    expect(BOOT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });

  it("кабинет и панель ставят один и тот же файл", () => {
    expect(OTHER_BOOT).toBe(BOOT);
  });
});

describe("index.html", () => {
  const html = HTML;

  it("boot.js — внешний файл, не блокирует разбор; других сторонних скриптов нет", () => {
    expect(html).toMatch(/<script src="\/boot\.js" async><\/script>/);
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts).toEqual(["/boot.js", "/src/main.tsx"]);
    expect(html).not.toContain("telegram.org");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it("шрифты первого экрана предзагружаются со своего origin: панель по-русски — кириллица и латиница текста, Unbounded кириллица и латиница (шапка)", () => {
    const fonts = [
      ...html.matchAll(/<link rel="preload" href="\.\.\/\.\.\/packages\/ui\/fonts\/([a-z-]+)\.woff2"/g),
    ]
      .map((m) => m[1])
      .sort();
    expect(fonts).toEqual(["manrope-cyrillic", "manrope-latin", "unbounded-cyrillic", "unbounded-latin"]);
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });
});
