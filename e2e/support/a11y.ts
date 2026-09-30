import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/* Доступность: axe-core на экране, видимое кольцо фокуса с клавиатуры, зона нажатия
   не меньше 44px (CLAUDE.md: расширять невидимым слоем, не увеличивая рисунок). */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const BLOCKING = new Set(["serious", "critical"]);

/**
 * Осознанные исключения — те же, что EXEMPT_PAIRS в packages/ui/src/pairs.ts: там
 * решение принято и объяснено, здесь axe его только не оспаривает. Новое исключение —
 * сначала туда, потом сюда
 */
const EXEMPT: readonly { readonly rule: string; readonly within: string; readonly why: string }[] = [
  {
    // Только в выборе даты: там занятый день — неактивная кнопка. В календаре карточки
    // площадки (.ui-cal.is-view) число — текст с парой muted/busy, исключения нет
    rule: "color-contrast",
    within: "button.ui-cal-day.is-busy",
    why: "busyInk на busy: занятый день выбрать нельзя, он намеренно выцветает",
  },
];

/** axe по WCAG 2.2 AA: серьёзных и критичных нарушений нет */
export async function expectNoAxeViolations(page: Page, screen: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const blocking = [];
  for (const violation of violations) {
    if (!BLOCKING.has(violation.impact ?? "")) continue;
    const exempt = EXEMPT.filter((e) => e.rule === violation.id).map((e) => e.within);
    const nodes = [];
    for (const node of violation.nodes) {
      const selector = node.target.join(" ");
      const skip =
        exempt.length > 0 &&
        (await page
          .locator(selector)
          .first()
          .evaluate((el, within) => within.some((s) => el.closest(s) !== null), exempt)
          .catch(() => false));
      if (!skip) nodes.push(`${selector} — ${node.failureSummary ?? ""}`);
    }
    if (nodes.length > 0)
      blocking.push({
        rule: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: nodes.slice(0, 5),
      });
  }
  expect(blocking, `axe: ${screen}`).toEqual([]);
}

export interface FocusStop {
  readonly element: string;
  readonly ring: boolean;
  readonly onScreen: boolean;
}

/**
 * Пройти экран клавишей Tab (steps шагов): у каждого элемента в фокусе — видимое кольцо
 * (outline или тень) и сам он на экране, а не под шапкой или за краем
 */
export async function expectVisibleFocus(page: Page, screen: string, steps = 12): Promise<void> {
  // Старт — с начала документа, как после загрузки страницы
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.getSelection()?.removeAllRanges();
  });
  const stops: FocusStop[] = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate((): FocusStop | null => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      const outline = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2;
      const shadow = style.boxShadow !== "none";
      const rect = el.getBoundingClientRect();
      const onScreen =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
      const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40);
      return {
        element: `${el.tagName.toLowerCase()}${el.className ? `.${el.className}` : ""} «${label}»`,
        ring: outline || shadow,
        onScreen,
      };
    });
    if (stop === null) break; // фокус ушёл из документа — круг пройден
    stops.push(stop);
  }
  expect(stops.length, `${screen}: Tab ведёт по элементам`).toBeGreaterThan(0);
  const bad = stops.filter((s) => !s.ring || !s.onScreen);
  expect(bad, `${screen}: фокус без кольца или за экраном`).toEqual([]);
}

export interface SmallTarget {
  readonly element: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Элементы selector, в которые нельзя попасть пальцем в квадрате min×min вокруг центра.
 * Невидимый слой (::before/::after) засчитывается: точки проверяются elementFromPoint.
 * Элементы inert-страницы под модальным слоем не считаются: они и не должны нажиматься
 */
export async function smallTargets(page: Page, selector: string, min = 44): Promise<SmallTarget[]> {
  return page.evaluate(
    ({ selector, min }) => {
      const out: SmallTarget[] = [];
      const half = min / 2 - 1;
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
        if (el.matches(":disabled, [aria-disabled='true']")) continue;
        // Под открытым списком или календарём страница inert: нажать туда нельзя по замыслу
        if (el.closest("[inert]")) continue;
        if (box.width >= min && box.height >= min) continue;
        // Подпись поля — тоже цель: <label> переключает флажок и ставит фокус. Флажок
        // в подписи не меньше min×min — зона нажатия у него и есть подпись
        const labels = [...((el as HTMLInputElement).labels ?? [])];
        if (
          labels.some((label) => {
            const l = label.getBoundingClientRect();
            return l.width >= min && l.height >= min && label.contains(el);
          })
        )
          continue;
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const points = [
          [cx - half, cy],
          [cx + half, cy],
          [cx, cy - half],
          [cx, cy + half],
        ] as const;
        const hits = points.every(([x, y]) => {
          const at = document.elementFromPoint(x, y);
          return at !== null && (el.contains(at) || labels.some((label) => label.contains(at)));
        });
        if (!hits) {
          const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30);
          out.push({
            element: `${el.tagName.toLowerCase()}.${el.className} «${label}»`,
            width: Math.round(r.width),
            height: Math.round(r.height),
          });
        }
      }
      return out;
    },
    { selector, min },
  );
}

export async function expectHitAreas(page: Page, screen: string, selector: string, min = 44): Promise<void> {
  expect(await smallTargets(page, selector, min), `${screen}: зона нажатия меньше ${min}px`).toEqual([]);
}
