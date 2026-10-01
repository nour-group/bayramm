import { clientCatalogPath, clientRequestPath } from "@bayramm/shared/api";
import { describe, expect, it } from "vitest";
import {
  hrefFor,
  isIndexable,
  legacyCatalogHref,
  type Match,
  matchRoute,
  parentOf,
  ROUTES,
  screenOf,
  TABS,
  tabOf,
  widthOf,
} from "./routes";
import { readFilters } from "./screens/catalog-feed";

describe("маршруты клиента", () => {
  it.each([
    ["/", { name: "home" }],
    ["", { name: "home" }],
    ["/catalog", { name: "catalog" }],
    ["/catalog/", { name: "catalog" }],
    ["/requests", { name: "requests" }],
    ["/requests/", { name: "requests" }],
    ["/profile", { name: "profile" }],
    ["/docs", { name: "docs" }],
    ["/venue/lola-zali", { name: "venue", slug: "lola-zali" }],
    ["/venue/lola-zali/", { name: "venue", slug: "lola-zali" }],
    ["/venue/lola-zali/request", { name: "request", slug: "lola-zali" }],
    ["/auth", { name: "auth" }],
    ["/auth/telegram", { name: "authTelegram" }],
  ])("%s → %o", (path, match) => {
    expect(matchRoute(path)).toEqual(match);
  });

  it.each([
    "/venue",
    "/venue/Lola",
    "/venue/a_b",
    "/venue/a/b",
    "/venue/../admin",
    "/api/me",
    "/index.html",
    "/catalogue",
  ])("%s — не найдено", (path) => {
    expect(matchRoute(path)).toBeNull();
  });

  it("адрес собирается из карты и без пустых параметров", () => {
    expect(hrefFor({ name: "venue", slug: "lola-zali" }, { date: "2026-10-01", guests: null })).toBe(
      "/venue/lola-zali?date=2026-10-01",
    );
    expect(hrefFor({ name: "request", slug: "a-1" })).toBe("/venue/a-1/request");
    expect(hrefFor({ name: "catalog" }, { district: "", sort: undefined })).toBe("/catalog");
    expect(hrefFor({ name: "home" })).toBe("/");
  });

  it("всё, что собирает hrefFor, разбирает matchRoute", () => {
    const all: Match[] = [
      { name: "home" },
      { name: "catalog" },
      { name: "venue", slug: "zal-1" },
      { name: "request", slug: "zal-1" },
      { name: "favorites" },
      { name: "requests" },
      { name: "profile" },
      { name: "docs" },
      { name: "auth" },
      { name: "authTelegram" },
    ];
    expect(all.map((m) => m.name).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const match of all) expect(matchRoute(hrefFor(match))).toEqual(match);
  });

  it("пути не повторяются; вкладки — каталог, сохранённое, заявки, профиль", () => {
    const paths = Object.values(ROUTES);
    expect(new Set(paths).size).toBe(paths.length);
    expect(TABS).toEqual(["catalog", "favorites", "requests", "profile"]);
    expect(tabOf({ name: "favorites" })).toBe("favorites");
  });

  it("назад с внутреннего экрана — к родителю; вкладка внутреннего — каталог; лендинг и документы — ничья", () => {
    expect(parentOf({ name: "request", slug: "x-1" })).toEqual({ name: "venue", slug: "x-1" });
    expect(parentOf({ name: "venue", slug: "x-1" })).toEqual({ name: "catalog" });
    expect(parentOf({ name: "requests" })).toBeNull();
    expect(tabOf({ name: "venue", slug: "x-1" })).toBe("catalog");
    expect(tabOf({ name: "request", slug: "x-1" })).toBe("catalog");
    expect(tabOf({ name: "profile" })).toBe("profile");
    expect(tabOf({ name: "home" })).toBeNull();
    expect(tabOf({ name: "docs" })).toBeNull();
    expect(tabOf({ name: "auth" })).toBeNull();
    expect(tabOf(null)).toBeNull();
  });
});

describe("корень: лендинг в браузере, каталог в Telegram", () => {
  it("внутри Telegram корень показывает каталог, в браузере — лендинг", () => {
    expect(screenOf({ name: "home" }, true)).toEqual({ name: "catalog" });
    expect(screenOf({ name: "home" }, false)).toEqual({ name: "home" });
    expect(screenOf({ name: "profile" }, true)).toEqual({ name: "profile" });
    expect(screenOf(null, true)).toBeNull();
  });

  it("старая ссылка на каталог с фильтрами в корне ведёт в /catalog с теми же фильтрами", () => {
    expect(legacyCatalogHref("/", "?date=2026-10-20&guests=200")).toBe("/catalog?date=2026-10-20&guests=200");
    expect(legacyCatalogHref("/", "?sort=capacity_desc&guest")).toBe("/catalog?sort=capacity_desc&guest=");
    expect(legacyCatalogHref("/", "")).toBeNull();
    expect(legacyCatalogHref("/", "?guest")).toBeNull();
    expect(legacyCatalogHref("/catalog", "?date=2026-10-20")).toBeNull();
    expect(legacyCatalogHref("/profile", "?date=2026-10-20")).toBeNull();
  });

  it("ширина экрана: сетка — у лендинга, каталога, площадки и сохранённого; формы уже текста", () => {
    expect(widthOf({ name: "home" })).toBe("wide");
    expect(widthOf({ name: "catalog" })).toBe("wide");
    expect(widthOf({ name: "venue", slug: "a" })).toBe("wide");
    expect(widthOf({ name: "favorites" })).toBe("wide");
    expect(widthOf({ name: "requests" })).toBe("text");
    expect(widthOf({ name: "profile" })).toBe("text");
    expect(widthOf({ name: "request", slug: "a" })).toBe("form");
    expect(widthOf({ name: "auth" })).toBe("form");
    expect(widthOf(null)).toBe("text");
  });

  it("поисковикам — лендинг, каталог, площадки и документы; личное и формы — нет", () => {
    for (const path of ["/", "/catalog", "/venue/a-1", "/docs"])
      expect(isIndexable(matchRoute(path))).toBe(true);
    for (const path of ["/favorites", "/requests", "/profile", "/venue/a-1/request", "/auth", "/nope"])
      expect(isIndexable(matchRoute(path))).toBe(false);
  });
});

describe("ссылки из бота (@bayramm/shared/api) ведут на экраны клиента", () => {
  const at = (path: string) => new URL(path, "https://bayramm.uz");

  it("заявка — «Мои заявки» с ?open=<id>", () => {
    const url = at(clientRequestPath("eeeeeeee-0000-4000-8000-0000000000a1"));
    expect(matchRoute(url.pathname)).toEqual({ name: "requests" });
    expect(url.searchParams.get("open")).toBe("eeeeeeee-0000-4000-8000-0000000000a1");
  });

  it("похожие — корень с фильтрами: в Telegram это каталог, в браузере — переход в /catalog", () => {
    const filters = { date: "2026-10-20", guests: 200, district: "chilonzor" };
    const url = at(clientCatalogPath(filters));
    // Кнопка бота открывает Mini App: там корень — каталог
    expect(screenOf(matchRoute(url.pathname), true)).toEqual({ name: "catalog" });
    expect(readFilters(url.searchParams, "2026-10-01")).toEqual({ ...filters, sort: null });
    // Та же ссылка в браузере — каталог с теми же фильтрами
    expect(legacyCatalogHref(url.pathname, url.search)).toBe(hrefFor({ name: "catalog" }, filters));
  });
});
