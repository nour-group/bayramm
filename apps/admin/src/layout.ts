/* Раскладка панели по ширине окна. Одна точка правды для разметки (React) и стилей
   (styles.css держит те же границы в @media):
     · phone   — уже 720px: шапка с заголовком, нижняя панель разделов, списки — карточками;
     · tablet  — 720–1023px: узкая колонка разделов слева (иконка и подпись);
     · desktop — от 1024px: шапка с разделами в строку, списки — таблицами.
   matchMedia есть не везде (ловушка №5): без него — ширина окна и событие resize. */

import { useEffect, useState } from "react";

export type Layout = "phone" | "tablet" | "desktop";

/** Последняя ширина телефонной раскладки и планшетной, px — как в @media styles.css */
export const PHONE_MAX = 719;
export const TABLET_MAX = 1023;

const PHONE_QUERY = `(max-width: ${PHONE_MAX}px)`;
const TABLET_QUERY = `(max-width: ${TABLET_MAX}px)`;

/** Раскладка по ширине; 0 (ширину не узнать) — компьютер */
export function layoutOf(width: number): Layout {
  if (width > 0 && width <= PHONE_MAX) return "phone";
  if (width > 0 && width <= TABLET_MAX) return "tablet";
  return "desktop";
}

function hasMatchMedia(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

/** Раскладка сейчас: по медиазапросам (как у стилей), без них — по ширине окна */
export function currentLayout(): Layout {
  if (hasMatchMedia()) {
    if (window.matchMedia(PHONE_QUERY).matches) return "phone";
    if (window.matchMedia(TABLET_QUERY).matches) return "tablet";
    return "desktop";
  }
  if (typeof window === "undefined") return "desktop";
  return layoutOf(window.innerWidth || document.documentElement?.clientWidth || 0);
}

/** Раскладка и её смена при повороте телефона или изменении окна */
export function useLayout(): Layout {
  const [layout, setLayout] = useState<Layout>(currentLayout);
  useEffect(() => {
    const update = () => setLayout(currentLayout());
    update();
    if (hasMatchMedia()) {
      const queries = [window.matchMedia(PHONE_QUERY), window.matchMedia(TABLET_QUERY)];
      // Старые Safari знают только addListener
      for (const query of queries) {
        if (typeof query.addEventListener === "function") query.addEventListener("change", update);
        else query.addListener?.(update);
      }
      return () => {
        for (const query of queries) {
          if (typeof query.removeEventListener === "function") query.removeEventListener("change", update);
          else query.removeListener?.(update);
        }
      };
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return layout;
}

/** Телефонная раскладка: списки карточками, действия — в панели внизу */
export function usePhone(): boolean {
  return useLayout() === "phone";
}
