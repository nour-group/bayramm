// Вход: один аккаунт, откуда угодно. Контракт — @bayramm/shared/api/account.
//
//   GET  /auth/methods                                 → 200 AuthMethods
//   POST /auth/telegram         { initData, app? }     → 200 SessionToken  Mini App: клиент (web), кабинет (vendor)
//   POST /auth/vendor/telegram  { initData }           → 200 SessionToken  устарел: то же, что app: vendor
//   POST /auth/widget           { widget, locale? }    → 200 SessionToken  хаб входа на сайте
//   POST /auth/phone/send       { phone, turnstileToken? | initData? } → 200 OtpSent
//   POST /auth/phone/verify     { phone, code }        → 200 SessionToken  хаб входа на сайте
//   POST /auth/hub/code         (Bearer) HubCodeRequest → 200 HubCode
//   POST /auth/hub/exchange     HubExchange            → 200 SessionToken  кабинет, панель (их Origin)
//   POST /auth/staff/elevate    (Bearer)               → 200 SessionToken  сессия сотрудника
//   POST /auth/staff/webapp     { initData }           → 200 SessionToken  панель как Mini App
//   POST /auth/staff/telegram   { поля виджета }       → 200 SessionToken  устарел: виджет на домене панели
//   POST /auth/logout           (Bearer)               → 204               любая сессия
//
// Подписанные данные Telegram проверяются токеном бота, код из сообщения — базой;
// всё, что в них есть, читается только после проверки. Аккаунт, роли и профиль
// пишут функции базы под актором system (auth/account.ts). Сессия — случайный
// токен, в базе только его sha256. Вход в клиентское приложение (Mini App клиента,
// хаб) создаёт роль клиента; в кабинет — только партнёру.
//
// Ограничение частоты по IP — middleware перед маршрутами (src/ratelimit.ts); коды из
// сообщения считает ещё и база: раз в минуту, три за 10 минут на номер и на IP. Сам код
// на телефон просит человек: с TURNSTILE_SECRET_KEY браузер присылает токен Turnstile
// (хаб /auth), Mini App — свою initData (auth/turnstile.ts).
//
// Устаревшие адреса (/auth/vendor/telegram, /auth/staff/telegram) приложения больше не
// вызывают: они остаются для старых сборок, открытых во вкладках и вебвью, и пишут в лог
// каждое обращение (legacyEndpoint). Когда обращений не станет — удалить.

import type { OtpSent } from "@bayramm/shared/api/account";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { sql } from "kysely";
import {
  ensureClient,
  issueAccountSession,
  localeOf,
  sessionBody,
  signInPhone,
  signInTelegram,
  verifyWebApp,
  verifyWidget,
} from "../auth/account";
import { phoneHash } from "../auth/crypto";
import { exchangeHubCode, issueHubCode, parseHubCodeRequest, parseHubExchange } from "../auth/hub";
import { clientIp, requestIpHash } from "../auth/ip";
import {
  generateOtpCode,
  normalizeOtpCode,
  OTP_RESEND_SECONDS,
  OTP_TTL_SECONDS,
  OtpDeliveryError,
  otpCodeHash,
  otpSenderFor,
} from "../auth/otp";
import { normalizeUzPhone } from "../auth/phone";
import { authenticate, requireAccountSession, requireSession } from "../auth/session";
import { elevateSession, signInStaff, signInStaffWebApp } from "../auth/staff";
import { turnstileEnabled, turnstileSiteKey, verifyTurnstile } from "../auth/turnstile";
import { assertPartner, membershipsIn } from "../auth/vendor";
import { httpUrl } from "../config";
import { SYSTEM, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { database } from "../db/middleware";
import type { AppEnv } from "../env";
import { ApiError } from "../errors";
import { BOT_USERNAME_RE, botUsername, defaultCache } from "../telegram/bot-info";
import { telegramClient } from "../telegram/client";

// initData — около килобайта, пакет tg режет всё длиннее 16 КБ; данные виджета ещё меньше
const MAX_BODY_BYTES = 32 * 1024;
const BOT_INFO_TIMEOUT_MS = 5_000;

const limitBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json(new ApiError(413, "payload_too_large", "Request body is too large").toBody(), 413),
});

export const phoneUnavailable = () =>
  new ApiError(503, "phone_unavailable", "Phone sign-in is not available here");
export const invalidPhone = () =>
  new ApiError(400, "invalid_phone", "Phone must be an Uzbek number +998XXXXXXXXX");

export const auth = new Hono<AppEnv>();

/**
 * Обращение к устаревшему адресу входа — в лог: по нему видно, когда адрес можно
 * удалить. Без данных запроса — только путь
 */
