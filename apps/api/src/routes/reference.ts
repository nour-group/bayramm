// Справочные данные клиента — публичные, без входа:
//
//   GET /dictionaries           → 200 Dictionaries  (категории, города и районы, поводы на RU/UZ)
//   GET /consent-texts[?locale] → 200 ConsentTexts  (действующие тексты согласий клиента)
//
// Меняются редко (справочники — миграцией, тексты — новой версией), поэтому
// кэшируются в браузере и отдаются с ETag: повторный запрос — 304 без тела.
// Текст, выведенный из оборота, пока лежал в кэше, база не примет
// (consent_text_not_current) — клиент перезапросит тексты.

import type { Locale } from "@bayramm/shared/api";
import { Hono } from "hono";
import { etag } from "hono/etag";
import { invalidRequest, single } from "../catalog/query";
import { getConsentTexts, getDictionaries } from "../catalog/service";
import { database } from "../db/middleware";
import type { AppEnv } from "../env";

export const DICTIONARIES_CACHE_CONTROL = "public, max-age=600, stale-while-revalidate=86400";
export const CONSENT_TEXTS_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";

const LOCALES: readonly Locale[] = ["ru", "uz"];

export const reference = new Hono<AppEnv>();

// Промежуточные обработчики — на маршрутах, а не reference.use: роутер
// монтируется в корень, и use(…) сработал бы на всех путях API
reference.get("/dictionaries", etag(), database, async (c) => {
  const dictionaries = await getDictionaries(c.var.db);
  c.header("Cache-Control", DICTIONARIES_CACHE_CONTROL);
  return c.json(dictionaries);
});

reference.get("/consent-texts", etag(), database, async (c) => {
  const bad: string[] = [];
  const value = single(c.req.queries(), "locale", bad);
  if (value !== null && !(LOCALES as readonly string[]).includes(value)) bad.push("locale");
  if (bad.length > 0) throw invalidRequest(bad, "Invalid query parameters");

  const texts = await getConsentTexts(c.var.db, value as Locale | null);
  c.header("Cache-Control", CONSENT_TEXTS_CACHE_CONTROL);
  return c.json(texts);
});
