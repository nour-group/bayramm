import { trimTrailingSlashes } from "@bayramm/shared";

/* Все маршруты клиента — в одной карте. Пути и номера экранов, вписанные по месту,
   разъезжаются (ловушка №9 в CLAUDE.md): ссылки собираем только через hrefFor.
   Модуль без React и DOM: его же читает воркер (мета-теги страниц, sitemap.xml). */

export const ROUTES = {
  // Корень: в браузере — лендинг, внутри Telegram — каталог (стартовый экран Mini App)
  home: "/",
  catalog: "/catalog",
  venue: "/venue/:slug",
  request: "/venue/:slug/request",
  favorites: "/favorites",
  requests: "/requests",
  profile: "/profile",
  docs: "/docs",
  // Хаб входа: вход на сайт и вход в кабинет и панель (hub.ts). Ссылки сюда — только
  // полной загрузкой: CSP виджета Telegram — у страниц /auth
  auth: "/auth",
  authTelegram: "/auth/telegram",
} as const;

export type RouteName = keyof typeof ROUTES;

export type Match =
  | { readonly name: "home" }
  | { readonly name: "catalog" }
  | { readonly name: "venue"; readonly slug: string }
  | { readonly name: "request"; readonly slug: string }
  | { readonly name: "favorites" }
  | { readonly name: "requests" }
  | { readonly name: "profile" }
  | { readonly name: "docs" }
  | { readonly name: "auth" }
  | { readonly name: "authTelegram" };

/** Вкладки нижней панели (и разделы шапки на компьютере), по порядку: каталог, сохранённое, заявки, профиль */
export const TABS = ["catalog", "favorites", "requests", "profile"] as const satisfies readonly RouteName[];
export type Tab = (typeof TABS)[number];

// Как slug листинга в базе и id в start_param: строчная латиница, цифры, дефис
const SLUG = "([a-z0-9-]{1,64})";
const VENUE_RE = new RegExp(`^/venue/${SLUG}$`);
const REQUEST_RE = new RegExp(`^/venue/${SLUG}/request$`);

const STATIC: Readonly<Record<string, Match>> = {
  [ROUTES.home]: { name: "home" },
  [ROUTES.catalog]: { name: "catalog" },
  [ROUTES.favorites]: { name: "favorites" },
  [ROUTES.requests]: { name: "requests" },
  [ROUTES.profile]: { name: "profile" },
  [ROUTES.docs]: { name: "docs" },
  [ROUTES.auth]: { name: "auth" },
  [ROUTES.authTelegram]: { name: "authTelegram" },
};

/** Маршрут по пути; неизвестный путь — null */
export function matchRoute(pathname: string): Match | null {
  const path = trimTrailingSlashes(pathname) || "/";
  const fixed = STATIC[path];
  if (fixed) return fixed;
  const venue = VENUE_RE.exec(path)?.[1];
  if (venue) return { name: "venue", slug: venue };
  const request = REQUEST_RE.exec(path)?.[1];
  if (request) return { name: "request", slug: request };
  return null;
}

type Query = Readonly<Record<string, string | number | null | undefined>>;

