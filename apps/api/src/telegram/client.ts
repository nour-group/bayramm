// Клиент Telegram Bot API: POST https://api.telegram.org/bot<токен>/<метод>, тело — JSON.
//
// В адресе запроса — токен бота, поэтому ни адрес, ни исходная ошибка fetch
// (в ней бывает адрес) не попадают ни в сообщения ошибок, ни в лог. Наружу —
// только TelegramError: метод, причина, код ответа и описание от Telegram,
// из которого токен на всякий случай вырезан.
//
// Методы и их параметры — в BotApiMethods. Новый метод (например, setWebhook,
// когда появится обработчик вебхука) — одна запись там.

const API_ORIGIN = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 10_000;
// Токен от @BotFather: <id бота>:<секрет>. Другое — ошибка настройки, а не запроса
const TOKEN_RE = /^(\d{1,20}):[A-Za-z0-9_-]{1,128}$/;
const DESCRIPTION_MAX = 200;

// ── типы Bot API (только то, что используем) ───────────────────────────────

export interface BotUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface BotCommand {
  /** 1–32 символа: строчная латиница, цифры, _ */
  command: string;
  /** 1–256 символов */
  description: string;
}

export type MenuButton =
  | { type: "web_app"; text: string; web_app: { url: string } }
  | { type: "commands" }
  | { type: "default" };

/** Метод → параметры и результат. language_code не задан — значение по умолчанию для всех языков */
export interface BotApiMethods {
  getMe: { params: Record<string, never>; result: BotUser };
  setMyCommands: { params: { commands: BotCommand[]; language_code?: string }; result: true };
  setMyDescription: { params: { description: string; language_code?: string }; result: true };
  setMyShortDescription: { params: { short_description: string; language_code?: string }; result: true };
  /** Без chat_id — кнопка по умолчанию для всех личных чатов */
  setChatMenuButton: { params: { chat_id?: number; menu_button?: MenuButton }; result: true };
}

export type BotApiMethod = keyof BotApiMethods;

/** Вызов метода как значение: { method, params }. Параметры проверяются по методу */
export type BotApiCall<M extends BotApiMethod = BotApiMethod> = {
  [K in M]: { method: K; params: BotApiMethods[K]["params"] };
}[M];

// ── ошибки ─────────────────────────────────────────────────────────────────

export type TelegramFailure =
  /** Telegram ответил ok: false (error_code, description) */
  | "api"
  /** Ответа нет: сеть, DNS, соединение */
  | "network"
  /** Не уложились в timeoutMs */
  | "timeout"
  /** Ответ не JSON или не в формате Bot API */
  | "bad_response";

export class TelegramError extends Error {
  readonly method: string;
  readonly reason: TelegramFailure;
  /** error_code от Telegram или HTTP-статус; 0 — ответа не было */
  readonly status: number;
  /** Описание ошибки от Telegram (без токена) — для лога, не для ответа клиенту */
  readonly description: string | undefined;

  constructor(method: string, reason: TelegramFailure, status: number, description?: string) {
    super(`telegram ${method}: ${reason}${status ? ` ${status}` : ""}`);
    this.name = "TelegramError";
    this.method = method;
    this.reason = reason;
    this.status = status;
    this.description = description;
  }
}

// ── клиент ─────────────────────────────────────────────────────────────────

export interface TelegramClientOptions {
  /** Токен бота (секрет TELEGRAM_BOT_TOKEN) */
  readonly token: string;
  readonly fetch?: typeof fetch;
  /** Предел на запрос вместе с чтением ответа, мс */
  readonly timeoutMs?: number;
}

export interface TelegramClient {
  /** Вызывает метод; результат — поле result ответа. Любая неудача — TelegramError */
  call<M extends BotApiMethod>(
    method: M,
    params: BotApiMethods[M]["params"],
  ): Promise<BotApiMethods[M]["result"]>;
}

/** id бота — часть токена до двоеточия; не секрет (его же отдаёт getMe) */
export function botIdOf(token: string): string {
  const match = TOKEN_RE.exec(token);
  if (!match?.[1]) throw new TypeError("TELEGRAM_BOT_TOKEN не задан или не похож на токен бота");
  return match[1];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function telegramClient(options: TelegramClientOptions): TelegramClient {
  const { token } = options;
  botIdOf(token); // формат токена — сразу, до первого запроса
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Описание ошибки приходит от Telegram; токена в нём быть не должно, но в лог
  // оно попадает — вырезаем на всякий случай и ограничиваем длину
  const clean = (text: unknown): string | undefined =>
    typeof text === "string" && text.length > 0
      ? text.split(token).join("[token]").slice(0, DESCRIPTION_MAX)
      : undefined;

  return {
    async call(method, params) {
      const signal = AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await doFetch(`${API_ORIGIN}/bot${token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal,
        });
      } catch {
        // Исходную ошибку не сохраняем (cause): в ней бывает адрес с токеном
        throw new TelegramError(method, signal.aborted ? "timeout" : "network", 0);
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new TelegramError(method, signal.aborted ? "timeout" : "bad_response", res.status);
      }

      if (isObject(body) && body.ok === true && "result" in body) {
        return body.result as never;
      }
      if (isObject(body) && body.ok === false) {
        const code = typeof body.error_code === "number" ? body.error_code : res.status;
        throw new TelegramError(method, "api", code, clean(body.description));
      }
      throw new TelegramError(method, "bad_response", res.status);
    },
  };
}
