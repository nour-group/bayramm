import { readFileSync } from "node:fs";
import { echoApi, spaAssets } from "@bayramm/edge/testing";
import { dictionaries } from "@bayramm/shared";
import { describe, expect, it, vi } from "vitest";
import { renderLandings } from "../src/prerender";
import { withTemplates } from "../vite-prerender";
import { applyPrerender, wantsPrerender } from "./prerender";

// Под Vitest import.meta.env.DEV = true; проверяем воркер таким, каким он будет в сборке
vi.stubEnv("DEV", false);
const { default: worker } = await import("./index");

/* Воркер и пререндер лендинга: index.html со шаблонами обоих языков, как его собирает
   vite-prerender.ts; в ответ уходит только вариант языка страницы и только на главной */

const ORIGIN = "https://bayramm.uz";
const SOURCE_HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const PAGES = await renderLandings(Date.parse("2026-10-01T07:00:00Z"));
const BUILT_HTML = withTemplates(SOURCE_HTML, PAGES);

function setup(html = BUILT_HTML) {
  const env = {
    SEARCH_INDEXING: "off",
    ASSETS: spaAssets({ "/index.html": { body: html, type: "text/html" } }),
    API: echoApi(),
  };
  const get = async (path: string, init?: RequestInit) => {
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
    return { res, body: await res.text() };
  };
  return { get };
}

const h1 = (body: string) => /<h1 class="ln-title"[^>]*>([^<]*)<\/h1>/.exec(body)?.[1] ?? null;
const root = (body: string) => /<div id="root">([\s\S]*?)<\/div>\s*<script/.exec(body)?.[1] ?? "";

describe("пререндер лендинга в HTML страницы", () => {
  it("главная: лендинг на языке страницы (узбекский) прямо в #root, шаблонов нет", async () => {
    const { res, body } = await setup().get("/");
    expect(res.status).toBe(200);
    expect(body).toContain('<html lang="uz"');
    expect(body).toContain('<div id="root"><div data-prerendered="uz">');
    expect(h1(body)).toBe(dictionaries.uz.lnTitle);
    expect(body).not.toContain("<template");
    expect(body).not.toContain('data-prerendered="ru"');
    // Текст для тех, кто без JS, уже в #root: второго заголовка из <noscript> нет
    expect(body).not.toContain("<noscript>");
    expect(body.match(/<h1\b/g)).toHaveLength(1);
  });

  it("?lang=ru — русский пререндер у русской версии страницы", async () => {
    const { body } = await setup().get("/?lang=ru");
    expect(body).toContain('<html lang="ru"');
    expect(body).toContain('<div data-prerendered="ru">');
    expect(h1(body)).toBe(dictionaries.ru.lnTitle);
    expect(body).toContain(dictionaries.ru.lnFaqH);
  });

  it("CSP: в ответе ни встроенных скриптов, ни стилей; скрипты — только свои файлы", async () => {
    const { res, body } = await setup().get("/");
    expect(res.headers.get("content-security-policy")).not.toContain("'unsafe-inline'");
    expect(body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(body).not.toMatch(/<style|\sstyle=/);
    const scripts = [...body.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts).toEqual(["/boot.js", "/src/main.tsx"]);
  });

  it("другие страницы — без пререндера и шаблонов, как раньше (с <noscript>)", async () => {
    const { get } = setup();
    for (const path of ["/catalog", "/docs", "/venue/lola-hall", "/auth", "/nope"]) {
      const { body } = await get(path);
      expect(root(body), path).toBe("");
      expect(body, path).not.toContain("<template");
      expect(body, path).not.toContain("data-prerendered");
      expect(body, path).toContain("<noscript>");
    }
  });

  it("старая ссылка на каталог в корне (/?date=…) — без лендинга: приложение уведёт в каталог", async () => {
    const { body } = await setup().get("/?date=2026-10-20&guests=120");
    expect(root(body)).toBe("");
    expect(body).not.toContain("<template");
  });

  it("HEAD — без тела", async () => {
    const { res, body } = await setup().get("/", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(body).toBe("");
  });

  it("сборка без шаблонов (их нет в index.html) — страница как раньше", async () => {
    const { body } = await setup(SOURCE_HTML).get("/");
    expect(root(body)).toBe("");
    expect(body).toContain("<noscript>");
  });
});

describe("applyPrerender и wantsPrerender", () => {
  const html = withTemplates('<html lang="uz"><body><div id="root"></div></body></html>', {
    ru: "<p>ru</p>",
    uz: "<p>uz</p>",
  });

  it("убирает шаблоны всегда, вставляет только нужный язык", () => {
    expect(applyPrerender(html, null)).toEqual({
      html: '<html lang="uz"><body><div id="root"></div>\n  </body></html>',
      prerendered: false,
    });
    expect(applyPrerender(html, "ru")).toEqual({
      html: '<html lang="uz"><body><div id="root"><p>ru</p></div>\n  </body></html>',
      prerendered: true,
    });
  });

  it("нет #root или шаблона языка — ничего не вставляем", () => {
    expect(applyPrerender(html.replace('<div id="root"></div>', ""), "uz").prerendered).toBe(false);
    expect(applyPrerender('<div id="root"></div>', "uz").prerendered).toBe(false);
  });

  it("только главная и не старая ссылка на каталог", () => {
    const want = (path: string) => wantsPrerender(new URL(path, ORIGIN));
    expect(want("/")).toBe(true);
    expect(want("/?lang=ru")).toBe(true);
    expect(want("/?utm_source=tg")).toBe(true);
    expect(want("/?date=2026-10-20")).toBe(false);
    expect(want("/catalog")).toBe(false);
    expect(want("/venue/lola")).toBe(false);
  });
});
