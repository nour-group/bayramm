/* Контракт аккаунта и входа: общий для apps/api, apps/web, apps/vendor и apps/admin.

   Один человек — один аккаунт. Клиент, партнёр (пользователь вендора) и сотрудник —
   роли на нём. Войти можно откуда угодно, и всё заканчивается одной сессией аккаунта:

     POST /auth/telegram        { initData, app? }       Mini App: клиент (app web), кабинет (app vendor)
     POST /auth/widget          WidgetSignIn             сайт, хаб входа: виджет Telegram
     POST /auth/phone/send      { phone }                код в сообщении на телефон
     POST /auth/phone/verify    { phone, code }          вход по коду (сайт, хаб)
     → 200 SessionToken — сессия аккаунта, 7 дней

   Сотрудник: сессия сотрудника — отдельная, не дольше 12 часов от доказательства входа
   и только по свежему доказательству:

     POST /auth/staff/elevate   (сессия аккаунта)        доказательство не старше 12 часов
     POST /auth/staff/webapp    { initData }             панель как Mini App
     → 200 SessionToken — сессия сотрудника; 401 reauth_required — войти заново

   Хаб входа — страница /auth клиентского сайта. Другое приложение (кабинет, панель)
   отправляет туда человека с app, state и PKCE (S256), хаб выдаёт код и возвращает его
   на <приложение>/auth/callback?code=…&state=…, приложение меняет код на свою сессию:

     POST /auth/hub/code        (сессия хаба) HubCodeRequest → 200 HubCode
     POST /auth/hub/exchange    HubExchange (Origin — приложения) → 200 SessionToken

   Код живёт 60 секунд, погашается при первой попытке обмена. Куки не нужны: токен
   каждое приложение держит в своём sessionStorage и шлёт в Authorization: Bearer. */

import type { Locale } from "./client";

/** Приложения Bayramm: клиентское (сайт и Mini App), кабинет партнёра, панель оператора */
export type AppCode = "web" | "vendor" | "admin";

/** Приложения, которым хаб выдаёт код */
export const HUB_APPS = ["vendor", "admin"] as const;
export type HubApp = (typeof HUB_APPS)[number];

export type IdentityKind = "telegram" | "phone";

/** Заголовок запроса кабинета: какой вендор, если человек — партнёр нескольких */
export const VENDOR_HEADER = "X-Bayramm-Vendor";

// ── вход ───────────────────────────────────────────────────────────────────

/** Ответ любого входа: непрозрачный токен и когда он истекает */
export interface SessionToken {
  readonly token: string;
  readonly expiresAt: string;
}

/** POST /auth/telegram. app по умолчанию web; vendor — только партнёру (403 vendor_not_linked) */
export interface TelegramSignIn {
  readonly initData: string;
  readonly app?: "web" | "vendor";
}

/** POST /auth/widget: поля из адреса возврата виджета как есть и язык сайта (для роли клиента) */
export interface WidgetSignIn {
  readonly widget: Readonly<Record<string, string>>;
  readonly locale?: Locale;
}

/** POST /auth/phone/send → 200 OtpSent; 429 otp_too_soon | otp_limit (Retry-After); 503 phone_unavailable */
export interface OtpSend {
  /** +998XXXXXXXXX (пробелы, скобки и дефисы допустимы) */
  readonly phone: string;
}

export interface OtpSent {
  /** Через сколько секунд можно попросить код ещё раз */
  readonly resendAfter: number;
  /** Сколько секунд код действует */
  readonly expiresIn: number;
}

/**
 * POST /auth/phone/verify → 200 SessionToken. 400 otp_invalid (+ attemptsLeft),
 * otp_expired (код не запрошен, истёк или использован), otp_attempts (пять неверных — запросить новый)
 */
export interface OtpVerify {
  readonly phone: string;
  /** 6 цифр */
  readonly code: string;
  /** Язык сайта — для роли клиента при первом входе */
  readonly locale?: Locale;
}

/** POST /auth/hub/code: state и PKCE — от приложения, которое будет менять код */
export interface HubCodeRequest {
  readonly app: HubApp;
  /** 16–128 символов [A-Za-z0-9_-] */
  readonly state: string;
  /** base64url(SHA-256(codeVerifier)), 43 символа */
  readonly codeChallenge: string;
}

/** → 200: куда вести браузер — <приложение>/auth/callback?code=…&state=… */
export interface HubCode {
  readonly redirectUrl: string;
}

/**
 * POST /auth/hub/exchange → 200 SessionToken (сессия аккаунта для этого приложения).
 * Код неизвестен, истёк, уже погашен, выдан другому приложению или origin, state или
 * verifier не те — одинаковый 400 invalid_code
 */
