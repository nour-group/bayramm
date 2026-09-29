// Кабинет вендора: всё под /vendor — только с сессией кабинета
// (POST /auth/vendor/telegram). Контракт — @bayramm/shared/api/vendor.
//
//   GET    /vendor/me                              → 200 VendorMe
//   PATCH  /vendor/me                  { locale }  → 200 VendorMe
//   GET    /vendor/requests?tab=&cursor=&limit=    → 200 VendorRequestPage
//   GET    /vendor/requests/:id                    → 200 VendorRequestDetail (new → viewed)
//   PATCH  /vendor/requests/:id        { status, declineReason?, declineNote? } → 200 VendorRequestItem
//   POST   /vendor/requests/:id/call               → 204 (нажатие на телефон — в журнал)
//   GET    /vendor/listings/:id                    → 200 VendorListing
//   GET    /vendor/listings/:id/calendar?month=    → 200 VendorCalendar
//   PUT    /vendor/listings/:id/calendar/:day      → 200 BusyDay
//   DELETE /vendor/listings/:id/calendar/:day      → 204
//
// Чужая заявка или листинг — 404, как несуществующие. Клиент или сотрудник с
// сессией — 403, без сессии — 401.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authenticate, requireVendor, vendorOf } from "../auth/session";
import { database } from "../db/middleware";
import type { AppEnv } from "../env";
import { ApiError } from "../errors";
import { outboxKick } from "../notify/kick";
import { getCalendar, markBusy, markFree, parseDay } from "../vendor/calendar";
import { getListing, getMe, parseLocale, setLocale } from "../vendor/profile";
import {
  getRequest,
  idOrNotFound,
  listRequests,
  logCallAttempt,
  parseListQuery,
  parsePatch,
  updateRequestStatus,
} from "../vendor/requests";

// Тела здесь крошечные: статус с причиной, язык
const limitBody = bodyLimit({
  maxSize: 4 * 1024,
  onError: (c) => c.json(new ApiError(413, "payload_too_large", "Request body is too large").toBody(), 413),
});

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Body must be JSON");
  }
}

export const vendor = new Hono<AppEnv>();

vendor.use(database, authenticate, requireVendor);

// Ответы кабинета — персональные: ни браузеру, ни прокси их не хранить
vendor.use(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

vendor.get("/me", async (c) => c.json(await getMe(c.var.db, vendorOf(c))));

vendor.patch("/me", limitBody, async (c) => {
  const locale = parseLocale(await readJson(c.req.raw));
  return c.json(await setLocale(c.var.db, vendorOf(c), locale));
});

vendor.get("/requests", async (c) => {
  const query = parseListQuery(c.req.query());
  return c.json(await listRequests(c.var.db, vendorOf(c), query));
});

vendor.get("/requests/:id", async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  return c.json(await getRequest(c.var.db, vendorOf(c), id));
});

// Сообщение клиенту о статусе ставит триггер базы; outboxKick отправляет его сразу после ответа
vendor.patch("/requests/:id", limitBody, outboxKick, async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  const patch = parsePatch(await readJson(c.req.raw));
  return c.json(await updateRequestStatus(c.var.db, vendorOf(c), id, patch));
});

vendor.post("/requests/:id/call", async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  await logCallAttempt(c.var.db, vendorOf(c), id);
  return c.body(null, 204);
});

vendor.get("/listings/:id", async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  return c.json(await getListing(c.var.db, vendorOf(c), id, c.env.APP_ENV));
});

vendor.get("/listings/:id/calendar", async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  return c.json(await getCalendar(c.var.db, vendorOf(c), id, c.req.query("month")));
});

vendor.put("/listings/:id/calendar/:day", async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  const day = parseDay(c.req.param("day"));
  return c.json(await markBusy(c.var.db, vendorOf(c), id, day));
});

vendor.delete("/listings/:id/calendar/:day", async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  const day = parseDay(c.req.param("day"));
  await markFree(c.var.db, vendorOf(c), id, day);
  return c.body(null, 204);
});
