import type { Lang } from "@bayramm/shared";
import { legacyCatalogHref, matchRoute } from "../src/routes";

/* Пререндер лендинга в HTML главной. Сборка кладёт в index.html шаблоны
   <template data-prerender="ru|uz"> (vite-prerender.ts); здесь их убираем из каждой
   страницы, а на главной вставляем вариант языка страницы в #root — рендера в воркере нет.
   До JS и без него виден лендинг, поисковики читают его текст. Внутри Telegram и при
   другом языке приложения его прячет public/boot.js; приложение заменяет его своей
   первой отрисовкой. */

const TEMPLATE_RE = /\s*<template data-prerender="([a-z]+)">([\s\S]*?)<\/template>/g;
const ROOT = '<div id="root"></div>';

/** Нужен ли пререндер странице: главная (лендинг), а не старая ссылка на каталог с фильтрами */
export function wantsPrerender(url: URL): boolean {
  return matchRoute(url.pathname)?.name === "home" && legacyCatalogHref(url.pathname, url.search) === null;
}

/**
 * HTML страницы без шаблонов пререндера; с lang — и с лендингом этого языка в #root.
 * prerendered — вставлен ли он (нет шаблона этого языка или #root — HTML как был)
 */
export function applyPrerender(html: string, lang: Lang | null): { html: string; prerendered: boolean } {
  let page: string | null = null;
  const stripped = html.replace(TEMPLATE_RE, (_, code: string, body: string) => {
    if (code === lang) page = body;
    return "";
  });
  const fragment: string | null = page;
  if (fragment === null || !stripped.includes(ROOT)) return { html: stripped, prerendered: false };
  return { html: stripped.replace(ROOT, () => `<div id="root">${fragment}</div>`), prerendered: true };
}
