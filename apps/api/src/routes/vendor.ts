// Кабинет вендора: всё под /vendor — только с сессией аккаунта партнёра
// (POST /auth/telegram { app: "vendor" } или хаб входа). Контракт — @bayramm/shared/api/vendor.
//
//   GET    /vendor/me                              → 200 VendorMe (у витрин — attention: что ждёт партнёра)
//   PATCH  /vendor/me                  { locale }  → 200 VendorMe
//   GET    /vendor/requests?tab=&cursor=&limit=&listingId= → 200 VendorRequestPage
//   GET    /vendor/requests/:id                    → 200 VendorRequestDetail (new → viewed)
//   PATCH  /vendor/requests/:id        { status, declineReason?, declineNote? } → 200 VendorRequestItem
//   POST   /vendor/requests/:id/call               → 204 (нажатие на телефон — в журнал)
//   GET    /vendor/listings/:id                    → 200 VendorListing
//   GET    /vendor/listings/:id/calendar?month=    → 200 VendorCalendar (+ ETag версии)
//   PUT    /vendor/listings/:id/calendar/capacity  If-Match: <версия> { parallelCapacity } → 200
//   PUT    /vendor/listings/:id/calendar/:day[?part=] If-Match: <версия> → 200 VendorCalendarChange
//   DELETE /vendor/listings/:id/calendar/:day[?part=] If-Match: <версия> → 200 VendorCalendarChange
//   POST   /vendor/listings/:id/photos             файл, X-No-Faces: 1 | X-Photo-Consent: 1 → 201 VendorPhoto
//   DELETE /vendor/listings/:id/photos/:photoId    → 204
//   GET    /vendor/listings/:id/revisions          → 200 VendorRevisionList
//   POST   /vendor/listings/:id/revisions          ListingRevisionPayload → 201 VendorRevision
//   POST   /vendor/listings/:id/revisions/:rid/withdraw → 200 VendorRevision
//   GET    /vendor/listings/:id/services           → 200 ListingServices
//   POST   /vendor/listings/:id/services           ServiceInput → 201 ListingService
//   PATCH  /vendor/listings/:id/services/:sid      ServiceInput → 200 ListingService
//   POST   /vendor/listings/:id/services/:sid/submit | withdraw → 200 ListingService
//   DELETE /vendor/listings/:id/services/:sid      → 204
//
// Чужая заявка или листинг — 404, как несуществующие. Клиент или сотрудник с
// сессией — 403, без сессии — 401. Фото и предложения правок — только владелец
// кабинета (vendor/access.ts): сотруднику площадки — 403 vendor_owner_required. Услуги —
// тоже только владелец; календарь и сколько заказов одновременно — любой пользователь.

import { MAX_UPLOAD_BYTES } from "@bayramm/media";
import { NO_FACES_HEADER, PHOTO_CONSENT_HEADER } from "@bayramm/shared/api/vendor";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authenticate, requireVendor, vendorOf } from "../auth/session";
import { calendarEtag, versionFromIfMatch } from "../calendar/version";
import { database } from "../db/middleware";
import type { AppEnv } from "../env";
import { ApiError } from "../errors";
import { outboxKick } from "../notify/kick";
import { type PhotoDeps, photoAckFromHeaders } from "../photos/service";
import { listingPhotoStorage } from "../storage/supabase";
import { assertVendorCan } from "../vendor/access";
import {
  getCalendar,
  markBusy,
  markFree,
  parseCapacity,
  parseDay,
  parsePart,
  setCapacity,
} from "../vendor/calendar";
import { deletePhoto, uploadPhoto } from "../vendor/photos";
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
import { listRevisions, submitRevision, withdrawRevision } from "../vendor/revisions";
import {
  createVendorService,
  deleteVendorService,
  listVendorServices,
  submitVendorService,
  updateVendorService,
  withdrawVendorService,
} from "../vendor/services";

// Тела здесь крошечные: статус с причиной, язык
const limitBody = bodyLimit({
  maxSize: 4 * 1024,
  onError: (c) => c.json(new ApiError(413, "payload_too_large", "Request body is too large").toBody(), 413),
});
// Кроме правки карточки: два описания по 4000 символов и поля витрины — как в панели
const limitRevision = bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) => c.json(new ApiError(413, "payload_too_large", "Request body is too large").toBody(), 413),
});
// И фото: сам файл — до 10 МБ, запас на случай чуть большего тела; точный предел
// проверяет assertUploadable и отвечает понятной ошибкой
const limitUpload = bodyLimit({
  maxSize: MAX_UPLOAD_BYTES + 64 * 1024,
  onError: (c) =>
    c.json(new ApiError(413, "payload_too_large", "Photo is too large", ["too_large"]).toBody(), 413),
});

