// Обработка сообщения боту: /start и привязка вендора по контакту.
//
// Всё, что пишется в базу, — в одной транзакции под актором system вместе с
// отметкой update_id (app.telegram_updates): повтор доставки ничего не делает
// второй раз, а упавшая обработка откатывает и отметку — Telegram повторит.
// Ответы в чат уходят после коммита (routes/telegram.ts), их отправка — best effort.
//
// Вход вендора: сотрудник заводит пользователя вендора с телефоном, вендор жмёт
// «Я партнёр» и делится контактом. Telegram даёт так отправить только свой
// номер — поэтому принимаем контакт, только если contact.user_id = from.id.
// Номер сверяем по HMAC (phone_hash), привязывает app.vendor_user_claim_telegram.
// Не нашли или контакт чужой — вежливый ответ, в базе ничего не остаётся.
// Дальше кабинет вендора открывается кнопкой бота (Mini App, VENDOR_APP_URL).
//
// В лог — только исход, без номера, текста и Telegram ID.

import { sql } from "kysely";
import { phoneHash, telegramIdHash } from "../auth/crypto";
import { normalizeUzPhone } from "../auth/phone";
import { SYSTEM, type Tx, withActor } from "../db/actor";
import type { Db } from "../db/client";
import type { ReplyMarkup, SendMessageParams } from "../telegram/client";
import { BOT_TEXTS, type BotTexts, botLang, STAFF_STARTED } from "./texts";
import type { BotMessage, BotUpdate } from "./update";

/** Параметр ссылки t.me/<бот>?start=partner — сразу просьба поделиться номером */
export const PARTNER_START_PAYLOAD = "partner";

export interface BotConfig {
  /** ID_HASH_KEY: псевдонимы Telegram ID и телефонов */
  readonly idHashKey: string;
  /** Клиентское Mini App (WEB_APP_URL) */
  readonly webAppUrl: string;
  /** Кабинет вендора (VENDOR_APP_URL) */
  readonly vendorAppUrl: string;
}

export type Reply = SendMessageParams;

export type ClaimResult = "claimed" | "linked" | "linked_elsewhere" | "telegram_taken" | "not_found";

type ContactMessage = Extract<BotMessage, { kind: "contact" }>;

// ── клавиатуры ─────────────────────────────────────────────────────────────

const webAppButton = (text: string, url: string): ReplyMarkup => ({
  inline_keyboard: [[{ text, web_app: { url } }]],
});

