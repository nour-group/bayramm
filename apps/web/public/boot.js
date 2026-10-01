/* До первой отрисовки, из <head> (CSP: только внешний файл). Отдаётся как есть — подробности
   в vite-prerender.ts; правила сверяет src/boot.test.ts. */
((w) => {
  const d = w.document;
  const root = d.documentElement;
  const LANGS = ["ru", "uz"];
  const LANG_KEY = "bayramm.web.lang";
  const LAUNCH_RE = /[#&?]tgWebApp[A-Za-z]+=/;
  const SDK_KEY = "__telegram__initParams";
  const CATALOG_PARAMS = ["category", "date", "guests", "district", "sort"];
  const loc = w.location;

  const isLang = (value) => LANGS.includes(value);

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

  const sdk = () => {
    const app = w.Telegram?.WebApp;
    return typeof app?.initData === "string" && app.initData.length > 0 ? app : null;
  };

  // getWebApp || launchedFromTelegram
  const telegram =
    sdk() !== null ||
    LAUNCH_RE.test(loc.hash) ||
    LAUNCH_RE.test(loc.search) ||
    stored("sessionStorage", SDK_KEY) !== null;

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

  // takeLangParam + initialLang
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
