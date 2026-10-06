// Каталог — публичный, без входа:
//
//   GET /catalog/categories                                            → 200 CatalogCategories
//   GET /catalog/listings?category&district&date&guests&sort&cursor&limit&a.* → 200 CatalogPage
//   GET /catalog/listings/:slug[?date]                                 → 200 ListingDetail | 404
//   GET /catalog/cards?ids=<uuid>,…                                    → 200 ListingCards (избранное гостя)
//   POST /catalog/listings/:slug/contact { action, signedIn }          → 200 ListingContacts | 204 | 404
//
// Контакты витрины — не в карточке, а по «Связаться»: open — телефон и Telegram и событие
// «открыли», phone / telegram — выбранный канал. События без клиента (кто — не храним):
// только витрина, источник и вошёл ли — для «у кого чаще ищут связь» в панели. Лимит по IP —
// ratelimit.ts. Ответ не кэшируется: каждое открытие — событие
//
// Параметры проверяются до базы: неверный — 400 invalid_request (details —
// имена), чужой или испорченный курсор — 400 invalid_cursor. Контракт —
// @bayramm/shared/api; правила выдачи — catalog/service.ts.

import {
  CLIENT_SOURCE_HEADER,
  type ContactAction,
  type ListingCards,
  type ListingContacts,
} from "@bayramm/shared/api";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { dateParam, invalidRequest, parseCatalogQuery, single } from "../catalog/query";
import {
  getListingCards,
  getListingDetail,
  listCatalog,
  listCatalogCategories,
  openListingContacts,
  recordContactChoice,
} from "../catalog/service";
import { database } from "../db/middleware";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { parseIdsQuery } from "../favorites/service";
import { tashkentToday } from "../time";
import { clientSource } from "./requests";

// Выдача одинакова для всех (читается под гостем) — браузер может недолго
// держать её у себя. Занятость меняется редко; полминуты устаревания допустимо
export const CATALOG_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=60";

// Как ограничение app.listings.slug
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export const catalog = new Hono<AppEnv>();

catalog.use(database);

catalog.get("/categories", async (c) => {
  const body = await listCatalogCategories(c.var.db);
  c.header("Cache-Control", CATALOG_CACHE_CONTROL);
  return c.json(body);
});

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

const CONTACT_ACTIONS: readonly ContactAction[] = ["open", "phone", "telegram"];
/** Тело — два поля; больше не читаем */
const CONTACT_BODY_MAX = 256;
// Предел тела — до чтения: большой запрос гостя не читается в память целиком
const limitContactBody = bodyLimit({
  maxSize: CONTACT_BODY_MAX,
  onError: (c) => c.json(new ApiError(413, "payload_too_large", "Request body is too large").toBody(), 413),
});

/** { action, signedIn } — иначе 400 invalid_request с именами полей */
async function readContactInput(req: Request): Promise<{ action: ContactAction; signedIn: boolean }> {
  const text = await req.text();
  let body: unknown = null;
  try {
    body = text.length <= CONTACT_BODY_MAX ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const bad: string[] = [];
  const action = CONTACT_ACTIONS.find((a) => a === record.action);
  if (action === undefined) bad.push("action");
  if (typeof record.signedIn !== "boolean") bad.push("signedIn");
  if (action === undefined || bad.length > 0) throw invalidRequest(bad, "Invalid body");
  return { action, signedIn: record.signedIn as boolean };
}

catalog.post("/listings/:slug/contact", limitContactBody, async (c) => {
  const slug = c.req.param("slug");
  if (!SLUG_RE.test(slug)) throw notFound();
  const { action, signedIn } = await readContactInput(c.req.raw);
  const source = clientSource(c.req.header(CLIENT_SOURCE_HEADER)) === "tma" ? "tma" : "web";
  c.header("Cache-Control", "no-store");
  if (action === "open") {
    const contacts = await openListingContacts(c.var.db, slug, source, signedIn);
    if (contacts === null) throw notFound();
    return c.json(contacts satisfies ListingContacts);
  }
  if (!(await recordContactChoice(c.var.db, slug, action, source, signedIn))) throw notFound();
  return c.body(null, 204);
});
