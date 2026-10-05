import { type AuthMethods, VENDOR_HEADER } from "@bayramm/shared/api/account";
import { newPkce } from "@bayramm/shared/pkce";
import { initialLang } from "./lang";

/* Вход в кабинет вне Telegram — через хаб входа на сайте Bayramm, без второго входа:
     1. кабинет создаёт verifier и state (PKCE S256), помнит их в хранилище вкладки и ведёт
        браузер на <сайт>/auth?app=vendor&state=…&challenge=…;
     2. хаб (вход на сайте уже есть или человек входит там) возвращает на
        /auth/callback?code=…&state=…;
     3. кабинет сверяет state и меняет код + verifier на свою сессию (POST /auth/hub/exchange).
   Код живёт 60 секунд и гасится при первой попытке. Кук между поддоменами нет.
   Внутри Telegram хаб не нужен: вход по initData из кнопки бота. */

export const CALLBACK_PATH = "/auth/callback";
/** ?signin=1 — пришли из другого приложения Bayramm: в хаб сразу, без экрана «войдите» */
export const SIGNIN_PARAM = "signin";
const PENDING_KEY = "bayramm.vendor.hub";
const VENDOR_KEY = "bayramm.vendor.current";

interface Pending {
  readonly verifier: string;
  readonly state: string;
  readonly back: string;
}

function read<T>(key: string, valid: (value: unknown) => value is T): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return valid(value) ? value : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // без хранилища вход через хаб не завершится — кабинет покажет «войдите» снова
  }
}

function remove(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // нечего чистить
  }
}

const isPending = (value: unknown): value is Pending =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Pending).verifier === "string" &&
  typeof (value as Pending).state === "string" &&
  typeof (value as Pending).back === "string";

/** Переходы с полной загрузкой страницы — через этот объект: тесты подменяют его */
export const browser = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

let methodsCache: Promise<AuthMethods | null> | null = null;

/** Забыть ответ GET /auth/methods (тесты: у каждого свой) */
export function forgetAuthMethods(): void {
  methodsCache = null;
}

/**
 * Чем входить, где приложения окружения и имя бота (GET /api/auth/methods) — один запрос на
 * страницу: его ждут экран входа, ссылка на бота, хаб и аккаунт. null — API не ответило
 */
export function authMethods(): Promise<AuthMethods | null> {
  methodsCache ??= fetch("/api/auth/methods", { credentials: "omit" })
    .then((res) => (res.ok ? (res.json() as Promise<AuthMethods>) : null))
    .catch(() => null)
    .then((methods) => {
      if (methods === null) methodsCache = null;
      return methods;
    });
  return methodsCache;
}

// Имя бота: 5–32 символа латиницы, цифр и _, в конце — bot (правила @BotFather)
export const BOT_USERNAME_RE = /^[A-Za-z0-9_]{2,29}bot$/i;

/**
 * Бот окружения из GET /auth/methods (его имя там уже есть — второй запрос за ним не нужен);
 * null — API не ответило или имени нет
 */
export function botOf(methods: AuthMethods | null): string | null {
  const bot = methods?.telegram.bot ?? null;
  return bot !== null && BOT_USERNAME_RE.test(bot) ? bot : null;
}

/** Путь, куда вернуться после входа: свой путь, без ?signin */
function currentPath(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete(SIGNIN_PARAM);
  const path = `${url.pathname}${url.search}`;
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith(CALLBACK_PATH) ? path : "/";
}

/** В хаб: false — адрес сайта не узнать (API не ответило) */
export async function startHub(): Promise<boolean> {
  const methods = await authMethods();
  if (methods === null) return false;
  const { verifier, challenge, state } = await newPkce();
  write(PENDING_KEY, { verifier, state, back: currentPath() } satisfies Pending);
  const hub = new URL("/auth", methods.apps.web);
  hub.searchParams.set("app", "vendor");
  hub.searchParams.set("state", state);
  hub.searchParams.set("challenge", challenge);
  // Хаб — на языке кабинета (сайт берёт ?lang= как выбор языка)
  hub.searchParams.set("lang", initialLang());
  browser.assign(hub.href);
  return true;
}

export type HubResult =
  | { readonly kind: "ok"; readonly back: string; readonly token: string }
  | { readonly kind: "bad" };

// Один обмен на код: StrictMode и «Повторить» не должны менять код дважды — второй раз он погашен
const finishing = new Map<string, Promise<HubResult>>();

/**
 * Возврат из хаба: state — тот, что мы отправили, код — на сессию. Любая ошибка — bad
 * (кабинет предложит войти заново). Параметры убираются из адреса сразу
 */
export function finishHub(search: string): Promise<HubResult> {
  const running = finishing.get(search);
  if (running) return running;
  const result = exchange(search);
  finishing.set(search, result);
  return result;
}

async function exchange(search: string): Promise<HubResult> {
  const params = new URLSearchParams(search);
  const code = params.get("code");
  const state = params.get("state");
  const pending = read(PENDING_KEY, isPending);
  remove(PENDING_KEY);
  window.history.replaceState(null, "", pending?.back ?? "/");
  if (!code || !state || !pending || pending.state !== state) return { kind: "bad" };
  try {
    const res = await fetch("/api/auth/hub/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: "vendor", code, codeVerifier: pending.verifier, state }),
      credentials: "omit",
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
    if (!res.ok || typeof body?.token !== "string") return { kind: "bad" };
    return { kind: "ok", back: pending.back, token: body.token };
  } catch {
    return { kind: "bad" };
  }
}

// ── выбор вендора: человек — партнёр нескольких ─────────────────────────────

const isString = (value: unknown): value is string => typeof value === "string";

export const currentVendor = (): string | null => read(VENDOR_KEY, isString);
export const chooseVendor = (vendorId: string | null) =>
  vendorId === null ? remove(VENDOR_KEY) : write(VENDOR_KEY, vendorId);

/** Заголовок запроса кабинета: какой вендор (VENDOR_HEADER), если выбран */
export function vendorHeaders(): Record<string, string> {
  const vendor = currentVendor();
  return vendor ? { [VENDOR_HEADER]: vendor } : {};
}
