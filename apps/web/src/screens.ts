/* Экраны клиента — отдельными частями сборки (code splitting): первый заход грузит оболочку
   и только свой экран — лендинг в браузере, каталог в Telegram. Загрузчики — в одной карте:
   по ней оболочка заранее подгружает экраны вкладок, пока человек смотрит на первый,
   а тесты — всё сразу (src/test-setup.ts). */

import { lazy } from "react";

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

export const Landing = lazy(() => LOADERS.landing().then((m) => ({ default: m.Landing })));
export const Catalog = lazy(() => LOADERS.catalog().then((m) => ({ default: m.Catalog })));
export const Venue = lazy(() => LOADERS.venue().then((m) => ({ default: m.Venue })));
export const RequestForm = lazy(() => LOADERS.request().then((m) => ({ default: m.RequestForm })));
export const Favorites = lazy(() => LOADERS.favorites().then((m) => ({ default: m.Favorites })));
export const MyRequests = lazy(() => LOADERS.requests().then((m) => ({ default: m.MyRequests })));
export const Profile = lazy(() => LOADERS.profile().then((m) => ({ default: m.Profile })));
export const Docs = lazy(() => LOADERS.docs().then((m) => ({ default: m.Docs })));
export const SignIn = lazy(() => LOADERS.auth().then((m) => ({ default: m.SignIn })));
export const TelegramCallback = lazy(() => LOADERS.auth().then((m) => ({ default: m.TelegramCallback })));

/** Заранее подгрузить экраны: ошибку сети не показываем — экран загрузится при переходе */
export function preloadScreens(chunks: readonly ScreenChunk[]): void {
  for (const chunk of chunks) void LOADERS[chunk]().catch(() => {});
}

/** Все экраны сразу (тесты: переход не ждёт загрузки куска) */
export function preloadAll(): Promise<unknown> {
  return Promise.all(Object.values(LOADERS).map((load) => load()));
}
