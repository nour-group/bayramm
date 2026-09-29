// Адреса из переменных окружения (vars в wrangler.jsonc).

import { trimTrailingSlashes } from "@bayramm/shared";

/** Адрес без завершающего «/»; пусто или не http(s) — ошибка настройки, а не запроса */
export function httpUrl(name: string, value: string | undefined): string {
  const url = trimTrailingSlashes(value ?? "");
  const protocol = URL.canParse(url) ? new URL(url).protocol : null;
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error(`${name} не задан или не http(s)-адрес`);
  }
  return url;
}
