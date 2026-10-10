// Хаб входа: вход на одном сайте — сессии в кабинете и панели без второго входа.
//
// Виджет входа Telegram работает только на одном домене бота, поэтому вход вне
// Telegram — одна страница: /auth клиентского сайта (WEB_APP_URL). Кабинет или панель
// отправляют туда человека с app, state и PKCE (S256); хаб, у которого уже есть
// сессия аккаунта (или после входа), просит у API одноразовый код и ведёт браузер на
// <приложение>/auth/callback?code=…&state=…. Приложение меняет код + verifier на
// свою сессию аккаунта. Кук между поддоменами нет.
//
// Код: 32 случайных байта, в базе — sha256; живёт 60 секунд; погашается при первой
// же попытке обмена, удачной или нет. Привязан к приложению, его origin (из
// переменных окружения, не из запроса), challenge и state. Обмен принимается только
// с origin этого приложения (заголовок Origin; прокси сайта его сохраняет). Для
// панели код выдаётся только по свежему доказательству: сессию сотрудника из него
// всё равно не получить иначе.

import {
  HUB_APPS,
  type HubApp,
  isCodeChallenge,
  isCodeVerifier,
  isHubState,
} from "@bayramm/shared/api/account";
import { sql } from "kysely";
import { httpUrl } from "../config";
import { SYSTEM, withActor } from "../db/actor";
import type { Db } from "../db/client";
import type { SessionInfo } from "../env";
import { ApiError, forbidden } from "../errors";
import { isRecentProof, issueAccountSession, reauthRequired } from "./account";
import { generateToken, hashToken, isWellFormedToken, secretsEqual, toBase64Url } from "./crypto";

export const HUB_CODE_TTL_SECONDS = 60;

export const invalidCode = () => new ApiError(400, "invalid_code", "Sign-in code is invalid or expired");
const badRequest = (field: string) => new ApiError(400, "invalid_request", "Invalid hub request", [field]);

type AppUrls = Pick<Env, "VENDOR_APP_URL" | "ADMIN_APP_URL">;

/** origin приложения из переменных окружения: без пути и «/» в конце */
export function appOrigin(env: AppUrls, app: HubApp): string {
  const url =
    app === "vendor"
      ? httpUrl("VENDOR_APP_URL", env.VENDOR_APP_URL)
      : httpUrl("ADMIN_APP_URL", env.ADMIN_APP_URL);
  return new URL(url).origin;
}

const isHubApp = (value: unknown): value is HubApp =>
  typeof value === "string" && (HUB_APPS as readonly string[]).includes(value);

function object(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "Body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export interface HubCodeInput {
  readonly app: HubApp;
  readonly state: string;
  readonly codeChallenge: string;
}

export function parseHubCodeRequest(body: unknown): HubCodeInput {
  const { app, state, codeChallenge } = object(body);
  if (!isHubApp(app)) throw badRequest("app");
  if (!isHubState(state)) throw badRequest("state");
  if (!isCodeChallenge(codeChallenge)) throw badRequest("codeChallenge");
  return { app, state, codeChallenge };
}

export interface HubExchangeInput {
  readonly app: HubApp;
  readonly code: string;
  readonly codeVerifier: string;
  readonly state: string;
}

export function parseHubExchange(body: unknown): HubExchangeInput {
  const { app, code, codeVerifier, state } = object(body);
  if (!isHubApp(app)) throw badRequest("app");
  // Кривой код, verifier или state — тот же ответ, что и неверный: по разнице не подобрать
  if (typeof code !== "string" || !isWellFormedToken(code)) throw invalidCode();
  if (!isCodeVerifier(codeVerifier) || !isHubState(state)) throw invalidCode();
  return { app, code, codeVerifier, state };
}

