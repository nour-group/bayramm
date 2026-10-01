import react from "@vitejs/plugin-react";
import { createServer, type IndexHtmlTransformContext, type Plugin, type Rollup } from "vite";

/* Пререндер лендинга и подсказки загрузки — при сборке, в index.html:

   1. <template data-prerender="ru|uz"> — HTML лендинга на обоих языках (src/prerender.tsx,
      react-dom/server в Node). Воркер убирает шаблоны из каждой страницы и на главной
      вставляет вариант языка страницы в #root (worker/prerender.ts). В разработке —
      так же, только рендер на каждый запрос (правки видны сразу).
   2. Атрибуты <script src="/boot.js">: адреса кусков сборки — словари языков и экраны
      первого показа с их зависимостями. boot.js просит заранее (modulepreload) только
      нужные: словарь своего языка и экран своего маршрута. В разработке их нет.

   public/boot.js — обычный скрипт в <head> (модуль отложен до конца разбора — поздно;
   встроенный CSP не пускает), отдаётся как есть, поэтому коротко и почти без комментариев.
   До разбора body он ставит <html data-boot="show|skip">: skip — приложение покажет не этот
   пререндер: внутри Telegram корень — каталог, или язык приложения (?lang=, выбор в этой
   вкладке и в прошлые визиты, язык Telegram, язык браузера) не совпадает с языком страницы.
   public/boot.css тогда прячет пререндер: лучше пусто до первой отрисовки, чем чужой экран
   или чужой язык на миг. Его правила — копия getWebApp/launchedFromTelegram
   (@bayramm/tg/webapp) и takeLangParam/initialLang (src/context.tsx): их сверяет
   src/boot.test.ts. Упадёт boot.js — пререндер просто виден до приложения. */

type PrerenderModule = typeof import("./src/prerender");

const PRERENDER_ENTRY = "/src/prerender.tsx";
const BOOT_TAG = '<script src="/boot.js"></script>';

/** Куски сборки для boot.js: атрибут → модуль, с которого кусок начинается */
const PRELOADS = {
  "data-ru": "/packages/shared/src/i18n/ru.ts",
  "data-uz": "/packages/shared/src/i18n/uz.ts",
  "data-landing": "/apps/web/src/screens/Landing.tsx",
  "data-catalog": "/apps/web/src/screens/Catalog.tsx",
} as const;

/** Рендер в Node при сборке: отдельный сервер Vite без сети и слежения за файлами */
async function renderForBuild(root: string): Promise<Record<string, string>> {
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "error",
    appType: "custom",
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const mod = (await server.ssrLoadModule(PRERENDER_ENTRY)) as PrerenderModule;
    return await mod.renderLandings();
  } finally {
    await server.close();
  }
}

/** Кусок и все его статические зависимости, кроме тех, что уже грузит точка входа */
function closure(bundle: Rollup.OutputBundle, start: string, skip: ReadonlySet<string>): string[] {
  const files: string[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (skip.has(file) || files.includes(file)) continue;
    files.push(file);
    const chunk = bundle[file];
    if (chunk?.type === "chunk") stack.push(...chunk.imports);
  }
  return files;
}

/** Атрибуты для boot.js: адреса кусков, через пробел */
function preloadAttrs(ctx: IndexHtmlTransformContext, base: string): string {
  const { bundle, chunk: entry } = ctx;
  if (!bundle || !entry) return "";
  const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
  const entryFiles = new Set(closure(bundle, entry.fileName, new Set()));
  const attrs: string[] = [];
  for (const [attr, module] of Object.entries(PRELOADS)) {
    // Не facadeModuleId: у кусков словарей его нет (модуль за обёрткой динамического import)
    const chunk = chunks.find((item) =>
      item.moduleIds.some((id) => id.replaceAll("\\", "/").endsWith(module)),
    );
    if (!chunk) throw new Error(`prerender: нет куска сборки для ${module}`);
    const urls = closure(bundle, chunk.fileName, entryFiles).map((file) => `${base}${file}`);
    attrs.push(`${attr}="${urls.join(" ")}"`);
  }
  return attrs.join(" ");
}

/** index.html с шаблонами пререндера перед </body>: их забирает воркер (worker/prerender.ts) */
export function withTemplates(html: string, pages: Readonly<Record<string, string>>): string {
  const templates = Object.entries(pages)
    .map(([lang, page]) => `<template data-prerender="${lang}">${page}</template>`)
    .join("\n    ");
  return html.replace("</body>", () => `  ${templates}\n  </body>`);
}

export function prerenderLanding(): Plugin {
  let root = "";
  let base = "/";
  return {
    name: "bayramm:prerender-landing",
    configResolved(config) {
      root = config.root;
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      async handler(html, ctx) {
        if (!html.includes(BOOT_TAG)) throw new Error(`prerender: в index.html нет ${BOOT_TAG}`);
        const { server } = ctx;
        if (server) {
          // Разработка: ошибка в коде лендинга не должна ронять все страницы — без пререндера
          try {
            const mod = (await server.ssrLoadModule(PRERENDER_ENTRY)) as PrerenderModule;
            return withTemplates(html, await mod.renderLandings());
          } catch (error) {
            server.config.logger.error(`prerender: ${error instanceof Error ? error.stack : error}`);
            return html;
          }
        }
        // Сборка: ошибка пререндера — ошибка сборки
        const attrs = preloadAttrs(ctx, base);
        return withTemplates(
          html.replace(BOOT_TAG, () => `<script src="/boot.js" ${attrs}></script>`),
          await renderForBuild(root),
        );
      },
    },
  };
}
