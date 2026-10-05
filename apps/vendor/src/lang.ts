import { LANGS, type Lang } from "@bayramm/shared";

const STORAGE_KEY = "bayramm.vendor.lang";
/** ?lang=ru|uz — язык, на котором человек пришёл с сайта Bayramm (ссылки на кабинет) */
export const LANG_PARAM = "lang";

const isLang = (value: unknown): value is Lang => LANGS.includes(value as Lang);

/**
 * Язык из ссылки (takeLangParam): важнее сохранённого и браузерного, пока человек не выбрал
 * другой (saveLang) — и без localStorage тоже
 */
let fromLink: Lang | null = null;

/**
 * Пришли по ссылке с сайта (?lang=uz): этот язык и показать, и запомнить, а параметр убрать из
 * адреса. Один раз при загрузке — main.tsx, до первой отрисовки
 */
export function takeLangParam(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(LANG_PARAM)) return;
    const value = url.searchParams.get(LANG_PARAM);
    url.searchParams.delete(LANG_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (isLang(value)) {
      saveLang(value);
      fromLink = value;
    }
  } catch {
    // нет History API — язык как обычно
  }
}

/* Язык до входа: из ссылки с сайта, сохранённый, затем браузера. После входа источник правды —
   профиль вендора в базе. localStorage и navigator.languages есть не везде (старые вебвью,
   приватный режим) — без них просто русский. */
export function initialLang(): Lang {
  if (fromLink) return fromLink;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    // хранилище недоступно
  }
  // Первый из предпочтительных языков браузера, который у нас есть: ru-UZ → ru, uz-Latn-UZ → uz
  const preferred = window.navigator.languages ?? [window.navigator.language];
  for (const tag of preferred) {
    const code = tag?.slice(0, 2).toLowerCase();
    if (isLang(code)) return code;
  }
  return "ru";
}

export function saveLang(lang: Lang): void {
  fromLink = null;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // хранилище недоступно — язык живёт до перезагрузки
  }
}
