// Свой профиль клиента и права на свои данные. Всё — с сессией клиента и под его
// актором: чужую строку RLS не отдаст, функции базы берут id только из актора.
//
//   GET    /me                   (Bearer) → 200 ClientMe: язык, имя, уведомления
//   PATCH  /me                   (Bearer) { locale } → 200 ClientMe
//   GET    /me/export            (Bearer) → 200 JSON-файл: аккаунт, профиль, согласия, заявки
//   POST   /me/consents/withdraw (Bearer) { purpose, listingId? } → 200 { withdrawn }
//   DELETE /me                   (Bearer) → 204
//
// Телефон в GET /me не входит: его читают только через функцию базы read_client_phone с
// журналом (так делает и выгрузка). Контракт — @bayramm/shared/api/me.
// Выгрузка, отзыв и удаление — функции app.client_* (миграция
// 20260930140000_platform_hardening.sql): там же журнал согласий и статусов.
// Источник записи в журналах (tma или web) — заголовок X-Bayramm-Source, как у заявок.

import { CLIENT_SOURCE_HEADER, type ClientConsentPurpose, type Locale } from "@bayramm/shared/api";
import type { ClientDataExport, ClientMe, ConsentWithdrawn } from "@bayramm/shared/api/me";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { sql } from "kysely";
import { requestIpHash } from "../auth/ip";
import { authenticate, requireClient } from "../auth/session";
import { type ClientActor, type Tx, withActor } from "../db/actor";
import { database } from "../db/middleware";
import { clientProfilesAs } from "../db/pii";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { clientSource } from "./requests";

export const me = new Hono<AppEnv>();

me.use(database, authenticate);

const WITHDRAWABLE: readonly ClientConsentPurpose[] = [
  "client_service",
  "request_transfer",
  "bot_notifications",
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const limitBody = bodyLimit({
  maxSize: 4 * 1024,
  onError: (c) => c.json(new ApiError(413, "payload_too_large", "Request body is too large").toBody(), 413),
});

const LOCALES: readonly Locale[] = ["ru", "uz"];

// Ответы /me — персональные: ни браузеру, ни прокси их не хранить
me.use(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

async function readMe(trx: Tx, actor: ClientActor): Promise<ClientMe> {
  const row = await trx
    .selectFrom("app.clients as cl")
    .leftJoin(clientProfilesAs("p"), "p.client_id", "cl.id")
    .select([
      "cl.id",
      "cl.locale",
      "cl.can_message",
      "p.first_name",
      "p.last_name",
      "p.username",
      // Уведомления включены, если последняя запись журнала по этой цели — grant (как у бота)
      sql<boolean>`coalesce((select c.action = 'grant' from app.consents c
                             where c.subject_kind = 'client' and c.subject_id = cl.id
                               and c.purpose = 'bot_notifications'
                             order by c.created_at desc limit 1), false)`.as("notifications"),
    ])
    .where("cl.id", "=", actor.id)
    .executeTakeFirst();
  if (row === undefined) throw notFound();
  return {
    id: row.id,
    locale: row.locale,
    firstName: row.first_name,
    lastName: row.last_name,
    username: row.username,
    canMessage: row.can_message,
    notifications: row.notifications,
  };
}

me.get("/", async (c) => {
  const { actor } = requireClient(c);
  return c.json(await withActor(c.var.db, actor, (trx) => readMe(trx, actor)));
});

// Язык клиента: интерфейс и сообщения бота (render уведомлений читает app.clients.locale)
me.patch("/", limitBody, async (c) => {
  const { actor } = requireClient(c);
  const { locale } = parseMePatch(await readJson(c.req.raw));
  const body = await withActor(c.var.db, actor, async (trx) => {
    await trx.updateTable("app.clients").set({ locale }).where("id", "=", actor.id).execute();
    return readMe(trx, actor);
  });
  return c.json(body);
});

// Выгрузка своих данных — файлом, без кэширования (в ответе ПДн)
me.get("/export", async (c) => {
  const { actor } = requireClient(c);
  const doc = await withActor(c.var.db, actor, async (trx) => {
    const { rows } = await sql<{ doc: ClientDataExport }>`select app.client_export() as doc`.execute(trx);
    return rows[0]?.doc;
  });
  if (doc === undefined) throw notFound();

  const day = new Date().toISOString().slice(0, 10);
  return c.json(doc, 200, {
    "Content-Disposition": `attachment; filename="bayramm-my-data-${day}.json"`,
    "Cache-Control": "no-store",
  });
});

// Отзыв согласия. Нечего отзывать — 200 { withdrawn: false }: повтор безопасен
me.post("/consents/withdraw", limitBody, async (c) => {
  const { actor } = requireClient(c);
  const { purpose, listingId } = parseWithdrawConsent(await readJson(c.req.raw));
  const source = clientSource(c.req.header(CLIENT_SOURCE_HEADER));
  const ipHash = await requestIpHash(c.req.raw.headers, c.env.ID_HASH_KEY);

  const id = await withActor(c.var.db, actor, async (trx) => {
    const { rows } = await sql<{ id: string | null }>`
      select app.client_withdraw_consent(${purpose}::app.consent_purpose, ${listingId}::uuid,
                                         ${source}::app.source, ${ipHash}::bytea) as id`.execute(trx);
    return rows[0]?.id ?? null;
  });

  return c.json({ withdrawn: id !== null } satisfies ConsentWithdrawn);
});

// Удаление аккаунта. Сессия этого запроса отзывается вместе с остальными
me.delete("/", async (c) => {
  const { actor } = requireClient(c);
  const source = clientSource(c.req.header(CLIENT_SOURCE_HEADER));
  const ipHash = await requestIpHash(c.req.raw.headers, c.env.ID_HASH_KEY);

  await withActor(c.var.db, actor, (trx) =>
    sql`select * from app.client_delete_account(${source}::app.source, ${ipHash}::bytea)`.execute(trx),
  );
  return c.body(null, 204);
});

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Body must be JSON");
  }
}

/** Тело PATCH /me: только язык, ru или uz; иначе — 422 invalid_input с полем locale */
export function parseMePatch(body: unknown): { locale: Locale } {
  const locale =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as { locale?: unknown }).locale
      : undefined;
  if (!(LOCALES as readonly unknown[]).includes(locale)) {
    throw new ApiError(422, "invalid_input", "Invalid input", ["locale"]);
  }
  return { locale: locale as Locale };
}

/**
 * Тело отзыва согласия: цель клиента; listingId — UUID, обязателен для
 * request_transfer и запрещён для остальных целей. Иначе — 400.
 */
export function parseWithdrawConsent(body: unknown): {
  purpose: ClientConsentPurpose;
  listingId: string | null;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "Body must be a JSON object");
  }
  const { purpose, listingId } = body as { purpose?: unknown; listingId?: unknown };
  if (typeof purpose !== "string" || !(WITHDRAWABLE as readonly string[]).includes(purpose)) {
    throw new ApiError(400, "invalid_request", "Unknown consent purpose");
  }
  if (purpose === "request_transfer") {
    if (typeof listingId !== "string" || !UUID_RE.test(listingId)) {
      throw new ApiError(400, "invalid_request", "listingId is required for request_transfer");
    }
    return { purpose, listingId: listingId.toLowerCase() };
  }
  if (listingId !== undefined && listingId !== null) {
    throw new ApiError(400, "invalid_request", "listingId is allowed only for request_transfer");
  }
  return { purpose: purpose as ClientConsentPurpose, listingId: null };
}