export interface HubExchange {
  readonly app: HubApp;
  readonly code: string;
  /** 43–128 символов [A-Za-z0-9-._~] */
  readonly codeVerifier: string;
  readonly state: string;
}

/** GET /auth/methods: чем можно войти в этом окружении и где приложения */
export interface AuthMethods {
  readonly telegram: {
    /** Имя бота окружения; null — Telegram не ответил */
    readonly bot: string | null;
    /**
     * Домен, на котором работает виджет входа (у бота в @BotFather /setdomain).
     * На другом домене виджет не показывать; null — виджет не настроен
     */
    readonly loginDomain: string | null;
  };
  /** Вход по коду из сообщения включён (есть провайдер) */
  readonly phone: boolean;
  /** Адреса приложений окружения, без завершающего «/» */
  readonly apps: Readonly<Record<AppCode, string>>;
}

// ── свой аккаунт ───────────────────────────────────────────────────────────

export interface AccountIdentity {
  readonly kind: IdentityKind;
  readonly verifiedAt: string;
}

export interface VendorMembership {
  readonly vendorUserId: string;
  readonly vendorId: string;
  /** Публичный код вендора, например V101 */
  readonly code: string;
  readonly name: string | null;
  readonly role: "owner" | "member";
}

export type StaffRoleCode = "admin" | "manager" | "moderator";

/**
 * GET /me — любая сессия (аккаунта или сотрудника). Способы входа — только вид и дата,
 * без значений; телефона здесь нет. Роли — те, что есть у аккаунта сейчас: кнопки
 * «Кабинет партнёра» и «Панель оператора» показываются только по ним
 */
export interface AccountMe {
  readonly account: { readonly id: string; readonly locale: Locale; readonly createdAt: string };
  readonly profile: {
    readonly firstName: string | null;
    readonly lastName: string | null;
    readonly username: string | null;
  };
  readonly identities: readonly AccountIdentity[];
  readonly roles: {
    readonly client: {
      readonly id: string;
      readonly locale: Locale;
      readonly canMessage: boolean;
      readonly blocked: boolean;
    } | null;
    readonly vendors: readonly VendorMembership[];
    readonly staff: { readonly role: StaffRoleCode } | null;
  };
  /** Сессия этого запроса: чем выдана и где */
  readonly session: { readonly kind: "account" | "staff"; readonly app: AppCode };
}

/** POST /me/identities/telegram — { initData } из Mini App или поля виджета в { widget } */
export type LinkTelegram =
  | { readonly initData: string }
  | { readonly widget: Readonly<Record<string, string | number>> };

/**
 * POST /me/identities/phone { phone, code } — код из POST /auth/phone/send.
 * Добавление способа → 200 AccountMe; 409 identity_taken — способ у другого аккаунта
 * (слияния нет: войдите тем способом и удалите тот аккаунт, либо напишите нам);
 * 409 identity_kind_taken — Telegram или телефон у аккаунта уже есть;
 * 401 reauth_required — вход был больше 12 часов назад, войти заново
 */
export type LinkPhone = OtpVerify;

/**
 * Коды ошибок входа и аккаунта:
 *   401 unauthorized, reauth_required · 403 account_disabled, client_blocked, forbidden,
 *   vendor_not_linked, vendor_disabled · 409 vendor_choice_required (несколько
 *   вендоров — нужен заголовок VENDOR_HEADER), identity_taken, identity_kind_taken ·
 *   400 invalid_request, invalid_phone, invalid_code, otp_invalid, otp_expired, otp_attempts ·
 *   429 otp_too_soon, otp_limit, rate_limited · 503 phone_unavailable, otp_delivery_failed
 */
export type AccountErrorCode =
  | "unauthorized"
  | "reauth_required"
  | "account_disabled"
  | "client_blocked"
  | "forbidden"
  | "vendor_not_linked"
  | "vendor_disabled"
  | "vendor_choice_required"
  | "identity_taken"
  | "identity_kind_taken"
  | "invalid_request"
  | "invalid_phone"
  | "invalid_code"
  | "otp_invalid"
  | "otp_expired"
  | "otp_attempts"
  | "otp_too_soon"
  | "otp_limit"
  | "rate_limited"
  | "phone_unavailable"
  | "otp_delivery_failed";

// ── формат state и PKCE ────────────────────────────────────────────────────

const B64URL_43_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export const isCodeChallenge = (value: unknown): value is string =>
  typeof value === "string" && B64URL_43_RE.test(value);
export const isHubState = (value: unknown): value is string =>
  typeof value === "string" && STATE_RE.test(value);
export const isCodeVerifier = (value: unknown): value is string =>
  typeof value === "string" && VERIFIER_RE.test(value);
