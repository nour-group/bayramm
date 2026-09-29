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
  ClientDataExport,
  ClientMe,
  ClientMePatch,
  ConsentWithdrawn,
  WithdrawConsent,
} from "@bayramm/shared/api/me";

/** GET /telegram/bot */
export interface BotInfo {
  readonly username: string;
  readonly miniAppUrl: string;
}

/** POST /auth/telegram → 200 */
export interface SessionToken {
  readonly token: string;
  readonly expiresAt: string;
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
  /* Свой профиль и права на свои данные (@bayramm/shared/api/me) */
  me(signal?: AbortSignal): Promise<ClientMe>;
  /** Язык — в профиль: по нему пишет бот */
  updateMe(patch: ClientMePatch): Promise<ClientMe>;
  exportMyData(): Promise<ClientDataExport>;
  withdrawConsent(body: WithdrawConsent): Promise<ConsentWithdrawn>;
  /** Удалить аккаунт. После него вход в этой вкладке закрыт: новый вход создал бы аккаунт заново */
  deleteAccount(): Promise<void>;
}
