// @vitest-environment jsdom
import { runInNewContext } from "node:vm";
import type { Lang } from "@bayramm/shared";
import { getWebApp, launchedFromTelegram, type TelegramWebApp } from "@bayramm/tg/webapp";
import { afterEach, describe, expect, it } from "vitest";
import BOOT from "../public/boot.js?raw";
import { initialLang, takeLangParam } from "./context";

/* public/boot.js решает до приложения, прятать ли пререндер лендинга и какие куски сборки
   просить заранее. Его правила обязаны совпадать с правилами приложения: Telegram —
   getWebApp/launchedFromTelegram, язык — takeLangParam + initialLang. Здесь каждый случай
   прогоняется через оба и сверяется. */

const LANG_KEY = "bayramm.web.lang";

/** Атрибуты тега boot.js, как их вписывает сборка (vite-prerender.ts) */
const TAG_ATTRS: Readonly<Record<string, string>> = {
  "data-ru": "/assets/ru.js /assets/rich.js",
  "data-uz": "/assets/uz.js /assets/rich.js",
  "data-landing": "/assets/Landing.js /assets/Calendar.js",
  "data-catalog": "/assets/Catalog.js /assets/Calendar.js",
};

interface Case {
  readonly name: string;
  /** Адрес страницы: путь, ?параметры, #хэш */
  readonly url: string;
  /** Язык страницы, который поставил воркер (<html lang>) */
  readonly pageLang?: Lang;
  readonly session?: Record<string, string>;
  readonly local?: Record<string, string>;
  readonly languages?: readonly string[];
  /** Подделка SDK, уже лежащая в window.Telegram (как в сквозных тестах) */
  readonly sdkLanguage?: string;
  /** Сборка без адресов кусков (разработка) */
  readonly bare?: boolean;
  readonly expected: {
    readonly lang: Lang;
    readonly telegram: boolean;
    readonly boot: "show" | "skip";
    readonly screen: "landing" | "catalog" | null;
  };
}

/** initData Mini App с языком пользователя — как Telegram кладёт её в #tgWebAppData */
const initData = (language: string) =>
  new URLSearchParams({
    user: JSON.stringify({ id: 1, first_name: "A", language_code: language }),
    hash: "x",
  }).toString();
const launchHash = (language: string) =>
  `#${new URLSearchParams({ tgWebAppData: initData(language), tgWebAppVersion: "8.0" }).toString()}`;

const CASES: readonly Case[] = [
  {
    name: "первый визит, браузер на узбекском — лендинг виден",
    url: "/",
    languages: ["uz-UZ", "ru"],
    expected: { lang: "uz", telegram: false, boot: "show", screen: "landing" },
  },
  {
    name: "браузер на русском, страница на узбекском — пререндер прячем",
    url: "/",
    languages: ["ru-RU", "en"],
    expected: { lang: "ru", telegram: false, boot: "skip", screen: "landing" },
  },
  {
    name: "язык браузера ни русский, ни узбекский — узбекский, как у страницы",
    url: "/",
    languages: ["en-US", "de"],
    expected: { lang: "uz", telegram: false, boot: "show", screen: "landing" },
  },
  {
    name: "?lang=ru у русской версии страницы — виден",
    url: "/?lang=ru",
    pageLang: "ru",
    local: { [LANG_KEY]: "uz" },
    languages: ["uz"],
    expected: { lang: "ru", telegram: false, boot: "show", screen: "landing" },
  },
  {
    name: "?lang= непонятный — как без него",
    url: "/?lang=en",
    languages: ["ru-RU"],
    expected: { lang: "ru", telegram: false, boot: "skip", screen: "landing" },
  },
  {
    name: "выбор в прошлый визит (localStorage) главнее языка браузера",
    url: "/",
    local: { [LANG_KEY]: "uz" },
    languages: ["ru-RU"],
    expected: { lang: "uz", telegram: false, boot: "show", screen: "landing" },
  },
  {
    name: "выбор в этой вкладке главнее прошлого визита",
    url: "/",
    session: { [LANG_KEY]: "ru" },
    local: { [LANG_KEY]: "uz" },
    languages: ["uz"],
    expected: { lang: "ru", telegram: false, boot: "skip", screen: "landing" },
  },
  {
    name: "Mini App: параметры запуска в адресе — пререндер прячем, первым будет каталог",
    url: `/${launchHash("uz")}`,
    languages: ["ru-RU"],
    expected: { lang: "uz", telegram: true, boot: "skip", screen: "catalog" },
  },
  {
    name: "Mini App после перезагрузки: параметры только в копии SDK во вкладке",
    url: "/",
    session: { __telegram__initParams: JSON.stringify({ tgWebAppData: initData("ru") }) },
    languages: ["uz"],
    expected: { lang: "ru", telegram: true, boot: "skip", screen: "catalog" },
  },
  {
    name: "Mini App: SDK уже в window.Telegram, язык Telegram не наш — язык браузера",
    url: "/",
    sdkLanguage: "en",
    languages: ["uz-Latn-UZ"],
    expected: { lang: "uz", telegram: true, boot: "skip", screen: "catalog" },
  },
  {
    name: "старая ссылка на каталог с фильтрами в корне — первым будет каталог",
    url: "/?date=2026-10-20&guests=120",
    languages: ["uz"],
    expected: { lang: "uz", telegram: false, boot: "show", screen: "catalog" },
  },
  {
    name: "каталог",
    url: "/catalog/",
    languages: ["uz"],
    expected: { lang: "uz", telegram: false, boot: "show", screen: "catalog" },
  },
  {
    name: "площадка — экран заранее не просим",
    url: "/venue/lola",
    languages: ["ru"],
    expected: { lang: "ru", telegram: false, boot: "skip", screen: null },
  },
  {
    name: "разработка: адресов кусков нет — только пометка",
    url: "/",
    languages: ["uz"],
    bare: true,
    expected: { lang: "uz", telegram: false, boot: "show", screen: "landing" },
  },
];

