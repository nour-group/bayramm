/* Контракт API клиента: свой профиль и права на свои данные. Адреса — с сессией
   аккаунта (Authorization: Bearer <token> из POST /auth/telegram, /auth/widget,
   /auth/phone/verify), только над собой. GET /me — и с сессией сотрудника.

     GET    /me                    → 200 Me: аккаунт, способы входа, роли и поля клиента
     PATCH  /me                    ClientMePatch → 200 Me; неверный язык — 422 invalid_input
     GET    /me/export             → 200 ClientDataExport (JSON-файл, Content-Disposition: attachment)
     POST   /me/consents/withdraw  WithdrawConsent → 200 ConsentWithdrawn
     DELETE /me                    → 204; сессия и все остальные сессии клиента больше не действуют

   Избранное (сессия клиента):
     GET    /me/favorites               → 200 Favorites
     PUT    /me/favorites/:listingId    → 204; не опубликована или нет — 404; уже FAVORITES_MAX — 409 favorites_full
     DELETE /me/favorites/:listingId    → 204 (и если отметки не было)
     POST   /me/favorites               FavoritesMerge → 200 Favorites: гостевой список при входе

   Удаление аккаунта: действующие согласия отзываются, открытые заявки отзываются,
   контакты из заявок стираются, профиль (Telegram ID, имя, телефон) удаляется.
   Новый вход через Telegram создаёт аккаунт заново — с пустым профилем согласий.
   Источник записи в журналах — заголовок CLIENT_SOURCE_HEADER, как у заявок. */

import type { AccountMe } from "./account";
import type { ClientConsentPurpose, DeclineReason, ListingCard, Locale, RequestStatus } from "./client";

/** Свой профиль. Телефона здесь нет: его отдаёт только выгрузка (чтение — в журнал) */
export interface ClientMe {
  readonly id: string;
  /** Язык интерфейса и сообщений бота */
  readonly locale: Locale;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly username: string | null;
  /** Telegram разрешил боту писать первым */
  readonly canMessage: boolean;
  /** Действует согласие на уведомления в боте (последняя запись журнала — grant) */
  readonly notifications: boolean;
}

/**
 * Поля клиента в GET /me. У аккаунта без роли клиента (только партнёр или сотрудник)
 * id — null, язык и имена — аккаунта, уведомлений нет
 */
export type MeClient =
  | ClientMe
  | (Omit<ClientMe, "id" | "canMessage" | "notifications"> & {
      readonly id: null;
      readonly canMessage: false;
      readonly notifications: false;
    });

/** GET /me: аккаунт и роли (кнопки «Кабинет партнёра», «Панель оператора») + поля клиента */
export type Me = AccountMe & MeClient;

/**
 * GET /me/favorites: опубликованные площадки из избранного, последние отмеченные — первыми.
 * Снятая с публикации площадка в списке не показывается (и не мешает), с новой
 * публикацией возвращается
 */
export interface Favorites {
  readonly items: readonly ListingCard[];
}

/**
 * POST /me/favorites: слить гостевое избранное (браузер) с аккаунтом при входе. Не больше
 * FAVORITES_MAX id; неопубликованные и уже отмеченные пропускаются, сверх лимита — не
 * добавляются. Неверный id — 400 invalid_request
 */
export interface FavoritesMerge {
  readonly listingIds: readonly string[];
}

/** PATCH /me: язык сохраняется в профиле — по нему пишет и бот */
export interface ClientMePatch {
  readonly locale: Locale;
}

/** Тело POST /me/consents/withdraw. listingId — обязателен для request_transfer и только для него */
export interface WithdrawConsent {
  readonly purpose: ClientConsentPurpose;
  readonly listingId?: string;
}

/** withdrawn: false — действующего согласия не было, журнал не изменился */
export interface ConsentWithdrawn {
  readonly withdrawn: boolean;
}

export type ConsentSource = "tma" | "web" | "admin" | "offline" | "system";

export interface ExportedConsent {
  readonly purpose: ClientConsentPurpose;
  readonly action: "grant" | "withdraw";
  readonly textVersion: number;
  readonly textLocale: Locale;
  readonly listingId: string | null;
  readonly source: ConsentSource;
  readonly at: string;
}

export interface ExportedStatusChange {
  readonly from: RequestStatus | null;
  readonly to: RequestStatus;
  /** Кто сменил статус — только вид: клиент, вендор, оператор, система */
  readonly actorKind: "client" | "vendor_user" | "staff" | "system";
  readonly at: string;
}

export interface ExportedRequest {
  readonly id: string;
  readonly publicNo: number;
  readonly status: RequestStatus;
  readonly declineReason: DeclineReason | null;
  readonly occasionCode: string;
  readonly eventDate: string;
  readonly guests: number;
  readonly budgetMinUzs: number | null;
  readonly budgetMaxUzs: number | null;
  readonly source: "tma" | "web" | "admin";
  readonly createdAt: string;
  readonly slaDueAt: string;
  readonly firstResponseAt: string | null;
  readonly listing: { readonly id: string; readonly slug: string | null; readonly name: string | null };
  /** Что клиент оставил в заявке; после срока хранения — null и purgedAt */
  readonly contact: {
    readonly name: string | null;
    readonly phone: string | null;
    readonly comment: string | null;
    readonly purgedAt: string | null;
  } | null;
  readonly history: readonly ExportedStatusChange[];
}

/** Отметка в избранном: площадка (адрес и название — пока клиенту она видна) и когда */
export interface ExportedFavorite {
  readonly listing: { readonly id: string; readonly slug: string | null; readonly name: string | null };
  readonly savedAt: string;
}

/** GET /me/export → 200. Данных вендоров (телефонов, реквизитов, id сотрудников) нет */
export interface ClientDataExport {
  readonly version: 1;
  readonly generatedAt: string;
  readonly account: {
    readonly id: string;
    readonly locale: Locale;
    readonly canMessage: boolean;
    readonly createdAt: string;
    readonly lastSeenAt: string | null;
  };
  readonly profile: {
    readonly telegramId: number;
    readonly firstName: string | null;
    readonly lastName: string | null;
    readonly username: string | null;
    readonly phone: string | null;
    readonly phoneVerifiedAt: string | null;
    readonly updatedAt: string;
  } | null;
  readonly consents: readonly ExportedConsent[];
  readonly requests: readonly ExportedRequest[];
  readonly favorites: readonly ExportedFavorite[];
}
