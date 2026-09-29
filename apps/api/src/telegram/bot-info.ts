// Имя бота окружения — из getMe, с кэшем на час в Cache API Cloudflare.
//
// Имя нигде не вписано: у staging и production свои боты, и какой из них
// настоящий, знает только токен (секрет TELEGRAM_BOT_TOKEN). Кэш — по окружению
// и id бота: сменили токен на другого бота — старое имя из кэша не достанется.
// Кэш — только ускорение: без Cache API (Node, *.workers.dev) и при его ошибках
// имя берётся у Telegram на каждый запрос.

import { botIdOf, type TelegramClient } from "./client";

export const BOT_INFO_TTL_SECONDS = 60 * 60;

// Имя бота: 5–32 символа латиницы, цифр и _, в конце — bot (правила @BotFather)
export const BOT_USERNAME_RE = /^[A-Za-z0-9_]{2,29}bot$/i;

/** Нужное от Cache API: caches.default в Workers */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** caches.default, если он есть в среде; иначе null */
export function defaultCache(): CacheLike | null {
  try {
    return (globalThis as { caches?: { default?: CacheLike } }).caches?.default ?? null;
  } catch {
    return null;
  }
}

export interface BotUsernameOptions {
  readonly token: string;
  readonly appEnv: string;
  /** origin запроса: ключ кэша — адрес в зоне, где работает воркер */
  readonly origin: string;
  readonly client: TelegramClient;
  readonly cache: CacheLike | null;
  /** Запись в кэш — после ответа (ctx.waitUntil) */
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

/** Ответ getMe не того вида: не бот или имя не по правилам */
export class BadBotInfoError extends Error {
  constructor() {
    super("telegram getMe: unexpected bot info");
    this.name = "BadBotInfoError";
  }
}

async function readCached(cache: CacheLike, key: Request): Promise<string | null> {
  try {
    const hit = await cache.match(key);
    if (!hit) return null;
    const body = (await hit.json()) as { username?: unknown };
    return typeof body.username === "string" && BOT_USERNAME_RE.test(body.username) ? body.username : null;
  } catch {
    return null;
  }
}

/**
 * Имя бота (без @). Ошибки Telegram — TelegramError, ответ не того вида —
 * BadBotInfoError; кэш при этом не трогается.
 */
export async function botUsername(options: BotUsernameOptions): Promise<string> {
  const { cache } = options;
  const key = new Request(
    `${options.origin}/__cache/telegram-bot/${encodeURIComponent(options.appEnv)}/${botIdOf(options.token)}`,
  );

  if (cache) {
    const cached = await readCached(cache, key);
    if (cached) return cached;
  }

  const me = await options.client.call("getMe", {});
  const username = me.username;
  if (me.is_bot !== true || typeof username !== "string" || !BOT_USERNAME_RE.test(username)) {
    throw new BadBotInfoError();
  }

  if (cache) {
    const entry = Response.json(
      { username },
      { headers: { "cache-control": `max-age=${BOT_INFO_TTL_SECONDS}` } },
    );
    options.waitUntil(cache.put(key, entry).catch(() => {}));
  }
  return username;
}
