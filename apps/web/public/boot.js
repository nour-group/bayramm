/* Bayramm: до первой отрисовки, синхронно из <head>. Внешний файл: встроенные скрипты CSP
   не пускает. Обычный скрипт, не модуль (модуль отложен до конца разбора — поздно); язык —
   не новее сборки приложения. Ошибка здесь ничего не ломает: лендинг из HTML просто
   остаётся видимым до приложения.

   1. <html data-boot="show|skip">. Воркер кладёт в #root главной пререндер лендинга на языке
      страницы (data-prerendered). skip — приложение покажет другое: внутри Telegram корень —
      каталог, или язык приложения (выбор, сохранённый в браузере, язык браузера) не совпадает
      с языком страницы. Стили рядом (public/boot.css) тогда прячут пререндер: лучше пусто,
      чем чужой экран или чужой язык на миг. Правила те же, что у приложения: getWebApp и
      launchedFromTelegram (@bayramm/tg/webapp), initialLang и takeLangParam
      (src/context.tsx) — их сверяет src/boot.test.ts.
   2. Куски сборки заранее (modulepreload): словарь своего языка и экран первого показа.
      Адреса — в атрибутах этого тега, их вписывает сборка (vite-prerender.ts); в разработке
      их нет. */
((w) => {
  const d = w.document;
  const root = d.documentElement;
  const LANGS = ["ru", "uz"];
  const LANG_KEY = "bayramm.web.lang";
  // Параметры запуска Mini App в адресе и их копия, которую SDK кладёт во вкладку
  const LAUNCH_RE = /[#&?]tgWebApp[A-Za-z]+=/;
  const SDK_KEY = "__telegram__initParams";
  const CATALOG_PARAMS = ["date", "guests", "district", "sort"];
  const loc = w.location;

  const isLang = (value) => LANGS.includes(value);

  // Хранилище запрещено (приватный режим, старый вебвью) — как будто пусто
  const stored = (store, key) => {
    try {
      return w[store].getItem(key);
    } catch {
      return null;
    }
  };

  const param = (search, name) => {
    try {
      return new w.URLSearchParams(search).get(name);
    } catch {
      return null;
    }
  };

  // SDK уже в window.Telegram (getWebApp)
  const sdk = () => {
    const app = w.Telegram?.WebApp;
    return typeof app?.initData === "string" && app.initData.length > 0 ? app : null;
  };

  // Внутри Telegram: SDK уже есть или страницу открыл Telegram (launchedFromTelegram)
  const telegram =
    sdk() !== null ||
    LAUNCH_RE.test(loc.hash) ||
    LAUNCH_RE.test(loc.search) ||
    stored("sessionStorage", SDK_KEY) !== null;

  // Язык Telegram: user.language_code из initData (SDK, адрес или копия SDK во вкладке)
  const telegramLang = () => {
    if (!telegram) return null;
    try {
      const data =
        sdk()?.initData ||
        param(loc.hash.slice(1), "tgWebAppData") ||
        param(loc.search, "tgWebAppData") ||
        JSON.parse(stored("sessionStorage", SDK_KEY) || "{}").tgWebAppData;
      const user = data ? JSON.parse(param(data, "user") || "null") : null;
      return typeof user?.language_code === "string" ? user.language_code : null;
    } catch {
      return null;
    }
  };

  // ?lang= → выбор во вкладке → выбор в прошлые визиты → Telegram → браузер → узбекский
  const appLang = () => {
    const fromUrl = param(loc.search, "lang");
    if (isLang(fromUrl)) return fromUrl;
    const saved = stored("sessionStorage", LANG_KEY) ?? stored("localStorage", LANG_KEY);
    if (isLang(saved)) return saved;
    const nav = w.navigator ?? {};
    const tags = [telegramLang(), ...(nav.languages?.length ? nav.languages : [nav.language])];
    for (const tag of tags) {
      const code = typeof tag === "string" ? tag.slice(0, 2).toLowerCase() : "";
      if (isLang(code)) return code;
    }
    return "uz";
  };

  const lang = appLang();
  root.setAttribute("data-boot", telegram || lang !== root.getAttribute("lang") ? "skip" : "show");

  // Экран первого показа: корень — лендинг (в Telegram и со старыми фильтрами — каталог)
  const path = loc.pathname.replace(/\/+$/, "") || "/";
  const legacy = CATALOG_PARAMS.some((name) => param(loc.search, name) !== null);
  const screen =
    path === "/" ? (telegram || legacy ? "catalog" : "landing") : path === "/catalog" ? "catalog" : null;

  const tag = d.currentScript;
  if (!tag?.getAttribute) return;
  const urls = [tag.getAttribute(`data-${lang}`), screen ? tag.getAttribute(`data-${screen}`) : null]
    .join(" ")
    .split(" ")
    .filter(Boolean);
  for (const url of urls) {
    const link = d.createElement("link");
    link.rel = "modulepreload";
    link.href = url;
    link.crossOrigin = "";
    d.head.appendChild(link);
  }
})(window);