function legacyEndpoint(path: "/auth/vendor/telegram" | "/auth/staff/telegram"): void {
  console.warn("auth.legacy: deprecated endpoint used", { path });
}

// Ответы входа — с токенами и личными данными: не кэшировать нигде
auth.use(async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});

// ── чем можно войти ─────────────────────────────────────────────────────────

auth.get("/methods", async (c) => {
  const token = c.env.TELEGRAM_BOT_TOKEN;
  let bot: string | null = null;
  try {
    const username = await botUsername({
      token,
      appEnv: c.env.APP_ENV,
      origin: new URL(c.req.url).origin,
      client: telegramClient({ token, timeoutMs: BOT_INFO_TIMEOUT_MS }),
      cache: defaultCache(),
      waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    });
    bot = BOT_USERNAME_RE.test(username) ? username : null;
  } catch (err) {
    // Без имени бота виджет не поставить, но вход по коду и Mini App работают
    console.warn("auth.methods: bot username unavailable", err instanceof Error ? err.name : typeof err);
  }
  const loginDomain = (c.env.TELEGRAM_LOGIN_DOMAIN as string) || null;
  return c.json(
    {
      telegram: { bot, loginDomain },
      phone: otpSenderFor(c.env) !== null,
      turnstileSiteKey: turnstileSiteKey(c.env),
      apps: {
        web: httpUrl("WEB_APP_URL", c.env.WEB_APP_URL),
        vendor: httpUrl("VENDOR_APP_URL", c.env.VENDOR_APP_URL),
        admin: httpUrl("ADMIN_APP_URL", c.env.ADMIN_APP_URL),
      },
    },
    200,
    { "Cache-Control": "public, max-age=300" },
  );
});

auth.use(database);

// ── Telegram ────────────────────────────────────────────────────────────────

/** Вход из Mini App: клиент (app web) или кабинет партнёра (app vendor) */
async function webAppSignIn(db: Db, env: Env, initData: string, app: "web" | "vendor") {
  const proof = await verifyWebApp(env, initData);
  const locale = localeOf(proof.user.languageCode);
  return withActor(db, SYSTEM, async (trx) => {
    const { accountId } = await signInTelegram(trx, env, proof, app === "web" ? "tma" : "vendor_cabinet");
    if (app === "web") {
      // Исключение откатывает транзакцию: заблокированному ничего не пишем
      await ensureClient(trx, accountId, locale, proof.user.allowsWriteToPm === true);
    } else {
      // Кабинет — только партнёру; иначе откат: аккаунт такой вход не создаёт
      assertPartner(await membershipsIn(trx, accountId));
      // Язык кабинета — из Telegram при первом входе, дальше его выбирает сам партнёр
      await trx
        .updateTable("app.vendor_users")
        .set({
          last_login_at: sql<Date>`now()`,
          locale: sql`case when last_login_at is null then coalesce(${locale}::app.locale, locale) else locale end`,
        })
        .where("account_id", "=", accountId)
        .execute();
    }
    return issueAccountSession(trx, { accountId, app, via: "tg_webapp", proofAt: proof.at });
  });
}

auth.post("/telegram", limitBody, async (c) => {
  const body = await readJsonObject(c.req.raw);
  const initData = initDataOf(body);
  const app = body.app === undefined ? "web" : body.app;
  if (app !== "web" && app !== "vendor") throw new ApiError(400, "invalid_request", "Unknown app", ["app"]);
  return c.json(sessionBody(await webAppSignIn(c.var.db, c.env, initData, app)));
});

/**
 * @deprecated Прежний адрес входа кабинета из Mini App. Кабинет входит через
 * POST /auth/telegram { initData, app: "vendor" }; адрес — для старых сборок, не удалять,
 * пока в логе есть обращения (auth.legacy)
 */
auth.post("/vendor/telegram", limitBody, async (c) => {
  legacyEndpoint("/auth/vendor/telegram");
  const initData = initDataOf(await readJsonObject(c.req.raw));
  return c.json(sessionBody(await webAppSignIn(c.var.db, c.env, initData, "vendor")));
});

// Хаб входа: { widget: поля виджета как есть (id, first_name, username, auth_date, hash, …),
// locale: язык сайта } — язык нужен клиенту при первом входе: у виджета его нет
auth.post("/widget", limitBody, async (c) => {
  const body = await readJsonObject(c.req.raw);
  const widget = body.widget;
  if (typeof widget !== "object" || widget === null || Array.isArray(widget)) {
    throw new ApiError(400, "invalid_request", "widget is required", ["widget"]);
  }
  const locale = body.locale === "ru" || body.locale === "uz" ? body.locale : null;
  const proof = await verifyWidget(c.env, widget as Record<string, unknown>);
  const session = await withActor(c.var.db, SYSTEM, async (trx) => {
    const { accountId } = await signInTelegram(trx, c.env, proof, "web");
    await ensureClient(trx, accountId, locale, false);
    return issueAccountSession(trx, { accountId, app: "web", via: "tg_widget", proofAt: proof.at });
  });
  return c.json(sessionBody(session));
});