const sha256 = async (value: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

/** PKCE S256: base64url(SHA-256(verifier)) */
export async function pkceChallenge(verifier: string): Promise<string> {
  return toBase64Url(await sha256(verifier));
}

/**
 * Код для приложения по сессии хаба (сессия аккаунта). Сессии сотрудника кода не
 * выдаём (403); панели — только по свежему доказательству (401 reauth_required).
 */
export async function issueHubCode(
  db: Db,
  env: AppUrls,
  session: SessionInfo,
  input: HubCodeInput,
): Promise<{ redirectUrl: string }> {
  if (session.kind !== "account") throw forbidden();
  if (input.app === "admin" && !isRecentProof(session.proofAt)) throw reauthRequired();

  const origin = appOrigin(env, input.app);
  const code = generateToken();
  const [codeHash, stateHash] = await Promise.all([hashToken(code), sha256(input.state)]);
  await withActor(db, SYSTEM, async (trx) => {
    // Старые коды убираем здесь же: их немного, отдельная уборка не нужна
    await trx
      .deleteFrom("app.hub_codes")
      .where("expires_at", "<", sql<Date>`now() - interval '1 hour'`)
      .execute();
    await trx
      .insertInto("app.hub_codes")
      .values({
        code_hash: codeHash,
        account_id: session.accountId,
        app: input.app,
        origin,
        challenge: input.codeChallenge,
        state_hash: stateHash,
        proof_at: session.proofAt,
        expires_at: sql<Date>`now() + make_interval(secs => ${HUB_CODE_TTL_SECONDS})`,
      })
      .execute();
  });

  const callback = new URL("/auth/callback", origin);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", input.state);
  return { redirectUrl: callback.href };
}

/**
 * Код → сессия аккаунта для приложения кода. Любое несовпадение (нет кода, истёк,
 * погашен, другое приложение или origin, state, verifier) — одинаковый 400
 * invalid_code; код погашается при первой попытке. Аккаунт отключён или удалён — 400
 * invalid_code тоже: сессию по нему не выдать.
 */
export async function exchangeHubCode(
  db: Db,
  env: AppUrls,
  requestOrigin: string | undefined,
  input: HubExchangeInput,
): Promise<{ token: string; expiresAt: Date }> {
  const codeHash = await hashToken(input.code);
  // Погашение — своей транзакцией: неудачная попытка тоже сжигает код
  const row = await withActor(db, SYSTEM, (trx) =>
    trx
      .updateTable("app.hub_codes")
      .set({ used_at: sql<Date>`now()` })
      .where("code_hash", "=", codeHash)
      .where("used_at", "is", null)
      .returning([
        "account_id",
        "app",
        "origin",
        "challenge",
        "state_hash",
        "proof_at",
        sql<boolean>`expires_at > now()`.as("fresh"),
      ])
      .executeTakeFirst(),
  );
  if (row === undefined || !row.fresh) throw invalidCode();

  const expectedOrigin = appOrigin(env, input.app);
  const [challenge, stateHash] = await Promise.all([pkceChallenge(input.codeVerifier), sha256(input.state)]);
  const checks = await Promise.all([
    secretsEqual(challenge, row.challenge),
    secretsEqual(toBase64Url(stateHash), toBase64Url(row.state_hash)),
  ]);
  const matches =
    row.app === input.app &&
    row.origin === expectedOrigin &&
    requestOrigin === expectedOrigin &&
    checks.every(Boolean);
  if (!matches) {
    console.warn("auth.hub: code rejected", { app: input.app });
    throw invalidCode();
  }

  return withActor(db, SYSTEM, async (trx) => {
    const account = await trx
      .selectFrom("app.accounts")
      .select("id")
      .where("id", "=", row.account_id)
      .where("disabled_at", "is", null)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (account === undefined) throw invalidCode();
    if (input.app === "vendor") {
      // Вход в кабинет из браузера — как из Mini App: панель видит, когда партнёр входил
      await trx
        .updateTable("app.vendor_users")
        .set({ last_login_at: sql<Date>`now()` })
        .where("account_id", "=", row.account_id)
        .where("disabled_at", "is", null)
        .execute();
    }
    return issueAccountSession(trx, {
      accountId: row.account_id,
      app: input.app,
      via: "hub_code",
      proofAt: row.proof_at,
    });
  });
}
