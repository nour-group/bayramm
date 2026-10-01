import { LANGS, type Lang } from "@bayramm/shared";
import { renderToString } from "react-dom/server";
import { AppFrame } from "./App";
import type { ClientApi } from "./api/types";
import type { Services } from "./context";
import { loadDictionary } from "./i18n";
import type { Router } from "./router";
import { matchRoute } from "./routes";
import { loadStartScreen, SCREEN_CHUNK } from "./screens";

/* Пререндер лендинга (/) — при сборке, в Node (vite-плагин build/prerender.ts), не в воркере.
   Та же оболочка и тот же экран, что у приложения, глазами гостя в обычном браузере: шапка,
   первый экран с подбором, как это работает, обещания, площадкам, вопросы, подвал. Данных
   API в нём нет: залы — заготовки на их месте (придут после JS), ссылки кабинета и бота —
   тоже после JS. Воркер вставляет вариант языка страницы в #root (worker/prerender.ts).

   Приложение не гидрирует эту разметку, а заменяет её своей первой отрисовкой (createRoot
   очищает #root в том же коммите): у живого человека своё — вход, язык, демо-режим, дата;
   гидрация на любом расхождении сыпала бы ошибками и перерисовывала всё равно. Экран
   лендинга bootstrap загружает до первой отрисовки, поэтому замена — без заглушки. */

/** API пререндера: эффекты при рендере в строку не запускаются, запросов нет */
const NO_API = new Proxy({ mode: "live" } as ClientApi, {
  get: (target, key) => (key in target ? target[key as keyof ClientApi] : () => new Promise<never>(() => {})),
});

/** Неподвижный адрес: переходов при рендере в строку нет */
const ROUTER: Router = {
  match: matchRoute("/"),
  query: new URLSearchParams(),
  navigate: () => {},
  back: () => {},
};

/**
 * HTML лендинга на языке lang — содержимое #root. Обёртка с data-prerendered: по ней
 * public/boot.js и стили прячут пререндер, если приложение покажет другое (Mini App, язык)
 */
export async function renderLanding(lang: Lang, now: number = Date.now()): Promise<string> {
  await Promise.all([loadDictionary(lang), loadStartScreen(SCREEN_CHUNK.home)]);
  const services: Services = {
    api: NO_API,
    identity: "guest",
    webApp: null,
    mediaEnv: "production",
    now: () => now,
  };
  const html = renderToString(<AppFrame services={services} router={ROUTER} prerenderLang={lang} />);
  return `<div data-prerendered="${lang}">${html}</div>`;
}

/** Пререндер на всех языках: { ru: "…", uz: "…" } */
export async function renderLandings(now: number = Date.now()): Promise<Record<Lang, string>> {
  const pages = await Promise.all(LANGS.map(async (lang) => [lang, await renderLanding(lang, now)] as const));
  return Object.fromEntries(pages) as Record<Lang, string>;
}