function photoDeps(c: Context<AppEnv>): PhotoDeps {
  return { db: c.var.db, storage: listingPhotoStorage(c.env) };
}

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
  const calendar = await getCalendar(c.var.db, vendorOf(c), id, c.req.query("month"));
  c.header("ETag", calendarEtag(calendar.version));
  return c.json(calendar);
});

// Сколько заказов витрина берёт одновременно — часть календаря: от версии (If-Match)
vendor.put("/listings/:id/calendar/capacity", limitBody, async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  const version = versionFromIfMatch(c.req.header("If-Match"));
  const capacity = parseCapacity(await readJson(c.req.raw));
  const change = await setCapacity(c.var.db, vendorOf(c), id, capacity, version);
  c.header("ETag", calendarEtag(change.version));
  return c.json(change);
});

// Правка календаря — от версии, которую видел человек (If-Match); устарела — 409 calendar_conflict.
// ?part= — часть дня (режим parts), без него — весь день
vendor.put("/listings/:id/calendar/:day", async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  const day = parseDay(c.req.param("day"));
  const part = parsePart(c.req.query("part"));
  const version = versionFromIfMatch(c.req.header("If-Match"));
  const change = await markBusy(c.var.db, vendorOf(c), id, day, version, part);
  c.header("ETag", calendarEtag(change.version));
  return c.json(change);
});

vendor.delete("/listings/:id/calendar/:day", async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  const day = parseDay(c.req.param("day"));
  const part = parsePart(c.req.query("part"));
  const version = versionFromIfMatch(c.req.header("If-Match"));
  const change = await markFree(c.var.db, vendorOf(c), id, day, version, part);
  c.header("ETag", calendarEtag(change.version));
  return c.json(change);
});

// Фото площадки: только владелец кабинета; подтверждение обязательно — «лиц нет» или (у
// категорий-портфолио) согласие людей на фото. Оповещение команде о новом фото
// опубликованной карточки ставит триггер базы
vendor.post("/listings/:id/photos", limitUpload, outboxKick, async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  const actor = vendorOf(c);
  // Роль и подтверждение — до чтения файла: незачем гнать 10 МБ
  assertVendorCan(actor, "photos.write");
  const ack = photoAckFromHeaders(c.req.header(NO_FACES_HEADER), c.req.header(PHOTO_CONSENT_HEADER));
  if (ack === null) throw new ApiError(422, "no_faces_ack_required", "Confirm that the photo shows no faces");
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  return c.json(await uploadPhoto(photoDeps(c), actor, id, bytes, c.env.APP_ENV, ack), 201);
});

vendor.delete("/listings/:id/photos/:photoId", async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  const photoId = idOrNotFound(c.req.param("photoId"));
  await deletePhoto(photoDeps(c), vendorOf(c), id, photoId);
  return c.body(null, 204);
});

vendor.get("/listings/:id/revisions", async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  return c.json(await listRevisions(c.var.db, vendorOf(c), id));
});

// Оповещение команде ставит триггер базы; outboxKick отправляет его сразу после ответа
vendor.post("/listings/:id/revisions", limitRevision, outboxKick, async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  return c.json(await submitRevision(c.var.db, vendorOf(c), id, await readJson(c.req.raw)), 201);
});

vendor.post("/listings/:id/revisions/:revisionId/withdraw", async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  const revisionId = idOrNotFound(c.req.param("revisionId"));
  return c.json(await withdrawRevision(c.var.db, vendorOf(c), id, revisionId));
});

// Услуги витрины — только владелец кабинета. Оповещение команде о новой услуге или
// предложении правки опубликованной витрины ставит триггер базы
vendor.get("/listings/:id/services", async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  return c.json(await listVendorServices(c.var.db, vendorOf(c), id));
});

vendor.post("/listings/:id/services", limitRevision, outboxKick, async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  return c.json(await createVendorService(c.var.db, vendorOf(c), id, await readJson(c.req.raw)), 201);
});

vendor.patch("/listings/:id/services/:serviceId", limitRevision, outboxKick, async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  const serviceId = idOrNotFound(c.req.param("serviceId"));
  return c.json(await updateVendorService(c.var.db, vendorOf(c), id, serviceId, await readJson(c.req.raw)));
});

vendor.post("/listings/:id/services/:serviceId/submit", outboxKick, async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  const serviceId = idOrNotFound(c.req.param("serviceId"));
  return c.json(await submitVendorService(c.var.db, vendorOf(c), id, serviceId));
});

vendor.post("/listings/:id/services/:serviceId/withdraw", async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  const serviceId = idOrNotFound(c.req.param("serviceId"));
  return c.json(await withdrawVendorService(c.var.db, vendorOf(c), id, serviceId));
});

vendor.delete("/listings/:id/services/:serviceId", async (c) => {
  const id = idOrNotFound(c.req.param("id"));
  const serviceId = idOrNotFound(c.req.param("serviceId"));
  await deleteVendorService(c.var.db, vendorOf(c), id, serviceId);
  return c.body(null, 204);
});
