// Каталог — публичный, без входа:
//
//   GET /catalog/listings?category&district&date&guests&sort&cursor&limit → 200 CatalogPage
//   GET /catalog/listings/:slug[?date]                                 → 200 ListingDetail | 404
//   GET /catalog/cards?ids=<uuid>,…                                    → 200 ListingCards (избранное гостя)
//
// Параметры проверяются до базы: неверный — 400 invalid_request (details —
// имена), чужой или испорченный курсор — 400 invalid_cursor. Контракт —
// @bayramm/shared/api; правила выдачи — catalog/service.ts.

import type { ListingCards } from "@bayramm/shared/api";
import { Hono } from "hono";
import { dateParam, invalidRequest, parseCatalogQuery, single } from "../catalog/query";
import { getListingCards, getListingDetail, listCatalog } from "../catalog/service";
import { database } from "../db/middleware";
import type { AppEnv } from "../env";
import { notFound } from "../errors";
import { parseIdsQuery } from "../favorites/service";
import { tashkentToday } from "../time";

// Выдача одинакова для всех (читается под гостем) — браузер может недолго
// держать её у себя. Занятость меняется редко; полминуты устаревания допустимо
export const CATALOG_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=60";

// Как ограничение app.listings.slug
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export const catalog = new Hono<AppEnv>();

catalog.use(database);

catalog.get("/listings", async (c) => {
  const params = parseCatalogQuery(c.req.queries());
  const page = await listCatalog(c.var.db, params);
  c.header("Cache-Control", CATALOG_CACHE_CONTROL);
  return c.json(page);
});

// Избранное гостя: id хранит браузер, карточки — отсюда. Снятые с публикации в ответ не
// попадают — у гостя они просто исчезают из списка
catalog.get("/cards", async (c) => {
  const bad: string[] = [];
  const ids = parseIdsQuery(single(c.req.queries(), "ids", bad) ?? undefined);
  if (bad.length > 0) throw invalidRequest(bad, "Invalid query parameters");
  const items = await getListingCards(c.var.db, ids);
  c.header("Cache-Control", CATALOG_CACHE_CONTROL);
  return c.json({ items } satisfies ListingCards);
});

catalog.get("/listings/:slug", async (c) => {
  const slug = c.req.param("slug");
  const bad: string[] = [];
  const date = dateParam(c.req.queries(), bad);
  if (bad.length > 0) throw invalidRequest(bad, "Invalid query parameters");
  // Слаг другого вида в базе не бывает — нечего и спрашивать
  if (!SLUG_RE.test(slug)) throw notFound();

  const detail = await getListingDetail(c.var.db, slug, date, tashkentToday());
  if (detail === null) throw notFound();
  c.header("Cache-Control", CATALOG_CACHE_CONTROL);
  return c.json(detail);
});
