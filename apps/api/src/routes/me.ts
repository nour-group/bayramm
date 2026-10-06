// Свой аккаунт и права на свои данные. Функции базы и RLS берут id только из
// актора: чужой аккаунт или клиента отсюда не достать.
//
//   GET    /me                      (Bearer, любая сессия) → 200 Me: аккаунт, способы входа, роли + клиент
//   PATCH  /me                      (Bearer, клиент) { locale } → 200 Me
//   POST   /me/identities/telegram  (Bearer) { initData } | { widget } → 200 Me
//   POST   /me/identities/phone     (Bearer) { phone, code }           → 200 Me
//   GET    /me/export               (Bearer, клиент) → 200 JSON-файл: аккаунт, профиль, согласия, заявки
//   POST   /me/consents/withdraw    (Bearer, клиент) { purpose, listingId? } → 200 { withdrawn }
//   DELETE /me                      (Bearer) → 204: аккаунт удалён для всех ролей
//   GET    /me/favorites            (Bearer, клиент) → 200 Favorites: опубликованные, новые сверху
//   PUT    /me/favorites/:listingId (Bearer, клиент) → 204; 404 — не опубликована; 409 favorites_full
//   DELETE /me/favorites/:listingId (Bearer, клиент) → 204
//   POST   /me/favorites            (Bearer, клиент) { listingIds } → 200 Favorites: гостевой список при входе
//
// GET /me — любая сессия (аккаунта или сотрудника): роли показывают приложениям,
// какие кнопки давать («Кабинет партнёра», «Панель оператора»). Способы входа — только
// вид и дата; телефона в ответе нет (его отдаёт только выгрузка, чтение — в журнал).
// Поля клиента (id, язык, имя, уведомления) — как ClientMe; у аккаунта без роли клиента
// id — null. Контракт — @bayramm/shared/api/me и @bayramm/shared/api/account.
//
// Добавить способ входа можно только по свежему входу (не старше 12 часов, иначе 401
// reauth_required): украденная сессия не привяжет к аккаунту чужой телефон. Способ
// другого аккаунта — 409 identity_taken, слияния нет.
//
// Выгрузка, отзыв и удаление — функции app.client_* и app.account_delete (миграции
// 20260930140000_platform_hardening.sql и 20260930190000_accounts.sql). Источник
// записи в журналах (tma или web) — заголовок X-Bayramm-Source, как у заявок.

import { CLIENT_SOURCE_HEADER, type ClientConsentPurpose, type Locale } from "@bayramm/shared/api";
import type { AccountMe } from "@bayramm/shared/api/account";
import type { ClientDataExport, ConsentWithdrawn, Me, MeClient } from "@bayramm/shared/api/me";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { sql } from "kysely";
import {
  isRecentProof,
  reauthRequired,
  type TelegramProof,
  verifyWebApp,
  verifyWidget,
} from "../auth/account";
import { phoneHash, telegramIdHash } from "../auth/crypto";
import { requestIpHash } from "../auth/ip";
import { otpSenderFor } from "../auth/otp";
import {
  accountOf,
  authenticate,
  requireAccountSession,
  requireClient,
  requireSession,
} from "../auth/session";
import { type AccountActor, type ClientActor, continueAs, type Tx, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { database } from "../db/middleware";
import { clientProfilesAs } from "../db/pii";
import type { AppEnv, SessionInfo } from "../env";
import { ApiError, notFound } from "../errors";
import {
  addFavorite,
  listFavorites,
  listingIdParam,
  mergeFavorites,
  parseListingIds,
  removeFavorite,
} from "../favorites/service";
import { checkOtp, otpInput, phoneUnavailable, readJsonObject } from "./auth";
import { clientSource } from "./requests";

export const me = new Hono<AppEnv>();

// Ответы /me — персональные: ни браузеру, ни прокси их не хранить
me.use(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});
me.use(database, authenticate);

