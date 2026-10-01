// @vitest-environment jsdom
import { dictionaries, LANGS } from "@bayramm/shared";
import { describe, expect, it } from "vitest";
import { renderLanding, renderLandings } from "./prerender";

/* Пререндер лендинга при сборке (Node, react-dom/server): статичная часть экрана на обоих
   языках, без данных API, без того, что не пропустит CSP, и по правилам продукта */

const NOW = Date.parse("2026-10-01T07:00:00Z");

/** Текст разметки: все текстовые узлы через пробел (разбор DOMParser, не регулярками) */
function text(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.textContent ?? "");
  return parts.join(" ").replace(/\s+/g, " ");
}

describe("пререндер лендинга", () => {
  for (const lang of LANGS) {
    it(`${lang}: первый экран, подбор, как это работает, обещания, площадкам, вопросы, подвал`, async () => {
      const t = dictionaries[lang];
      const html = await renderLanding(lang, NOW);
      const body = text(html);

      expect(html.startsWith(`<div data-prerendered="${lang}">`)).toBe(true);
      expect(html).toMatch(/<h1 class="ln-title"[^>]*>/);
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      for (const line of [t.lnKicker, t.lnTitle, t.lnLead, t.lnSearch, t.lnBrowse, t.lnHowH, t.lnPromH]) {
        expect(body).toContain(line);
      }
      for (const line of [...t.lnStepH, ...t.lnPromT, t.lnPartnerH, t.lnFaqH, ...t.lnFaqQ, t.ftAbout]) {
        expect(body).toContain(line);
      }
      // Подбор — форма с полями даты, гостей и района; ссылки — настоящие адреса
      expect(html).toContain('class="ln-search"');
      expect(html).toContain('href="/catalog"');
      expect(html).toContain('href="/docs"');
      // Гость: «Войти» в хаб с возвратом на главную; подвал сайта; вкладки
      expect(html).toContain('href="/auth?return=%2F"');
      expect(html).toContain('class="site-footer"');
      expect(body).toContain("© 2026 Bayramm");
    });
  }

  it("залы не пререндерим: на их месте заготовки (без сдвига, когда придут), без данных", async () => {
    const html = await renderLanding("ru", NOW);
    expect(html).toContain('class="ln-section ln-venues"');
    expect(html.match(/class="card-skeleton"/g)).toHaveLength(4);
    expect(html).not.toContain('class="card"');
    // Ссылки, которые знает только API (кабинет, бот), — после JS
    expect(html).not.toContain("t.me/");
  });

  it("ни скриптов, ни стилей в атрибутах (CSP), ни демо-режима", async () => {
    const pages = await renderLandings(NOW);
    expect(Object.keys(pages).sort()).toEqual([...LANGS].sort());
    for (const html of Object.values(pages)) {
      expect(html).not.toMatch(/<script|<style|\sstyle="|\son[a-z]+="/i);
      expect(html).not.toContain("demo-ribbon");
    }
  });

  it("правила продукта: заявка, не бронь; ни рейтингов, ни отзывов (как rules.test.tsx)", async () => {
    for (const html of Object.values(await renderLandings(NOW))) {
      const body = text(html);
      expect(body).not.toMatch(/брон|bron|band\s+qil/i);
      expect(body).not.toMatch(/★|рейтинг|reyting|отзыв|sharh/i);
    }
  });
});
