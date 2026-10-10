// Уведомление из outbox → сообщение Telegram. Всё читается при отправке под актором
// system: чат и язык получателя, факты заявки. Получателя, которому уже нельзя
// писать (отозвал согласие, отключён, отвязан), не ищем обходными путями —
// строка уходит в dead с причиной.

import { type Lang, trimTrailingSlashes } from "@bayramm/shared";
import { type CatalogLinkFilters, clientCatalogPath, clientRequestPath } from "@bayramm/shared/api";
import { categoryConfig, detailsSummary, type RequestDetails } from "@bayramm/shared/categories";
import { sql } from "kysely";
import type { Tx } from "../db/actor";
import { clientProfilesAs, staffProfilesAs, vendorUserProfilesAs } from "../db/pii";
import type { AppActorKind, AppStaffRole, Json } from "../db/schema.generated";
import { type ServiceRow, selectServices, serviceName } from "../listing-services/store";
import { can } from "../staff/access";
import type { ReplyMarkup, SendMessageParams } from "../telegram/client";
import { isDay, loadDigest, loadWeekReport, REPORT_TEXTS, staffLocale } from "./reports";
import {
  ACCESS_TEXTS,
  formatDate,
  NOTICE_TEXTS,
  OPS_BUTTON,
  type OpsSlaFacts,
  opsListingSubmitted,
  opsOutboxDead,
  opsPhotosSubmitted,
  opsRevisionSubmitted,
  opsServicesSubmitted,
  opsSlaBreach,
  type RequestFacts,
  SERVICE_TEXTS,
} from "./texts";

/**
 * Вид уведомления (app.outbox.kind) — список в миграции 20260930110500_bot_outbox_sla.sql;
 * vendor.ops_reminder — напоминание от сотрудника (20260930180000_admin_v02.sql);
 * ops.revision_submitted — правка карточки от партнёра (20260930200000_revisions_phone_invites.sql);
 * ops.daily_digest, ops.weekly_report, ops.api_error — отчёты и ошибки API администраторам
 * (20260930220000_launch_metrics.sql, тексты — reports.ts);
 * ops.photos_submitted — новые фото карточки (20261001010000_cabinet_integrity.sql);
 * vendor.service_decided — решение по услуге владельцам кабинета,
 * ops.service_submitted — новые услуги и предложения правок команде
 * (20261001120100_categories_services.sql; у любой витрины, кроме отклонённой, —
 * 20261011090000_moderation_flow.sql);
 * ops.listing_submitted — витрину отправили на проверку (20261011090000_moderation_flow.sql);
 * vendor.access_granted — партнёру: его добавили в кабинет, приглашение принято
 * (20261011110000_vendor_user_invites.sql)
 */
