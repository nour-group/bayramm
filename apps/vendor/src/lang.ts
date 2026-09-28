import { LANGS, type Lang } from "@bayramm/shared";

const STORAGE_KEY = "bayramm.vendor.lang";

const isLang = (value: unknown): value is Lang => LANGS.includes(value as Lang);

/* Язык до входа. После входа источник правды — профиль вендора в базе.
   localStorage и navigator.languages есть не везде (старые вебвью, приватный режим) —
   без них просто русский. */
export function initialLang(): Lang {
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
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // хранилище недоступно — язык живёт до перезагрузки
  }
}
