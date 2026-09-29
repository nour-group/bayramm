import type {
  CatalogPage,
  CatalogQuery,
  ClientRequest,
  ClientRequests,
  ConsentTexts,
  CreateRequest,
  Dictionaries,
  ListingDetail,
  Locale,
  RequestCreated,
} from "@bayramm/shared/api";
import type {
  AuthMethods,
  HubCode,
  HubCodeRequest,
  LinkTelegram,
  OtpSent,
  SessionToken,
} from "@bayramm/shared/api/account";
import type {
  ClientDataExport,
  ClientMePatch,
  ConsentWithdrawn,
  Me,
  WithdrawConsent,
} from "@bayramm/shared/api/me";

export type { SessionToken };

/** GET /telegram/bot */
export interface BotInfo {
  readonly username: string;
  readonly miniAppUrl: string;
}

/**
 * Всё, что клиент берёт у API (контракт — @bayramm/shared/api). Две реализации:
 * http.ts — настоящий API через /api, mock.ts — данные в памяти для тестов и
 * `pnpm dev:web` без сервера. Экраны знают только этот интерфейс.
 */
export interface ClientApi {
  /** live — настоящий API; mock — демо-данные в памяти (только разработка и тесты) */
  readonly mode: "live" | "mock";
  dictionaries(signal?: AbortSignal): Promise<Dictionaries>;
  catalog(query: CatalogQuery, signal?: AbortSignal): Promise<CatalogPage>;
  listing(slug: string, signal?: AbortSignal): Promise<ListingDetail>;
  consentTexts(locale: Locale, signal?: AbortSignal): Promise<ConsentTexts>;
  bot(signal?: AbortSignal): Promise<BotInfo>;
  /* Дальше — только с сессией клиента (Telegram) */
  createRequest(body: CreateRequest): Promise<RequestCreated>;
  myRequests(signal?: AbortSignal): Promise<ClientRequests>;
  withdrawRequest(id: string): Promise<ClientRequest>;
  /* Свой аккаунт и права на свои данные (@bayramm/shared/api/me, /account) */
  me(signal?: AbortSignal): Promise<Me>;
  /** Язык — в профиль: по нему пишет бот */
  updateMe(patch: ClientMePatch): Promise<Me>;
  exportMyData(): Promise<ClientDataExport>;
  withdrawConsent(body: WithdrawConsent): Promise<ConsentWithdrawn>;
  /** Удалить аккаунт. После него вход в этой вкладке закрыт: новый вход создал бы аккаунт заново */
  deleteAccount(): Promise<void>;
  /* Вход на сайте (хаб /auth) и способы входа (@bayramm/shared/api/account) */
  /** Чем можно войти в этом окружении и адреса приложений */
  authMethods(signal?: AbortSignal): Promise<AuthMethods>;
  /** Вход виджетом Telegram: поля из адреса возврата виджета как есть */
  signInWidget(fields: Readonly<Record<string, string>>, locale: Locale): Promise<SessionToken>;
  /** Код в сообщении на телефон; 429 — рано или лимит (retryAfter) */
  sendPhoneCode(phone: string): Promise<OtpSent>;
  /** Вход по коду из сообщения */
  verifyPhoneCode(phone: string, code: string, locale: Locale): Promise<SessionToken>;
  /** Код хаба для кабинета или панели — с текущей сессией */
  hubCode(request: HubCodeRequest): Promise<HubCode>;
  /** Добавить телефон к своему аккаунту (код — из sendPhoneCode) */
  linkPhone(phone: string, code: string): Promise<Me>;
  /** Добавить Telegram к своему аккаунту */
  linkTelegram(body: LinkTelegram): Promise<Me>;
  /** Выйти: отозвать сессию этой вкладки */
  signOut(): Promise<void>;
}
