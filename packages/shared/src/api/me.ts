/* Контракт API клиента: права на свои данные. Все адреса — с сессией клиента
   (Authorization: Bearer <token> из POST /auth/telegram), только над собой.

     GET    /me/export             → 200 ClientDataExport (JSON-файл, Content-Disposition: attachment)
     POST   /me/consents/withdraw  WithdrawConsent → 200 ConsentWithdrawn
     DELETE /me                    → 204; сессия и все остальные сессии клиента больше не действуют

   Удаление аккаунта: действующие согласия отзываются, открытые заявки отзываются,
   контакты из заявок стираются, профиль (Telegram ID, имя, телефон) удаляется.
   Новый вход через Telegram создаёт аккаунт заново — с пустым профилем согласий. */

import type { ClientConsentPurpose, DeclineReason, Locale, RequestStatus } from "./client";

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
}
