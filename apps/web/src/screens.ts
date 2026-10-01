/* Экраны клиента — отдельными частями сборки (code splitting): первый заход грузит оболочку
   и только свой экран — лендинг в браузере, каталог в Telegram. Загрузчики — в одной карте:
   по ней оболочка заранее подгружает экраны вкладок, пока человек смотрит на первый,
   а тесты — всё сразу (src/test-setup.ts).

   Экран первого показа можно загрузить до первой отрисовки (loadStartScreen): тогда он
   рисуется сразу, без заглушки Suspense. Так лендинг сменяет свой пререндер из HTML
   (prerender.tsx) за одну отрисовку — без мигания «загрузки» между ними.

   Так же — любой уже загруженный кусок (заранее, по наведению на карточку, раньше на этом
   экране): React.lazy приостанавливается и на готовом модуле, а React 19 показывает
   содержимое после заглушки не сразу, а пачкой (~300 мс). Поэтому экран из готового куска
   рисуется напрямую, без lazy: каталог → витрина → форма — без задержки на переход. */

import { type ComponentType, createElement, lazy, useState } from "react";
import type { RouteName } from "./routes";

const LOADERS = {
  landing: () => import("./screens/Landing"),
  catalog: () => import("./screens/Catalog"),
  venue: () => import("./screens/Venue"),
  request: () => import("./screens/RequestForm"),
  favorites: () => import("./screens/Favorites"),
  requests: () => import("./screens/MyRequests"),
  profile: () => import("./screens/Profile"),
  docs: () => import("./screens/Docs"),
  auth: () => import("./screens/SignIn"),
} as const;

export type ScreenChunk = keyof typeof LOADERS;
type ScreenModule<K extends ScreenChunk> = Awaited<ReturnType<(typeof LOADERS)[K]>>;
const load = <K extends ScreenChunk>(chunk: K) =>
  (LOADERS[chunk]() as Promise<ScreenModule<K>>).then((module) => {
    loaded.set(chunk, module);
    return module;
  });

/** Кусок сборки с экраном маршрута (корень — лендинг; в Telegram корень — каталог, screenOf) */
export const SCREEN_CHUNK = {
  home: "landing",
  catalog: "catalog",
  venue: "venue",
  request: "request",
  favorites: "favorites",
  requests: "requests",
  profile: "profile",
  docs: "docs",
  auth: "auth",
  authTelegram: "auth",
} as const satisfies Record<RouteName, ScreenChunk>;

// Загруженные куски: экран, который монтируется после загрузки своего куска, рисуется
// напрямую. Смонтированный экран выбор не меняет (useState) — без перемонтирования
const loaded = new Map<ScreenChunk, unknown>();

function screen<K extends ScreenChunk, P extends object>(
  chunk: K,
  pick: (module: ScreenModule<K>) => ComponentType<P>,
): ComponentType<P> {
  const Lazy = lazy(() => load(chunk).then((module) => ({ default: pick(module) })));
  function Screen(props: P) {
    const [module] = useState(() => loaded.get(chunk) as ScreenModule<K> | undefined);
    return createElement((module ? pick(module) : Lazy) as ComponentType<P>, props);
  }
  Screen.displayName = `Screen(${chunk})`;
  return Screen;
}

export const Landing = screen("landing", (m) => m.Landing);
export const Catalog = screen("catalog", (m) => m.Catalog);
export const Venue = screen("venue", (m) => m.Venue);
export const RequestForm = screen("request", (m) => m.RequestForm);
export const Favorites = screen("favorites", (m) => m.Favorites);
export const MyRequests = screen("requests", (m) => m.MyRequests);
export const Profile = screen("profile", (m) => m.Profile);
export const Docs = screen("docs", (m) => m.Docs);
export const SignIn = screen("auth", (m) => m.SignIn);
export const TelegramCallback = screen("auth", (m) => m.TelegramCallback);

/** Экран первого показа — до первой отрисовки (bootstrap, пререндер): рисуется без заглушки */
export async function loadStartScreen(chunk: ScreenChunk): Promise<void> {
  await load(chunk);
}

/** Заранее подгрузить экраны: ошибку сети не показываем — экран загрузится при переходе */
export function preloadScreens(chunks: readonly ScreenChunk[]): void {
  for (const chunk of chunks) if (!loaded.has(chunk)) void load(chunk).catch(() => {});
}

/** Все экраны сразу (тесты: переход не ждёт загрузки куска) */
export function preloadAll(): Promise<unknown> {
  return Promise.all((Object.keys(LOADERS) as ScreenChunk[]).map((chunk) => load(chunk)));
}