function setUp(c: Case): TelegramWebApp | null {
  window.history.replaceState(null, "", c.url);
  for (const [key, value] of Object.entries(c.session ?? {})) window.sessionStorage.setItem(key, value);
  for (const [key, value] of Object.entries(c.local ?? {})) window.localStorage.setItem(key, value);
  Object.defineProperty(window.navigator, "languages", { value: c.languages ?? [], configurable: true });
  document.documentElement.setAttribute("lang", c.pageLang ?? "uz");
  const sdk =
    c.sdkLanguage === undefined
      ? undefined
      : { WebApp: { initData: initData(c.sdkLanguage), initDataUnsafe: {} } as TelegramWebApp };
  Object.defineProperty(window, "Telegram", { value: sdk, configurable: true, writable: true });
  return sdk?.WebApp ?? null;
}

/** boot.js в отдельном контексте: window — настоящий jsdom, у document — свой тег скрипта */
function runBoot(c: Case): readonly string[] {
  const tag = document.createElement("span");
  if (!c.bare) for (const [name, value] of Object.entries(TAG_ATTRS)) tag.setAttribute(name, value);
  const doc = {
    documentElement: document.documentElement,
    head: document.head,
    currentScript: tag,
    createElement: (name: string) => document.createElement(name),
  };
  const scope = {
    document: doc,
    location: window.location,
    navigator: window.navigator,
    sessionStorage: window.sessionStorage,
    localStorage: window.localStorage,
    URLSearchParams: window.URLSearchParams,
    Telegram: (window as { Telegram?: unknown }).Telegram,
  };
  runInNewContext(BOOT, { window: scope });
  return [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')].map((link) =>
    link.getAttribute("href"),
  ) as string[];
}

/** Что решит приложение: Telegram (bootstrap) и язык первого показа (normalizeStartUrl + AppProviders) */
function appDecision(sdk: TelegramWebApp | null, sdkLanguage: string | undefined) {
  const telegram = getWebApp(window) !== null || launchedFromTelegram(window);
  const url = new URL(window.location.href);
  takeLangParam(url);
  // SDK отдаёт язык пользователя из той же initData, что boot.js читает сам
  const user = new URLSearchParams(sdk?.initData ?? hashInitData() ?? sessionInitData() ?? "").get("user");
  const languageCode = user ? (JSON.parse(user) as { language_code?: string }).language_code : sdkLanguage;
  const webApp = telegram
    ? ({
        initData: "x",
        initDataUnsafe: { user: { id: 1, first_name: "A", language_code: languageCode } },
      } as TelegramWebApp)
    : null;
  return { telegram, lang: initialLang(webApp) };
}

const hashInitData = () => new URLSearchParams(window.location.hash.slice(1)).get("tgWebAppData");
const sessionInitData = () => {
  const saved = window.sessionStorage.getItem("__telegram__initParams");
  return saved ? ((JSON.parse(saved) as { tgWebAppData?: string }).tgWebAppData ?? null) : null;
};

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  document.head.replaceChildren();
  document.documentElement.removeAttribute("data-boot");
});

describe("public/boot.js", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const sdk = setUp(c);
      const preloads = runBoot(c);
      const { expected } = c;

      expect(document.documentElement.getAttribute("data-boot")).toBe(expected.boot);
      const screen = expected.screen ? (TAG_ATTRS[`data-${expected.screen}`] ?? "").split(" ") : [];
      expect(preloads).toEqual(
        c.bare ? [] : [...(TAG_ATTRS[`data-${expected.lang}`] ?? "").split(" "), ...screen],
      );

      // Те же решения у приложения
      expect(appDecision(sdk, c.sdkLanguage)).toEqual({ telegram: expected.telegram, lang: expected.lang });
    });
  }

  it("хранилище запрещено (старый вебвью) — без ошибок, по языку браузера", () => {
    const c = CASES[0] as Case;
    setUp(c);
    const broken = {
      getItem() {
        throw new Error("SecurityError");
      },
    };
    const doc = { documentElement: document.documentElement, head: document.head, currentScript: null };
    const scope = {
      document: doc,
      location: window.location,
      navigator: window.navigator,
      sessionStorage: broken,
      localStorage: broken,
      URLSearchParams: window.URLSearchParams,
    };
    expect(() => runInNewContext(BOOT, { window: scope })).not.toThrow();
    expect(document.documentElement.getAttribute("data-boot")).toBe("show");
  });

  it("встроенных обработчиков и записи HTML нет (CSP, правило no-unsafe-sinks)", () => {
    expect(BOOT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });
});