export const NOTICE_KINDS = [
  "vendor.request_new",
  "vendor.sla_reminder",
  "vendor.ops_reminder",
  "client.request_status",
  "client.sla_breach",
  "ops.sla_breach",
  "ops.outbox_dead",
  "ops.revision_submitted",
  "ops.daily_digest",
  "ops.weekly_report",
  "ops.api_error",
  "ops.photos_submitted",
  "vendor.service_decided",
  "ops.service_submitted",
  "ops.listing_submitted",
  "vendor.access_granted",
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/**
 * Может ли сотрудник этой роли получить оповещение: о правке карточки и услугах — тот, кто
 * решает по правкам (revisions.moderate), о новых фото — тот, кто решает по фото
 * (photos.moderate), о витрине на проверке — тот, кто публикует (listings.publish),
 * остальные оповещения команды — администратору
 */
function staffMayReceive(kind: string, role: AppStaffRole): boolean {
  if (kind === "ops.revision_submitted") return can(role, "revisions.moderate");
  if (kind === "ops.photos_submitted") return can(role, "photos.moderate");
  if (kind === "ops.service_submitted") return can(role, "revisions.moderate");
  if (kind === "ops.listing_submitted") return can(role, "listings.publish");
  return role === "admin";
}

/** Строка outbox, взятая на отправку */
export interface OutboxRow {
  readonly id: string;
  readonly kind: string;
  readonly channel: string;
  readonly recipient_kind: AppActorKind;
  readonly recipient_id: string | null;
  readonly request_id: string | null;
  readonly payload: Json;
  readonly attempts: number;
}

export interface Urls {
  /** Клиентское Mini App (WEB_APP_URL): там и «Мои заявки», и каталог */
  readonly webAppUrl: string;
  /** Кабинет вендора (VENDOR_APP_URL) */
  readonly vendorAppUrl: string;
  /** Панель оператора (ADMIN_APP_URL): кнопка в оповещениях команды */
  readonly adminAppUrl: string;
}

export type Rendered =
  | { readonly ok: true; readonly message: SendMessageParams }
  /** Отправлять нечего и некому — строка уходит в dead с этой причиной */
  | { readonly ok: false; readonly reason: string };

const skip = (reason: string): Rendered => ({ ok: false, reason });

// ── ссылки ─────────────────────────────────────────────────────────────────
// Кнопка открывает Mini App сразу на нужном экране (web_app с путём):
//   · вендору — заявка в кабинете, /requests/<id>; решение по услуге — «Услуги», /services;
//   · команде — панель: правка — её страница, витрина на проверке — страница витрины, услуги
//     и фото — «Модерация» (очереди там);
//   · клиенту о статусе — эта заявка в «Моих заявках»;
//   · клиенту об отказе и просрочке — каталог «похожих»: та же дата, столько же
//     гостей, тот же район, что в заявке (пути — @bayramm/shared/api, их же
//     разбирает apps/web).

export const vendorRequestUrl = (urls: Urls, requestId: string) =>
  `${trimTrailingSlashes(urls.vendorAppUrl)}/requests/${requestId}`;

export const clientRequestUrl = (urls: Urls, requestId: string) =>
  `${trimTrailingSlashes(urls.webAppUrl)}${clientRequestPath(requestId)}`;

export const clientSimilarUrl = (urls: Urls, filters: CatalogLinkFilters) =>
  `${trimTrailingSlashes(urls.webAppUrl)}${clientCatalogPath(filters)}`;

/** Экран панели оператора (пути — apps/admin/src/router.ts): /moderation, /listings/<id>, … */
export const adminUrl = (urls: Urls, path: string) => `${trimTrailingSlashes(urls.adminAppUrl)}${path}`;

const button = (text: string, url: string): ReplyMarkup => ({
  inline_keyboard: [[{ text, web_app: { url } }]],
});

// ── получатель ─────────────────────────────────────────────────────────────

interface Recipient {
  readonly chatId: number;
  readonly lang: Lang;
  /** Для пользователя вендора — его вендор (уведомление только о своих заявках) */
  readonly vendorId: string | null;
  /** Для клиента — его id */
  readonly clientId: string | null;
}

function chatIdOf(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id !== 0 ? id : null;
}

async function recipientOf(trx: Tx, row: OutboxRow): Promise<Recipient | string> {
  const id = row.recipient_id;
  if (id === null) return "no_recipient";
  switch (row.recipient_kind) {
    case "vendor_user": {
      const user = await trx
        .selectFrom("app.vendor_users as u")
        .leftJoin(vendorUserProfilesAs("p"), "p.vendor_user_id", "u.id")
        .select(["u.vendor_id", "u.locale", "u.disabled_at", "u.tg_linked_at", "p.telegram_chat_id"])
        .where("u.id", "=", id)
        .executeTakeFirst();
      if (user === undefined || user.disabled_at !== null || user.tg_linked_at === null)
        return "vendor_user_unlinked";
      const chatId = chatIdOf(user.telegram_chat_id);
      if (chatId === null) return "vendor_user_unlinked";
      return { chatId, lang: user.locale, vendorId: user.vendor_id, clientId: null };
    }
    case "client": {
      const client = await trx
        .selectFrom("app.clients as c")
        .leftJoin(clientProfilesAs("p"), "p.client_id", "c.id")
        .select(["c.locale", "p.telegram_id", sql<boolean>`app.client_notifiable(c.id)`.as("notifiable")])
        .where("c.id", "=", id)
        .executeTakeFirst();
      // Согласие могли отозвать после постановки в очередь — проверяем при отправке
      if (client === undefined || !client.notifiable) return "client_not_notifiable";
      const chatId = chatIdOf(client.telegram_id);
      if (chatId === null) return "client_not_notifiable";
      return { chatId, lang: client.locale, vendorId: null, clientId: id };
    }
    case "staff": {
      const staff = await trx
        .selectFrom("app.staff as s")
        .innerJoin(staffProfilesAs("p"), "p.staff_id", "s.id")
        .select(["s.active", "s.role", "p.telegram_chat_id", staffLocale("s.account_id").as("locale")])
        .where("s.id", "=", id)
        .executeTakeFirst();
      if (staff === undefined || !staff.active || !staffMayReceive(row.kind, staff.role))
        return "staff_inactive";
      const chatId = chatIdOf(staff.telegram_chat_id);
      if (chatId === null) return "staff_no_chat";
      // Оповещения о заявках и правках — по-русски (панель оператора русская); отчёты и
      // ошибки API — на языке аккаунта сотрудника (reports.ts)
      return { chatId, lang: staff.locale ?? "ru", vendorId: null, clientId: null };
    }
    default:
      return "unsupported_recipient";
  }
}

// ── заявка ─────────────────────────────────────────────────────────────────

interface RequestRow {
  readonly facts: Readonly<Record<Lang, RequestFacts>>;
  /** Фильтры «похожих»: категория, дата события, гости, район площадки */
  readonly similar: CatalogLinkFilters;
  readonly clientId: string;
  readonly vendorId: string;
  readonly vendorCode: string;
  readonly slaDueAt: Date;
  /** Кто дал первый ответ: staff — «связались» отметил сотрудник, а не площадка */
  readonly firstResponseBy: AppActorKind | null;
}

async function requestOf(trx: Tx, requestId: string): Promise<RequestRow | null> {
  const row = await trx
    .selectFrom("app.requests as r")
    .innerJoin("app.listings as l", "l.id", "r.listing_id")
    .innerJoin("app.occasions as o", "o.code", "r.occasion_code")
    .innerJoin("app.vendor_accounts as v", "v.id", "r.vendor_id")
    .select([
      "r.public_no",
      "r.event_date",
      "r.guests",
      "r.client_id",
      "r.vendor_id",
      "r.created_at",
      "r.sla_due_at",
      "r.first_response_by",
      "l.name as listing",
      "l.district_code",
      "l.category_code",
      "r.details",
      "o.name_ru",
      "o.name_uz",
      "v.public_code",
      sql<string>`(select c.name_ru from app.categories c where c.code = l.category_code)`.as("category_ru"),
      sql<string>`(select c.name_uz from app.categories c where c.code = l.category_code)`.as("category_uz"),
    ])
    .where("r.id", "=", requestId)
    .executeTakeFirst();
  if (row === undefined) return null;
  const base = {
    no: String(row.public_no),
    listing: row.listing,
    date: formatDate(row.event_date),
    guests: row.guests,
    slaHours: Math.max(1, Math.round((row.sla_due_at.getTime() - row.created_at.getTime()) / 3_600_000)),
  };
  const category = categoryConfig(row.category_code);
  const details = row.details as RequestDetails;
  const districts =
    category?.requestForm.fields.some((f) => f.type === "district" && typeof details[f.key] === "string") ===
    true
      ? await trx.selectFrom("app.districts").select(["code", "name_ru", "name_uz"]).execute()
      : [];
  const summary = (lang: Lang) =>
    category === undefined
      ? []
      : detailsSummary(lang, category, details, (code) => {
          const d = districts.find((x) => x.code === code);
          return d === undefined ? undefined : lang === "ru" ? d.name_ru : d.name_uz;
        });
  return {
    facts: {
      ru: { ...base, occasion: row.name_ru, category: row.category_ru, details: summary("ru") },
      uz: { ...base, occasion: row.name_uz, category: row.category_uz, details: summary("uz") },
    },
    similar: {
      category: row.category_code,
      date: row.event_date,
      guests: row.guests,
      district: row.district_code,
    },
    clientId: row.client_id,
    vendorId: row.vendor_id,
    vendorCode: row.public_code,
    slaDueAt: row.sla_due_at,
    firstResponseBy: row.first_response_by,
  };
}

// payload — объект из id и кодов; всё остальное считаем порчей
function field(payload: Json, key: string): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

/** Неотрицательное целое из payload (счётчики оповещений) */
function count(payload: Json, key: string): number | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = payload[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Маршрут в оповещении об ошибке API: метод и шаблон, печатные ASCII (как проверяет база) */
const API_ROUTE_RE = /^[A-Z]{3,7} [!-~]{1,190}$/;

// ── сборка ─────────────────────────────────────────────────────────────────

/** Сообщение для строки outbox; now — для «сколько осталось» в напоминании */
export async function renderNotice(trx: Tx, row: OutboxRow, urls: Urls, now: Date): Promise<Rendered> {
  if (row.channel !== "telegram") return skip("unsupported_channel");
  if (!(NOTICE_KINDS as readonly string[]).includes(row.kind)) return skip("unknown_kind");
  const kind = row.kind as NoticeKind;

  const recipient = await recipientOf(trx, row);
  if (typeof recipient === "string") return skip(recipient);
  const message = (text: string, reply_markup?: ReplyMarkup): Rendered => ({
    ok: true,
    message: {
      chat_id: recipient.chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(reply_markup ? { reply_markup } : {}),
    },
  });

  // Отчёты и ошибки API: только числа — на языке администратора
  if (kind === "ops.daily_digest") {
    const day = field(row.payload, "day");
    if (!isDay(day)) return skip("bad_payload");
    return message(REPORT_TEXTS[recipient.lang].dailyDigest(await loadDigest(trx, day)));
  }

  if (kind === "ops.weekly_report") {
    const week = field(row.payload, "week");
    if (!isDay(week)) return skip("bad_payload");
    return message(REPORT_TEXTS[recipient.lang].weeklyReport(await loadWeekReport(trx, week)));
  }

  if (kind === "ops.api_error") {
    const route = field(row.payload, "route");
    const errors = count(row.payload, "errors");
    if (route === null || !API_ROUTE_RE.test(route) || errors === null) return skip("bad_payload");
    const repeated = field(row.payload, "since") !== null;
    return message(REPORT_TEXTS[recipient.lang].apiError({ route, errors, repeated }));
  }

  if (kind === "ops.outbox_dead") {
    const deadId = field(row.payload, "outbox_id");
    if (deadId === null) return skip("bad_payload");
    const dead = await trx
      .selectFrom("app.outbox as o")
      .leftJoin("app.requests as r", "r.id", "o.request_id")
      .select(["o.kind", "o.recipient_kind", "o.recipient_id", "o.attempts", "o.last_error", "r.public_no"])
      .where("o.id", "=", deadId)
      .executeTakeFirst();
    if (dead === undefined) return skip("not_found");
    return message(
      opsOutboxDead({
        kind: dead.kind,
        requestNo: dead.public_no === null ? null : String(dead.public_no),
        recipientKind: dead.recipient_kind,
        recipientRef: (dead.recipient_id ?? "—").slice(0, 8),
        attempts: dead.attempts,
        error: dead.last_error ?? "—",
      }),
    );
  }

  if (kind === "ops.revision_submitted") {
    const revisionId = field(row.payload, "revision_id");
    if (revisionId === null) return skip("bad_payload");
    const revision = await trx
      .selectFrom("app.listing_revisions as rv")
      .innerJoin("app.listings as l", "l.id", "rv.listing_id")
      .innerJoin("app.vendor_accounts as v", "v.id", "l.vendor_id")
      .select(["rv.status", "rv.payload", "l.name", "v.public_code"])
      .where("rv.id", "=", revisionId)
      .executeTakeFirst();
    if (revision === undefined) return skip("not_found");
    // Правку уже отозвали или решили — оповещать не о чем
    if (revision.status !== "pending") return skip("revision_decided");
    const payload = revision.payload;
    const fields =
      typeof payload === "object" && payload !== null && !Array.isArray(payload) ? Object.keys(payload) : [];
    return message(
      opsRevisionSubmitted({ listing: revision.name, vendorCode: revision.public_code, fields }),
      button(OPS_BUTTON, adminUrl(urls, `/revisions/${revisionId}`)),
    );
  }

  if (kind === "ops.service_submitted") {
    const listingId = field(row.payload, "listing_id");
    if (listingId === null) return skip("bad_payload");
    const listing = await trx
      .selectFrom("app.listings as l")
      .innerJoin("app.vendor_accounts as v", "v.id", "l.vendor_id")
      .innerJoin("app.categories as c", "c.code", "l.category_code")
      .select([
        "l.name",
        "l.status",
        "v.public_code",
        "c.name_ru as category",
        sql<number>`(select count(*)::int from app.listing_services s
                     where s.listing_id = l.id and (s.status = 'review' or s.proposal is not null))`.as(
          "pending",
        ),
      ])
      .where("l.id", "=", listingId)
      .executeTakeFirst();
    if (listing === undefined) return skip("not_found");
    // Уже решили (или витрину отклонили — её очереди нет) — оповещать не о чем
    if (listing.pending === 0) return skip("services_decided");
    if (listing.status === "rejected") return skip("listing_rejected");
    return message(
      opsServicesSubmitted({
        listing: listing.name,
        vendorCode: listing.public_code,
        category: listing.category,
        status: listing.status,
        pending: listing.pending,
      }),
      button(OPS_BUTTON, adminUrl(urls, "/moderation")),
    );
  }

  if (kind === "ops.listing_submitted") {
    const listingId = field(row.payload, "listing_id");
    if (listingId === null) return skip("bad_payload");
    const listing = await trx
      .selectFrom("app.listings as l")
      .innerJoin("app.vendor_accounts as v", "v.id", "l.vendor_id")
      .innerJoin("app.categories as c", "c.code", "l.category_code")
      .select(["l.name", "l.status", "v.public_code", "c.name_ru as category"])
      .where("l.id", "=", listingId)
      .executeTakeFirst();
    if (listing === undefined) return skip("not_found");
    // Уже опубликовали, вернули или отозвали — оповещать не о чем
    if (listing.status !== "review") return skip("listing_decided");
    return message(
      opsListingSubmitted({
        listing: listing.name,
        vendorCode: listing.public_code,
        category: listing.category,
      }),
      button(OPS_BUTTON, adminUrl(urls, `/listings/${listingId}`)),
    );
  }

  if (kind === "vendor.service_decided") {
    const serviceId = field(row.payload, "service_id");
    if (serviceId === null) return skip("bad_payload");
    const service = await selectServices(trx)
      .innerJoin("app.listings as l", "l.id", "s.listing_id")
      .select(["l.name as listing_name", "l.vendor_id"])
      .where("s.id", "=", serviceId)
      .executeTakeFirst();
    if (service === undefined) return skip("not_found");
    // Владельцу кабинета — только о своих витринах
    if (recipient.vendorId !== service.vendor_id) return skip("recipient_mismatch");
    const decision = field(row.payload, "decision");
    if (decision !== "approved" && decision !== "declined") return skip("bad_payload");
    const t = SERVICE_TEXTS[recipient.lang];
    return message(
      t.decided({
        service: serviceName(service as unknown as ServiceRow)[recipient.lang],
        listing: service.listing_name,
        outcome: decision,
        proposal: decision === "declined" && service.status !== "rejected",
        reason: decision === "declined" ? service.decision_reason : null,
      }),
      // Решение — про услугу: кнопка открывает «Услуги» кабинета, там и причина отказа
      button(t.button, `${trimTrailingSlashes(urls.vendorAppUrl)}/services`),
    );
  }

  if (kind === "vendor.access_granted") {
    const vendorId = field(row.payload, "vendor_id");
    if (vendorId === null || row.recipient_id === null) return skip("bad_payload");
    // Только о своём кабинете; роль и название — на момент отправки
    if (recipient.vendorId !== vendorId) return skip("recipient_mismatch");
    const access = await trx
      .selectFrom("app.vendor_users as u")
      .innerJoin("app.vendor_accounts as v", "v.id", "u.vendor_id")
      .select(["u.role", "v.name", "v.public_code"])
      .where("u.id", "=", row.recipient_id)
      .executeTakeFirst();
    if (access === undefined) return skip("not_found");
    const t = ACCESS_TEXTS[recipient.lang];
    return message(
      t.granted({
        vendor: access.name ?? access.public_code,
        role: access.role === "member" ? "member" : "owner",
      }),
      button(t.button, trimTrailingSlashes(urls.vendorAppUrl)),
    );
  }

  if (kind === "ops.photos_submitted") {
    const listingId = field(row.payload, "listing_id");
    if (listingId === null) return skip("bad_payload");
    const listing = await trx
      .selectFrom("app.listings as l")
      .innerJoin("app.vendor_accounts as v", "v.id", "l.vendor_id")
      .select([
        "l.name",
        "l.status",
        "v.public_code",
        sql<number>`(select count(*)::int from app.photos p
                     where p.listing_id = l.id and p.deleted_at is null and p.status = 'ready'
                       and p.moderation = 'pending')`.as("pending"),
      ])
      .where("l.id", "=", listingId)
      .executeTakeFirst();
    if (listing === undefined) return skip("not_found");
    // Фото уже одобрили, отклонили или удалили (или витрину отклонили) — оповещать не о чем
    if (listing.pending === 0) return skip("photos_decided");
    if (listing.status === "rejected") return skip("listing_rejected");
    return message(
      opsPhotosSubmitted({
        listing: listing.name,
        vendorCode: listing.public_code,
        status: listing.status,
        pending: listing.pending,
      }),
      button(OPS_BUTTON, adminUrl(urls, "/moderation")),
    );
  }

  const requestId = row.request_id ?? field(row.payload, "request_id");
  if (requestId === null) return skip("bad_payload");
  const request = await requestOf(trx, requestId);
  if (request === null) return skip("not_found");
  const facts = request.facts[recipient.lang];
  const t = NOTICE_TEXTS[recipient.lang];

  // Вендору — только о заявках его вендора, клиенту — только о своих
  if (kind.startsWith("vendor.") && recipient.vendorId !== request.vendorId)
    return skip("recipient_mismatch");
  if (kind.startsWith("client.") && recipient.clientId !== request.clientId)
    return skip("recipient_mismatch");

  switch (kind) {
    case "vendor.request_new":
      return message(t.requestNew(facts), button(t.buttons.openRequest, vendorRequestUrl(urls, requestId)));
    case "vendor.sla_reminder": {
      const left = Math.floor((request.slaDueAt.getTime() - now.getTime()) / 3_600_000);
      return message(
        t.slaReminder(facts, Math.max(0, left)),
        button(t.buttons.openRequest, vendorRequestUrl(urls, requestId)),
      );
    }
    case "vendor.ops_reminder":
      return message(t.opsReminder(facts), button(t.buttons.openRequest, vendorRequestUrl(urls, requestId)));
    case "client.request_status":
      switch (field(row.payload, "status")) {
        case "contacted":
          // «Связались» бывает раз — первым ответом; отметил его сотрудник — другой текст
          return message(
            request.firstResponseBy === "staff" ? t.contactedByTeam(facts) : t.contacted(facts),
            button(t.buttons.myRequest, clientRequestUrl(urls, requestId)),
          );
        case "deal":
          return message(t.deal(facts), button(t.buttons.myRequest, clientRequestUrl(urls, requestId)));
        case "declined":
          return message(
            t.declined(facts),
            button(t.buttons.similar, clientSimilarUrl(urls, request.similar)),
          );
        default:
          return skip("bad_payload");
      }
    case "client.sla_breach":
      return message(t.slaBreach(facts), button(t.buttons.similar, clientSimilarUrl(urls, request.similar)));
    case "ops.sla_breach": {
      const ops: OpsSlaFacts = { ...request.facts.ru, vendorCode: request.vendorCode };
      return message(opsSlaBreach(ops));
    }
  }
}