const WITHDRAWABLE: readonly ClientConsentPurpose[] = [
  "client_service",
  "request_transfer",
  "bot_notifications",
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^[A-Za-z0-9_]{4,32}$/;
const LOCALES: readonly Locale[] = ["ru", "uz"];

const limitBody = bodyLimit({
  maxSize: 4 * 1024,
  onError: (c) => c.json(new ApiError(413, "payload_too_large", "Request body is too large").toBody(), 413),
});
// initData и поля виджета — до пары килобайт
const limitProofBody = bodyLimit({
  maxSize: 32 * 1024,
  onError: (c) => c.json(new ApiError(413, "payload_too_large", "Request body is too large").toBody(), 413),
});

// ── чтение ──────────────────────────────────────────────────────────────────

type AccountDoc = Omit<AccountMe, "session">;

async function readAccount(trx: Tx): Promise<AccountDoc> {
  const { rows } = await sql<{ doc: AccountDoc | null }>`select app.account_me() as doc`.execute(trx);
  const doc = rows[0]?.doc;
  if (doc === undefined || doc === null) throw notFound();
  return doc;
}

/** Поля клиента — под актором клиента: его строка и профиль (RLS), уведомления — по журналу согласий */
async function readClient(trx: Tx, actor: ClientActor): Promise<MeClient> {
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

/** Аккаунт и, если есть роль клиента, его поля — одной транзакцией */
async function readMe(db: Db, actor: AccountActor, session: SessionInfo): Promise<Me> {
  return withActor(db, actor, async (trx) => {
    const doc = await readAccount(trx);
    const clientId = doc.roles.client?.id;
    let client: MeClient;
    if (clientId !== undefined) {
      // Тот же человек в роли клиента: его строки читаются под его актором
      await continueAs(trx, { kind: "client", id: clientId });
      client = await readClient(trx, { kind: "client", id: clientId });
    } else {
      client = {
        id: null,
        locale: doc.account.locale,
        firstName: doc.profile.firstName,
        lastName: doc.profile.lastName,
        username: doc.profile.username,
        canMessage: false,
        notifications: false,
      };
    }
    return { ...doc, session: { kind: session.kind, app: session.app }, ...client };
  });
}

me.get("/", async (c) => {
  const { session } = requireSession(c);
  return c.json(await readMe(c.var.db, accountOf(c), session));
});

// Язык клиента: интерфейс и сообщения бота (render уведомлений читает app.clients.locale)
me.patch("/", limitBody, async (c) => {
  const { actor } = requireClient(c);
  const { locale } = parseMePatch(await readJson(c.req.raw));
  await withActor(c.var.db, actor, (trx) =>
    trx.updateTable("app.clients").set({ locale }).where("id", "=", actor.id).execute(),
  );
  const { session } = requireSession(c);
  return c.json(await readMe(c.var.db, accountOf(c), session));
});

// ── способы входа ───────────────────────────────────────────────────────────

type LinkResult = "linked" | "already" | "taken" | "kind_taken";

function linkOutcome(result: LinkResult | undefined): void {
  if (result === undefined) throw new Error("account_link_*: нет результата");
  if (result === "taken") {
    throw new ApiError(409, "identity_taken", "This sign-in method belongs to another account");
  }
  if (result === "kind_taken") {
    throw new ApiError(409, "identity_kind_taken", "The account already has a sign-in method of this kind");
  }
}

/** Добавить способ — только сессией аккаунта и по свежему входу */
function linkingSession(c: Context<AppEnv>): SessionInfo {
  const session = requireAccountSession(c);
  if (!isRecentProof(session.proofAt)) throw reauthRequired();
  return session;
}

// Обрезка по символам, а не по UTF-16: length() в Postgres считает символы
const clip = (value: string | undefined) =>
  value === undefined ? null : Array.from(value).slice(0, 128).join("");

me.post("/identities/telegram", limitProofBody, async (c) => {
  const session = linkingSession(c);
  const body = await readJsonObject(c.req.raw);
  let proof: TelegramProof;
  if (typeof body.initData === "string" && body.initData.length > 0) {
    proof = await verifyWebApp(c.env, body.initData);
  } else if (typeof body.widget === "object" && body.widget !== null && !Array.isArray(body.widget)) {
    proof = await verifyWidget(c.env, body.widget as Record<string, unknown>);
  } else {
    throw new ApiError(400, "invalid_request", "initData or widget is required");
  }
  const { user } = proof;
  const tgHash = await telegramIdHash(c.env.ID_HASH_KEY, user.id);
  const username = user.username !== undefined && USERNAME_RE.test(user.username) ? user.username : null;
  const actor = accountOf(c);
  const result = await withActor(c.var.db, actor, async (trx) => {
    const { rows } = await sql<{ result: LinkResult }>`
      select app.account_link_telegram(${tgHash}::bytea, ${user.id}::bigint, ${username}::text,
                                       ${clip(user.firstName)}::text, ${clip(user.lastName)}::text) as result`.execute(
      trx,
    );
    return rows[0]?.result;
  });
  linkOutcome(result);
  return c.json(await readMe(c.var.db, actor, session));
});

me.post("/identities/phone", limitBody, async (c) => {
  if (otpSenderFor(c.env) === null) throw phoneUnavailable();
  const session = linkingSession(c);
  const { phone, code } = otpInput(await readJsonObject(c.req.raw));
  await checkOtp(c.var.db, c.env.ID_HASH_KEY, phone, code);
  const hash = await phoneHash(c.env.ID_HASH_KEY, phone);
  const source = clientSource(c.req.header(CLIENT_SOURCE_HEADER));
  const actor = accountOf(c);
  const result = await withActor(c.var.db, actor, async (trx) => {
    const { rows } = await sql<{ result: LinkResult }>`
      select app.account_link_phone(${hash}::bytea, ${phone}::text, ${source}::app.source) as result`.execute(
      trx,
    );
    return rows[0]?.result;
  });
  linkOutcome(result);
  return c.json(await readMe(c.var.db, actor, session));
});

// ── права клиента на свои данные ────────────────────────────────────────────

// Выгрузка своих данных — файлом, без кэширования (в ответе ПДн)
me.get("/export", async (c) => {
  // Выгрузка своих данных — и заблокированному: это его право, а не услуга площадки
  const { actor } = requireClient(c, { allowBlocked: true });
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
  // Отозвать согласие можно и заблокированному
  const { actor } = requireClient(c, { allowBlocked: true });
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

// Удаление аккаунта — для всех ролей сразу: роль клиента удаляется, как раньше
// (согласия и открытые заявки отзываются, контакты и профиль стираются), членства
// партнёра и сотрудника отвязываются, профиль аккаунта стирается. Все сессии, и
// этого запроса тоже, отзываются. Удалить можно сессией аккаунта (не сотрудника)
me.delete("/", async (c) => {
  requireAccountSession(c);
  const source = clientSource(c.req.header(CLIENT_SOURCE_HEADER));
  const ipHash = await requestIpHash(c.req.raw.headers, c.env.ID_HASH_KEY);

  await withActor(c.var.db, accountOf(c), (trx) =>
    sql`select * from app.account_delete(${source}::app.source, ${ipHash}::bytea)`.execute(trx),
  );
  return c.body(null, 204);
});

// ── избранное ───────────────────────────────────────────────────────────────

me.get("/favorites", async (c) => {
  const { actor } = requireClient(c);
  return c.json(await listFavorites(c.var.db, actor));
});

me.put("/favorites/:listingId", async (c) => {
  const { actor } = requireClient(c);
  await addFavorite(c.var.db, actor, listingIdParam(c.req.param("listingId")));
  return c.body(null, 204);
});

me.delete("/favorites/:listingId", async (c) => {
  const { actor } = requireClient(c);
  await removeFavorite(c.var.db, actor, listingIdParam(c.req.param("listingId")));
  return c.body(null, 204);
});

// Гостевое избранное (браузер) — в аккаунт после входа: 100 id — около 4 КБ
me.post("/favorites", limitProofBody, async (c) => {
  const { actor } = requireClient(c);
  const body = await readJsonObject(c.req.raw);
  return c.json(await mergeFavorites(c.var.db, actor, parseListingIds(body.listingIds, "listingIds")));
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