// ── телефон ─────────────────────────────────────────────────────────────────

interface IssueRow {
  result: "ok" | "too_soon" | "phone_limit" | "ip_limit";
  otp_id: string | null;
  retry_after: number;
}

/**
 * Код на телефон просит человек, а не скрипт (с TURNSTILE_SECRET_KEY): Mini App — своей
 * initData (подпись Telegram; неверная — 401, как у входа), браузер — токеном Turnstile
 * из хаба. Без секрета проверки нет. Выбор — по телу: initData есть — это Mini App
 */
async function assertHuman(env: Env, headers: Headers, body: Readonly<Record<string, unknown>>) {
  if (!turnstileEnabled(env)) return;
  if (body.initData !== undefined) {
    await verifyWebApp(env, initDataOf(body));
    return;
  }
  await verifyTurnstile(env, { token: body.turnstileToken, remoteIp: clientIp(headers) });
}

auth.post("/phone/send", limitBody, async (c) => {
  const sender = otpSenderFor(c.env);
  if (sender === null) throw phoneUnavailable();
  const input = await readJsonObject(c.req.raw);
  const phone = phoneOf(input);
  // До базы: без проверки код не выдаётся и не считается в лимитах номера
  await assertHuman(c.env, c.req.raw.headers, input);

  const code = generateOtpCode();
  const [phoneH, codeH, ipH] = await Promise.all([
    phoneHash(c.env.ID_HASH_KEY, phone),
    otpCodeHash(c.env.ID_HASH_KEY, phone, code),
    requestIpHash(c.req.raw.headers, c.env.ID_HASH_KEY),
  ]);
  const issued = await withActor(c.var.db, SYSTEM, async (trx) => {
    const { rows } = await sql<IssueRow>`
      select result, otp_id, retry_after
      from app.otp_issue(${phoneH}::bytea, ${codeH}::bytea, ${ipH}::bytea, ${sender.provider}::text,
                         ${OTP_TTL_SECONDS}::int)`.execute(trx);
    return rows[0];
  });
  if (issued === undefined) throw new Error("otp_issue: нет результата");
  if (issued.result !== "ok" || issued.otp_id === null) {
    const code = issued.result === "too_soon" ? "otp_too_soon" : "otp_limit";
    console.info("auth.otp: send refused", { result: issued.result });
    return c.json(new ApiError(429, code, "Too many codes requested").toBody(), 429, {
      "Retry-After": String(Math.max(1, issued.retry_after)),
      "Cache-Control": "no-store",
    });
  }

  let messageId: string | null;
  try {
    messageId = await sender.send(phone, code, OTP_TTL_SECONDS);
  } catch (err) {
    if (!(err instanceof OtpDeliveryError)) throw err;
    console.warn("auth.otp: delivery failed", { provider: sender.provider, reason: err.reason });
    throw new ApiError(503, "otp_delivery_failed", "Code could not be delivered");
  }
  if (messageId !== null) {
    await withActor(c.var.db, SYSTEM, (trx) =>
      sql`select app.otp_sent(${issued.otp_id}::uuid, ${messageId}::text)`.execute(trx),
    );
  }
  const body: OtpSent = { resendAfter: OTP_RESEND_SECONDS, expiresIn: OTP_TTL_SECONDS };
  return c.json(body);
});

auth.post("/phone/verify", limitBody, async (c) => {
  if (otpSenderFor(c.env) === null) throw phoneUnavailable();
  const body = await readJsonObject(c.req.raw);
  const { phone, code } = otpInput(body);
  const locale = body.locale === "ru" || body.locale === "uz" ? body.locale : null;
  await checkOtp(c.var.db, c.env.ID_HASH_KEY, phone, code);
  const session = await withActor(c.var.db, SYSTEM, async (trx) => {
    const { accountId } = await signInPhone(trx, c.env, phone, locale, "web");
    await ensureClient(trx, accountId, locale, false);
    return issueAccountSession(trx, { accountId, app: "web", via: "phone_otp", proofAt: new Date() });
  });
  return c.json(sessionBody(session));
});

// ── хаб входа ───────────────────────────────────────────────────────────────

auth.post("/hub/code", limitBody, authenticate, async (c) => {
  const session = requireAccountSession(c);
  const input = parseHubCodeRequest(await readJsonObject(c.req.raw));
  return c.json(await issueHubCode(c.var.db, c.env, session, input));
});

