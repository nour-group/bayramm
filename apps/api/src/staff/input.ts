// Разбор тела запросов панели: JSON-объект → проверенные значения.
//
// Для правок (PATCH) три состояния поля: нет в теле — не менять (undefined),
// null или пустая строка — очистить (null), значение — записать. Ошибки
// копятся: в ответ 422 invalid_input уходят имена всех неверных полей
// (details), по ним панель подсвечивает поля формы. Окончательно данные
// проверяет база (CHECK, триггеры) — здесь только то, что можно объяснить
// человеку до неё.

import { normalizeUzPhone } from "@bayramm/shared";
import { bodyLimit } from "hono/body-limit";
import { ApiError } from "../errors";

export type Body = Readonly<Record<string, unknown>>;

// Самое длинное в панели — два описания по 4000 символов и поля витрины
const MAX_JSON_BYTES = 64 * 1024;

export const limitJson = bodyLimit({
  maxSize: MAX_JSON_BYTES,
  onError: (c) => c.json(new ApiError(413, "payload_too_large", "Request body is too large").toBody(), 413),
});

export const invalidInput = (fields: string[]) =>
  new ApiError(422, "invalid_input", "Invalid input", [...new Set(fields)]);

export async function readBody(request: Request): Promise<Body> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "Body must be a JSON object");
  }
  return body as Body;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Управляющие символы: в однострочных полях — никакие, в многострочных — кроме \n и \t
// biome-ignore lint/suspicious/noControlCharactersInRegex: это и есть проверка управляющих символов
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: это и есть проверка управляющих символов
const CONTROL_MULTILINE_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Длина в символах, как считает length() в Postgres, а не в UTF-16 */
export function charLength(value: string): number {
  return Array.from(value).length;
}

interface TextOptions {
  max: number;
  min?: number;
  required?: boolean;
  multiline?: boolean;
}

interface IntOptions {
  min: number;
  max: number;
  required?: boolean;
}

export class Input {
  private readonly errors: string[] = [];

  constructor(private readonly body: Body) {}

  has(key: string): boolean {
    return Object.hasOwn(this.body, key);
  }

  /** Значение поля как пришло — для полей, которые проверяет не Input (поля витрины по категории) */
  peek(key: string): unknown {
    return this.has(key) ? this.body[key] : undefined;
  }

  fail(key: string): void {
    this.errors.push(key);
  }

  /** Все поля разобраны: есть ошибки — 422 со списком полей */
  done(): void {
    if (this.errors.length > 0) throw invalidInput(this.errors);
  }

  private raw(key: string, required: boolean): unknown {
    const value = this.has(key) ? this.body[key] : undefined;
    if ((value === undefined || value === null) && required) this.fail(key);
    return value;
  }

  text(key: string, options: TextOptions): string | null | undefined {
    const value = this.raw(key, options.required === true);
    if (value === undefined || value === null) return value;
    if (typeof value !== "string") {
      this.fail(key);
      return undefined;
    }
    const text = options.multiline ? value.replace(/\r\n?/g, "\n").trim() : value.trim();
    if (text === "") {
      if (options.required) this.fail(key);
      return null;
    }
    const length = charLength(text);
    const control = options.multiline ? CONTROL_MULTILINE_RE : CONTROL_RE;
    if (length < (options.min ?? 1) || length > options.max || control.test(text)) {
      this.fail(key);
      return undefined;
    }
    return text;
  }

  int(key: string, options: IntOptions): number | null | undefined {
    const value = this.raw(key, options.required === true);
    if (value === undefined || value === null) return value;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < options.min ||
      value > options.max
    ) {
      this.fail(key);
      return undefined;
    }
    return value;
  }

  oneOf<T extends string>(key: string, values: readonly T[], required = false): T | null | undefined {
    const value = this.raw(key, required);
    if (value === undefined || value === null) return value;
    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
      this.fail(key);
      return undefined;
    }
    return value as T;
  }

  /** Телефон Узбекистана в любой записи → «+998XXXXXXXXX» */
  phone(key: string, required = false): string | null | undefined {
    const value = this.raw(key, required);
    if (value === undefined || value === null) return value;
    if (typeof value === "string" && value.trim() === "" && !required) return null;
    const phone = typeof value === "string" ? normalizeUzPhone(value) : null;
    if (phone === null) {
      this.fail(key);
      return undefined;
    }
    return phone;
  }

  /**
   * Telegram пользователя или канала: «name», «@name», «t.me/name», «https://t.me/name» → «name»
   * (5–32 знака, латиница, цифры, _, с буквы, не на _). Пусто — null (убрать)
   */
  telegram(key: string): string | null | undefined {
    const value = this.text(key, { max: 200 });
    if (value === undefined || value === null) return value;
    const name = normalizeTelegram(value);
    if (name === null) {
      this.fail(key);
      return undefined;
    }
    return name;
  }

  /** Строка по шаблону (после обрезки пробелов) */
  pattern(key: string, re: RegExp, required = false): string | null | undefined {
    const value = this.text(key, { max: 200, required });
    if (value === undefined || value === null) return value;
    if (!re.test(value)) {
      this.fail(key);
      return undefined;
    }
    return value;
  }

  uuid(key: string, required = false): string | null | undefined {
    const value = this.pattern(key, UUID_RE, required);
    return typeof value === "string" ? value.toLowerCase() : value;
  }

  bool(key: string, required = false): boolean | undefined {
    const value = this.raw(key, required);
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "boolean") {
      this.fail(key);
      return undefined;
    }
    return value;
  }

  /** Массив объектов: каждый разбирается своим Input; ошибки — «ключ.номер.поле» */
  list<T>(key: string, max: number, parse: (item: Input) => T | undefined): T[] | undefined {
    const value = this.raw(key, false);
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.length > max) {
      this.fail(key);
      return undefined;
    }
    const items: T[] = [];
    value.forEach((raw, index) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        this.fail(`${key}.${index}`);
        return;
      }
      const item = new Input(raw as Body);
      const parsed = parse(item);
      for (const field of item.errors) this.fail(`${key}.${index}.${field}`);
      if (parsed !== undefined && item.errors.length === 0) items.push(parsed);
    });
    return items;
  }
}

/** Параметры списка: ?limit=&offset= в разумных пределах */
export function paging(query: (key: string) => string | undefined, maxLimit = 100) {
  const limit = Number(query("limit") ?? 50);
  const offset = Number(query("offset") ?? 0);
  return {
    limit: Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, maxLimit) : 50,
    offset: Number.isSafeInteger(offset) && offset >= 0 ? Math.min(offset, 100_000) : 0,
  };
}

/** Строка поиска для ILIKE: спецсимволы шаблона экранированы */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

const TELEGRAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/;

/** Имя Telegram из того, как его вписали: @name, t.me/name, https://t.me/name; иначе null */
export function normalizeTelegram(raw: string): string | null {
  const name = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?(t\.me|telegram\.me)\//i, "")
    .replace(/^@/, "")
    .replace(/\/$/, "");
  return TELEGRAM_NAME_RE.test(name) ? name : null;
}
