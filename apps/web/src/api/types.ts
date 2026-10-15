import type {
  CatalogCategories,
  CatalogPage,
  CatalogQuery,
  CatalogSuggest,
  ClientRequest,
  ClientRequests,
  ConsentTexts,
  ContactChannel,
  CreateRequest,
  Dictionaries,
  FeaturedListings,
  ListingCards,
  ListingContacts,
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
  Favorites,
  Me,
  WithdrawConsent,
} from "@bayramm/shared/api/me";

export type { SessionToken };

/** Чем запрос кода на телефон доказывает, что его шлёт человек */
export interface PhoneProof {
  readonly turnstileToken?: string;
  readonly initData?: string;
}

/**
 * Имя бота и адрес Mini App. Берутся из GET /auth/methods (telegram.bot, apps.web — botInfoOf):
 * тот же ответ уже нужен хабу входа и подвалу. Старый GET /telegram/bot остаётся в API для
 * старых сборок, клиент его не зовёт
 */
export interface BotInfo {
  readonly username: string;
  readonly miniAppUrl: string;
}

/** Готовые ответы из кэша вкладки, без запроса (api/cache.ts): экран рисуется сразу */
export interface ApiPeek {
  listing(slug: string): ListingDetail | undefined;
  catalog(query: CatalogQuery): CatalogPage | undefined;
  catalogCategories(): CatalogCategories | undefined;
  consentTexts(locale: Locale): ConsentTexts | undefined;
  /** Сервер сказал, что текст согласия сменился: следующий запрос — мимо кэша */
  forgetConsentTexts(): void;
}

/**
 * Всё, что клиент берёт у API (контракт — @bayramm/shared/api). Две реализации:
 * http.ts — настоящий API через /api, mock.ts — данные в памяти для тестов и
 * `pnpm dev:web` без сервера. Экраны знают только этот интерфейс.
 */
export interface ClientApi {
  /** live — настоящий API; mock — демо-данные в памяти (только разработка и тесты) */
  readonly mode: "live" | "mock";
  /** Кэш публичных ответов (withCache в bootstrap); без него — каждый раз запрос */
  readonly peek?: ApiPeek;
  dictionaries(signal?: AbortSignal): Promise<Dictionaries>;
  /** Категории каталога с числом витрин (GET /catalog/categories); пустые клиент не показывает */
  catalogCategories(signal?: AbortSignal): Promise<CatalogCategories>;
  /** Витрины лендинга одним запросом (GET /catalog/featured): по одной из первых разделов с витринами */
  featured(signal?: AbortSignal): Promise<FeaturedListings>;
  /** Выдача категории (без category у API — залы, весь каталог — category=all); фильтры по полям витрины — query.filters (a.*) */
  catalog(query: CatalogQuery, signal?: AbortSignal): Promise<CatalogPage>;
  /**
   * Подсказки поиска (GET /catalog/suggest): разделы, районы, до пяти витрин. Не через кэш
   * вкладки: каждый набранный текст — свой запрос, прежний отменяется сигналом (повтор того же
   * текста отдаёт кэш браузера — ответ публичный)
   */
  suggest(q: string, signal?: AbortSignal): Promise<CatalogSuggest>;
  listing(slug: string, signal?: AbortSignal): Promise<ListingDetail>;
  /**
   * «Связаться»: телефон и Telegram витрины — до заявки и без входа; сервер считает открытие
   * (без клиента). signedIn — вошёл ли человек, для счётчиков
   */
  listingContacts(slug: string, signedIn: boolean): Promise<ListingContacts>;
  /** Выбрал «Позвонить» или «Написать в Telegram» — только счётчик; ошибки не важны */
  contactChoice(slug: string, channel: ContactChannel, signedIn: boolean): void;
  consentTexts(locale: Locale, signal?: AbortSignal): Promise<ConsentTexts>;
  /** Имя бота и адрес Mini App — из способов входа (authMethods), отдельного запроса нет */
  bot(signal?: AbortSignal): Promise<BotInfo>;
  /** Карточки опубликованных площадок по id (избранное гостя); остальных в ответе нет */
  listingCards(ids: readonly string[], signal?: AbortSignal): Promise<ListingCards>;
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
  /* Избранное вошедшего клиента (гость держит список в браузере) */
  favorites(signal?: AbortSignal): Promise<Favorites>;
  /** Отметить; не опубликована — 404, список полон — 409 favorites_full */
  addFavorite(listingId: string): Promise<void>;
  removeFavorite(listingId: string): Promise<void>;
  /** Гостевой список — в аккаунт после входа; ответ — весь список */
  mergeFavorites(listingIds: readonly string[]): Promise<Favorites>;
  /* Вход на сайте (хаб /auth) и способы входа (@bayramm/shared/api/account) */
  /** Чем можно войти в этом окружении и адреса приложений */
  authMethods(signal?: AbortSignal): Promise<AuthMethods>;
  /** Вход виджетом Telegram: поля из адреса возврата виджета как есть */
  signInWidget(fields: Readonly<Record<string, string>>, locale: Locale): Promise<SessionToken>;
  /**
   * Код в сообщении на телефон; 429 — рано или лимит (retryAfter). С проверкой «не робот»
   * (AuthMethods.turnstileSiteKey) — токен Turnstile из хаба или initData из Mini App
   */
  sendPhoneCode(phone: string, proof?: PhoneProof): Promise<OtpSent>;
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
  /** Забыть токен вкладки (вход был давно): следующий запрос внутри Telegram войдёт заново */
  forgetSession(): void;
}
