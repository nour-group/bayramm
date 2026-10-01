import { canSignIn, type Identity } from "./context";
import { authHref } from "./hub";
import { type Match, TABS, type Tab } from "./routes";

/* Оболочка сайта: у гостя и после входа — разная.

   Гость в обычном браузере — сайт: шапка с логотипом, языком, «Войти» и меню (шторка
   на телефоне и планшете), без нижней панели приложения. Разделы — только то, что работает
   без входа: каталог и сохранённое (избранное гостя живёт в браузере). Личное — заявки и
   профиль — после входа: прямой адрес ведёт в хаб входа и назад сюда; пустых личных экранов
   гость не видит.

   После входа на сайте и всегда внутри Telegram (там вход по initData) — оболочка
   приложения: нижняя панель на телефоне и планшете, все разделы в шапке на компьютере.
   Пререндер лендинга (prerender.tsx) — глазами гостя: его разметка и есть оболочка гостя. */

export type Chrome = "app" | "guest";

/** Какая оболочка: Telegram — всегда приложение; на сайте — после входа (аккаунт не удалён) */
export function chromeOf(identity: Identity, inTelegram: boolean, deleted: boolean): Chrome {
  if (inTelegram) return "app";
  return canSignIn(identity) && !deleted ? "app" : "guest";
}

/** Разделы гостя: каталог и сохранённое — без входа */
export const GUEST_SECTIONS = ["catalog", "favorites"] as const satisfies readonly Tab[];

/** Разделы в шапке (на компьютере) и в нижней панели — по оболочке */
export const sectionsOf = (chrome: Chrome): readonly Tab[] => (chrome === "app" ? TABS : GUEST_SECTIONS);

/** Личные экраны: только после входа */
export const isPersonal = (match: Match | null): boolean =>
  match?.name === "requests" || match?.name === "profile";

/**
 * Куда увести с экрана, которого без входа нет: личный экран у гостя — хаб входа с
 * возвратом сюда (here — путь со строкой запроса). null — экран можно показывать.
 * Удалённый в этой вкладке аккаунт остаётся на месте: экран сам скажет, что аккаунта нет
 */
export function signInGate(match: Match | null, identity: Identity, here: string): string | null {
  return isPersonal(match) && !canSignIn(identity) ? authHref({ return: here }) : null;
}
