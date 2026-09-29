// Свой профиль клиента и права на свои данные. Всё — с сессией клиента и под его
// актором: чужую строку RLS не отдаст, функции базы берут id только из актора.
//
//   GET    /me                   (Bearer) → 200 { id, locale, firstName, … }
//   GET    /me/export            (Bearer) → 200 JSON-файл: аккаунт, профиль, согласия, заявки
//   POST   /me/consents/withdraw (Bearer) { purpose, listingId? } → 200 { withdrawn }
//   DELETE /me                   (Bearer) → 204
//
// Телефон в GET /me не входит: его читают только через функцию базы read_client_phone с
// журналом (так делает и выгрузка). Контракт — @bayramm/shared/api/me.
// Выгрузка, отзыв и удаление — функции app.client_* (миграция
// 20260930140000_platform_hardening.sql): там же журнал согласий и статусов.
// Источник записи в журналах (tma или web) — заголовок X-Bayramm-Source, как у заявок.

import { CLIENT_SOURCE_HEADER, type ClientConsentPurpose } from "@bayramm/shared/api";
import type { ClientDataExport, ConsentWithdrawn } from "@bayramm/shared/api/me";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { sql } from "kysely";
import { requestIpHash } from "../auth/ip";
import { authenticate, requireClient } from "../auth/session";
import { withActor } from "../db/actor";
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

me.get("/", async (c) => {
  const { actor } = requireClient(c);
  const row = await withActor(c.var.db, actor, (trx) =>
    trx
      .selectFrom("app.clients as cl")
      .leftJoin(clientProfilesAs("p"), "p.client_id", "cl.id")
      .select(["cl.id", "cl.locale", "cl.can_message", "p.first_name", "p.last_name", "p.username"])
      .where("cl.id", "=", actor.id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw notFound();

  return c.json({
    id: row.id,
    locale: row.locale,
    firstName: row.first_name,
    lastName: row.last_name,
    username: row.username,
    canMessage: row.can_message,
  });
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