const partnerKeyboard = (t: BotTexts): ReplyMarkup => ({
  keyboard: [[{ text: t.partnerButton, request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
});

const REMOVE_KEYBOARD: ReplyMarkup = { remove_keyboard: true };

// ── ответы ─────────────────────────────────────────────────────────────────

export interface StartedAs {
  /** Действующий сотрудник: оповещения команды будут приходить в этот чат */
  readonly staff: boolean;
  /** Привязанный пользователь вендора */
  readonly vendor: boolean;
}

/**
 * Ответ на /start и любое другое сообщение: приветствие с кнопкой приложения;
 * вендору — кнопка кабинета, остальным — просьба поделиться номером, если они
 * партнёры. /start partner — сразу просьба (или кабинет, если уже привязан)
 */
export function startReplies(
  config: BotConfig,
  chatId: number,
  languageCode: string | undefined,
  payload: string | null,
  who: StartedAs,
): Reply[] {
  const t = BOT_TEXTS[botLang(languageCode)];
  const replies: Reply[] = [];
  if (payload !== PARTNER_START_PAYLOAD) {
    replies.push({
      chat_id: chatId,
      text: t.welcome,
      reply_markup: webAppButton(t.openApp, config.webAppUrl),
    });
  }
  if (who.vendor) {
    replies.push({
      chat_id: chatId,
      text: t.vendorLinked,
      reply_markup: webAppButton(t.openCabinet, config.vendorAppUrl),
    });
  } else {
    replies.push({ chat_id: chatId, text: t.partnerPrompt, reply_markup: partnerKeyboard(t) });
  }
  if (who.staff) replies.push({ chat_id: chatId, text: STAFF_STARTED });
  return replies;
}

/** Ответ на контакт: привязали — клавиатуру убрать и дать кнопку кабинета */
export function claimReplies(
  config: BotConfig,
  chatId: number,
  languageCode: string | undefined,
  result: ClaimResult | "not_own",
): Reply[] {
  const t = BOT_TEXTS[botLang(languageCode)];
  switch (result) {
    case "claimed":
    case "linked":
      return [
        { chat_id: chatId, text: t.claimed, reply_markup: REMOVE_KEYBOARD },
        {
          chat_id: chatId,
          text: t.cabinetHint,
          reply_markup: webAppButton(t.openCabinet, config.vendorAppUrl),
        },
      ];
    case "not_own":
      return [{ chat_id: chatId, text: t.notOwnContact, reply_markup: partnerKeyboard(t) }];
    case "not_found":
      return [{ chat_id: chatId, text: t.notFound, reply_markup: REMOVE_KEYBOARD }];
    case "linked_elsewhere":
      return [{ chat_id: chatId, text: t.linkedElsewhere, reply_markup: REMOVE_KEYBOARD }];
    case "telegram_taken":
      return [{ chat_id: chatId, text: t.telegramTaken, reply_markup: REMOVE_KEYBOARD }];
  }
}

// ── обработка ──────────────────────────────────────────────────────────────

/** Контакт, готовый к сверке: свой ли он, номер в нормальной форме и его хэш */
type PreparedContact =
  | { readonly kind: "not_own" }
  | { readonly kind: "not_uz" }
  | { readonly kind: "phone"; readonly phone: string; readonly hash: Uint8Array };

async function prepareContact(config: BotConfig, update: BotUpdate, contact: ContactMessage) {
  if (contact.userId !== update.from.id) return { kind: "not_own" } as const;
  const phone = normalizeUzPhone(contact.phone);
  if (phone === null) return { kind: "not_uz" } as const;
  return { kind: "phone", phone, hash: await phoneHash(config.idHashKey, phone) } as const;
}

/** Первая ли это доставка обновления: отметка update_id в этой же транзакции */
async function firstDelivery(trx: Tx, updateId: number): Promise<boolean> {
  const row = await trx
    .insertInto("app.telegram_updates")
    .values({ update_id: updateId })
    .onConflict((oc) => oc.column("update_id").doNothing())
    .returning("update_id")
    .executeTakeFirst();
  return row !== undefined;
}

async function claim(
  trx: Tx,
  update: BotUpdate,
  tgHash: Uint8Array,
  contact: Extract<PreparedContact, { kind: "phone" }>,
): Promise<ClaimResult> {
  const { rows } = await sql<{ result: ClaimResult; vendor_user_id: string | null }>`
    select result, vendor_user_id
    from app.vendor_user_claim_telegram(${contact.hash}::bytea, ${contact.phone}::text, ${tgHash}::bytea,
                                        ${update.from.id}::bigint, ${update.chatId}::bigint)`.execute(trx);
  const row = rows[0];
  if (row === undefined) throw new Error("vendor_user_claim_telegram: нет результата");
  if (row.result === "claimed") console.info("bot: vendor user linked", { vendorUserId: row.vendor_user_id });
  else console.info("bot: contact", { result: row.result });
  return row.result;
}

async function started(trx: Tx, update: BotUpdate, tgHash: Uint8Array): Promise<StartedAs> {
  const { rows } = await sql<StartedAs>`
    select staff, vendor from app.telegram_started(${tgHash}::bytea, ${update.chatId}::bigint)`.execute(trx);
  return rows[0] ?? { staff: false, vendor: false };
}

/** Обрабатывает сообщение и возвращает ответы, которые надо отправить после коммита */
export async function handleUpdate(db: Db, config: BotConfig, update: BotUpdate): Promise<Reply[]> {
  const { message, chatId, from } = update;
  const tgHash = await telegramIdHash(config.idHashKey, from.id);
  const contact = message.kind === "contact" ? await prepareContact(config, update, message) : null;

  return withActor(db, SYSTEM, async (trx) => {
    if (!(await firstDelivery(trx, update.updateId))) {
      console.info("bot: repeated update skipped");
      return [];
    }

    if (contact !== null) {
      if (contact.kind === "not_own") {
        console.info("bot: contact", { result: "not_own" });
        return claimReplies(config, chatId, from.languageCode, "not_own");
      }
      if (contact.kind === "not_uz") {
        console.info("bot: contact", { result: "not_uz" });
        return claimReplies(config, chatId, from.languageCode, "not_found");
      }
      const result = await claim(trx, update, tgHash, contact);
      return claimReplies(config, chatId, from.languageCode, result);
    }

    const who = await started(trx, update, tgHash);
    const payload = message.kind === "start" ? message.payload : null;
    return startReplies(config, chatId, from.languageCode, payload, who);
  });
}