/** Адрес экрана: путь из карты плюс строка запроса без пустых значений */
export function hrefFor(match: Match, query: Query = {}): string {
  const path = "slug" in match ? ROUTES[match.name].replace(":slug", match.slug) : ROUTES[match.name];
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/**
 * Экран, который на самом деле показываем: корень внутри Telegram — каталог (так Mini App
 * открывался всегда, и туда же ведут кнопки бота «Показать похожие»: /?date=…)
 */
export function screenOf(match: Match | null, inTelegram: boolean): Match | null {
  return match?.name === "home" && inTelegram ? { name: "catalog" } : match;
}

/**
 * Категории каталога клиента — включённые в @bayramm/shared/categories (CATEGORIES, enabled),
 * по порядку показа. Список здесь, а не из описания категорий: карту маршрутов грузит
 * оболочка и воркер, описание категорий с подписями ей не нужно. Сверяет categories.test.ts
 */
export const CATEGORY_CODES = [
  "hall",
  "car",
  "studio",
  "flowers",
  "photo",
  "cake",
  "gifts",
  "decor",
] as const;
export type ClientCategoryCode = (typeof CATEGORY_CODES)[number];

/** Категория каталога без параметра category — залы, как у API */
export const DEFAULT_CATEGORY: ClientCategoryCode = "hall";

export const isCategoryParam = (value: string | null | undefined): value is ClientCategoryCode =>
  (CATEGORY_CODES as readonly string[]).includes(value ?? "");

/**
 * Параметры фильтров каталога в адресе (catalog-feed.ts). Фильтры по полям витрины —
 * «a.<поле>» (ATTRIBUTE_FILTER_PREFIX), их набор у каждой категории свой
 */
export const CATALOG_PARAMS = ["category", "date", "guests", "district", "sort"] as const;

/**
 * Старые ссылки на каталог с фильтрами — корень с ?date=&guests=… (до лендинга каталог жил
 * в корне; так же их собирает бот). В браузере они ведут в /catalog с теми же фильтрами;
 * null — уводить некуда
 */
export function legacyCatalogHref(pathname: string, search: string): string | null {
  if (matchRoute(pathname)?.name !== "home") return null;
  const params = new URLSearchParams(search);
  if (!CATALOG_PARAMS.some((key) => params.has(key))) return null;
  return `${ROUTES.catalog}?${params.toString()}`;
}

/**
 * Адрес страницы для поисковиков (canonical): путь без фильтров; у каталога — с категорией
 * (у каждой категории своя страница), залы — без параметра
 */
export function canonicalHref(match: Match, query: URLSearchParams): string {
  const category = query.get("category");
  if (match.name === "catalog" && isCategoryParam(category) && category !== DEFAULT_CATEGORY)
    return hrefFor(match, { category });
  return hrefFor(match);
}

/** Куда ведёт «назад», если в истории вкладки до этого экрана ничего нет */
export function parentOf(match: Match | null): Match | null {
  if (match?.name === "request") return { name: "venue", slug: match.slug };
  if (match?.name === "venue") return { name: "catalog" };
  return null;
}

/** Вкладка, к которой относится экран: площадка и заявка — к каталогу; лендинг, документы и вход — ни к какой */
export function tabOf(match: Match | null): Tab | null {
  switch (match?.name) {
    case "catalog":
    case "venue":
    case "request":
      return "catalog";
    case "favorites":
    case "requests":
    case "profile":
      return match.name;
    default:
      return null;
  }
}

/**
 * Ширина содержимого экрана на планшете и компьютере (на телефоне — вся ширина):
 * wide — сетка карточек и площадка (до 1280px), text — списки и тексты (720px),
 * form — формы и вход (640px). Неизвестный путь — text
 */
export type Width = "wide" | "text" | "form";

const WIDTH = {
  home: "wide",
  catalog: "wide",
  venue: "wide",
  request: "form",
  favorites: "wide",
  requests: "text",
  profile: "text",
  docs: "text",
  auth: "form",
  authTelegram: "form",
} as const satisfies Record<RouteName, Width>;

export const widthOf = (match: Match | null): Width => (match ? WIDTH[match.name] : "text");

/** Внутренние экраны: без нижней панели, с «назад» */
export const isInner = (match: Match | null) => match?.name === "venue" || match?.name === "request";

/** Хаб входа: без нижней панели и без «назад» — дальше ведёт он сам */
export const isAuth = (match: Match | null) => match?.name === "auth" || match?.name === "authTelegram";

/**
 * Страница для поисковиков: лендинг, каталог, площадка, документы. Личное (заявки, профиль,
 * сохранённое), форма заявки и вход — noindex
 */
export function isIndexable(match: Match | null): boolean {
  return (
    match?.name === "home" || match?.name === "catalog" || match?.name === "venue" || match?.name === "docs"
  );
}