auth.post("/hub/exchange", limitBody, async (c) => {
  const input = parseHubExchange(await readJsonObject(c.req.raw));
  const session = await exchangeHubCode(c.var.db, c.env, c.req.header("Origin"), input);
  return c.json(sessionBody(session));
});

// ── сотрудник ───────────────────────────────────────────────────────────────

auth.post("/staff/elevate", authenticate, async (c) => {
  const session = requireAccountSession(c);
  const staff = await elevateSession(c.var.db, session);
  return c.json(sessionBody(staff));
});

auth.post("/staff/webapp", limitBody, async (c) => {
  const initData = initDataOf(await readJsonObject(c.req.raw));
  return c.json(sessionBody(await signInStaffWebApp(c.var.db, c.env, initData)));
});

/**
 * @deprecated Прежний вход панели виджетом Telegram на её домене (поля виджета как есть:
 * id, first_name, username, auth_date, hash, …). Панель входит через хаб
 * (/auth/hub/exchange → /auth/staff/elevate) или как Mini App (/auth/staff/webapp); адрес —
 * для старых сборок, не удалять, пока в логе есть обращения (auth.legacy)
 */
auth.post("/staff/telegram", limitBody, async (c) => {
  legacyEndpoint("/auth/staff/telegram");
  const fields = await readJsonObject(c.req.raw);
  return c.json(sessionBody(await signInStaff(c.var.db, c.env, fields)));
});

// ── выход ───────────────────────────────────────────────────────────────────

auth.post("/logout", authenticate, async (c) => {
  const { actor, session } = requireSession(c);
  // Под актором сессии: RLS даёт отозвать только свою (сотрудник — привилегированный,
  // но id сессии берётся из его же токена)
  await withActor(c.var.db, actor, (trx) =>
    trx
      .updateTable("app.sessions")
      .set({ revoked_at: sql<Date>`now()` })
      .where("id", "=", session.id)
      .where("revoked_at", "is", null)
      .execute(),
  );
  return c.body(null, 204);
});

// ── код из сообщения: проверка (и для добавления телефона в /me) ────────────

interface CheckRow {
  result: "ok" | "mismatch" | "too_many_attempts" | "expired" | "no_code";
  attempts_left: number;
}

/**
 * Проверяет код своей транзакцией: неверная попытка засчитывается, даже если ответ —
 * ошибка. Неверный — 400 otp_invalid (+ attemptsLeft); пять неверных — 400
 * otp_attempts; нет действующего кода — 400 otp_expired.
 */
export async function checkOtp(db: Db, key: string, phone: string, code: string): Promise<void> {
  const [phoneH, codeH] = await Promise.all([phoneHash(key, phone), otpCodeHash(key, phone, code)]);
  const row = await withActor(db, SYSTEM, async (trx) => {
    const { rows } = await sql<CheckRow>`
      select result, attempts_left from app.otp_check(${phoneH}::bytea, ${codeH}::bytea)`.execute(trx);
    return rows[0];
  });
  if (row === undefined) throw new Error("otp_check: нет результата");
  switch (row.result) {
    case "ok":
      return;
    case "mismatch":
      throw new ApiError(400, "otp_invalid", "Code is wrong", undefined, {
        attemptsLeft: String(row.attempts_left),
      });
    case "too_many_attempts":
      throw new ApiError(400, "otp_attempts", "Too many wrong codes: request a new one");
    default:
      throw new ApiError(400, "otp_expired", "No valid code: request a new one");
  }
}

/** Номер и код из тела: номер — узбекский (400 invalid_phone), код — 6 цифр (400 otp_invalid) */
export function otpInput(body: Readonly<Record<string, unknown>>): { phone: string; code: string } {
  const phone = phoneOf(body);
  const code = normalizeOtpCode(body.code);
  if (code === null) throw new ApiError(400, "otp_invalid", "Code must be 6 digits");
  return { phone, code };
}

function phoneOf(body: Readonly<Record<string, unknown>>): string {
  const phone = typeof body.phone === "string" ? normalizeUzPhone(body.phone) : null;
  if (phone === null) throw invalidPhone();
  return phone;
}

// ── тело запроса ────────────────────────────────────────────────────────────

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Body must be JSON");
  }
}

// Тело — JSON-объект; что в нём, решают проверки дальше
export async function readJsonObject(request: Request): Promise<Readonly<Record<string, unknown>>> {
  const body = await readJson(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "Body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function initDataOf(body: Readonly<Record<string, unknown>>): string {
  const initData = body.initData;
  if (typeof initData !== "string" || initData.length === 0) {
    throw new ApiError(400, "invalid_request", "initData is required");
  }
  return initData;
}
