// Уведомление из outbox → сообщение Telegram. Всё читается при отправке под актором
// system: чат и язык получателя, факты заявки. Получателя, которому уже нельзя
// писать (отозвал согласие, отключён, отвязан), не ищем обходными путями —
// строка уходит в dead с причиной.

import type { Lang } from "@bayramm/shared";
import { sql } from "kysely";
import type { Tx } from "../db/actor";
import type { AppActorKind, Json } from "../db/schema.generated";
import type { ReplyMarkup, SendMessageParams } from "../telegram/client";
import {
  formatDate,
  NOTICE_TEXTS,
  type OpsSlaFacts,
  opsOutboxDead,
  opsSlaBreach,
  type RequestFacts,
} from "./texts";

/** Вид уведомления (app.outbox.kind) — список в миграции 20260930110500_bot_outbox_sla.sql */
export const NOTICE_KINDS = [
  "vendor.request_new",
  "vendor.sla_reminder",
  "client.request_status",
  "client.sla_breach",
  "ops.sla_breach",
  "ops.outbox_dead",
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

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
}

export type Rendered =
  | { readonly ok: true; readonly message: SendMessageParams }
  /** Отправлять нечего и некому — строка уходит в dead с этой причиной */
  | { readonly ok: false; readonly reason: string };

const skip = (reason: string): Rendered => ({ ok: false, reason });

// ── ссылки ─────────────────────────────────────────────────────────────────
// Заявка в кабинете вендора — /requests/<id>. Клиенту — корень Mini App: там
// «Мои заявки» и каталог (куда вести на «похожие», решает клиентское приложение)

export const vendorRequestUrl = (urls: Urls, requestId: string) =>
  `${urls.vendorAppUrl}/requests/${requestId}`;

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
        .leftJoin("pii.vendor_user_profiles as p", "p.vendor_user_id", "u.id")
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
        .leftJoin("pii.client_profiles as p", "p.client_id", "c.id")
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
        .innerJoin("pii.staff_profiles as p", "p.staff_id", "s.id")
        .select(["s.active", "s.role", "p.telegram_chat_id"])
        .where("s.id", "=", id)
        .executeTakeFirst();
      if (staff === undefined || !staff.active || staff.role !== "admin") return "staff_inactive";
      const chatId = chatIdOf(staff.telegram_chat_id);
      if (chatId === null) return "staff_no_chat";
      // Команде — по-русски: панель оператора русская
      return { chatId, lang: "ru", vendorId: null, clientId: null };
    }
    default:
      return "unsupported_recipient";
  }
}

// ── заявка ─────────────────────────────────────────────────────────────────

interface RequestRow {
  readonly facts: Readonly<Record<Lang, RequestFacts>>;
  readonly clientId: string;
  readonly vendorId: string;
  readonly vendorCode: string;
  readonly slaDueAt: Date;
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
      "l.name as listing",
      "o.name_ru",
      "o.name_uz",
      "v.public_code",
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
  return {
    facts: { ru: { ...base, occasion: row.name_ru }, uz: { ...base, occasion: row.name_uz } },
    clientId: row.client_id,
    vendorId: row.vendor_id,
    vendorCode: row.public_code,
    slaDueAt: row.sla_due_at,
  };
}

// payload — объект из id и кодов; всё остальное считаем порчей
function field(payload: Json, key: string): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

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
    case "client.request_status":
      switch (field(row.payload, "status")) {
        case "contacted":
          return message(t.contacted(facts), button(t.buttons.openApp, urls.webAppUrl));
        case "deal":
          return message(t.deal(facts), button(t.buttons.openApp, urls.webAppUrl));
        case "declined":
          return message(t.declined(facts), button(t.buttons.similar, urls.webAppUrl));
        default:
          return skip("bad_payload");
      }
    case "client.sla_breach":
      return message(t.slaBreach(facts), button(t.buttons.similar, urls.webAppUrl));
    case "ops.sla_breach": {
      const ops: OpsSlaFacts = { ...request.facts.ru, vendorCode: request.vendorCode };
      return message(opsSlaBreach(ops));
    }
  }
}
