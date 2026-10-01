/* Услуги витрины глазами кабинета и панели — общее для @bayramm/shared/api/vendor и
   @bayramm/shared/api/staff. Клиент видит только одобренные услуги (PublicService в
   @bayramm/shared/api).

   Статусы (app.listing_services.status):
     draft    — сохранена, не отправлена на проверку;
     review   — ждёт решения команды (до публикации карточки — вместе с ней);
     active   — одобрена: клиент видит её у опубликованной витрины;
     rejected — отклонена (decision.reason — почему); исправить и отправить снова;
     paused   — снята с витрины; вернуть — через проверку.
   Правка активной услуги опубликованной витрины (у партнёра — уже с отправки карточки на
   проверку) — предложением (proposal): клиент видит одобренное, пока команда не решит.
   Кто решает (одобрить, отклонить) — администратор и модератор (право revisions.moderate).

   Каталог типов, единицы цены и шаблоны опций — @bayramm/shared/categories (CATEGORIES).
   Проверка полей — validateServiceInput оттуда же: сервер проверяет теми же правилами. */

import type { LocalizedText } from "../categories/validate";
import type { Localized, PriceUnit, ServiceOption } from "./client";

export type { LocalizedText, ServiceOption };

export const SERVICE_STATUSES = ["draft", "review", "active", "rejected", "paused"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/** Изменения, которые предлагает правка активной услуги: только изменённые поля */
export interface ServiceChanges {
  readonly name?: Localized;
  readonly priceUzs?: number;
  readonly priceUnit?: PriceUnit;
  readonly minQty?: number | null;
  readonly leadDays?: number | null;
  readonly includes?: LocalizedText | null;
  readonly options?: readonly ServiceOption[];
}

/** Последнее решение команды — по услуге или по предложению правки */
export interface ServiceDecision {
  readonly outcome: "approved" | "declined";
  /** Причина отказа — пишет сотрудник для партнёра; у одобрения — null */
  readonly reason: string | null;
  readonly at: string;
}

/** Услуга витрины как есть в базе */
export interface ListingService {
  readonly id: string;
  /** Код типа услуги категории */
  readonly type: string;
  readonly status: ServiceStatus;
  /** Название: у типа из каталога — его, у «другой услуги» — вендора */
  readonly name: Localized;
  /** Название написал вендор («другая услуга») */
  readonly customName: boolean;
  readonly priceUzs: number;
  readonly priceUnit: PriceUnit;
  readonly minQty: number | null;
  readonly leadDays: number | null;
  readonly includes: LocalizedText | null;
  readonly options: readonly ServiceOption[];
  readonly sort: number;
  /** Предложение правки, которое ждёт решения; null — нет */
  readonly proposal: { readonly changes: ServiceChanges; readonly submittedAt: string } | null;
  readonly decision: ServiceDecision | null;
  /** Когда отправлена на проверку (последний раз) */
  readonly submittedAt: string | null;
  readonly updatedAt: string;
}

/** Опция в форме услуги: id — у существующей опции (без него — новая, id выдаст сервер) */
export interface ServiceOptionInput {
  readonly id?: string;
  /** Код шаблона опции категории, если опция из шаблона */
  readonly code?: string;
  readonly name: Localized;
  readonly priceUzs: number;
  readonly priceUnit: PriceUnit;
}

/**
 * Новая услуга (type, priceUzs обязательны; priceUnit — по умолчанию первая единица типа) и
 * правка (только переданные поля; type не меняется). name — только у «другой услуги» (и там
 * обязательно, на двух языках). options заменяет набор целиком. null у minQty, leadDays,
 * includes — очистить. submit: false — сохранить черновиком, не отправляя на проверку
 * (по умолчанию — отправить). Неверные поля — 422 invalid_input (details — имена полей:
 * priceUnit, options.2.priceUzs…)
 */
export interface ServiceInput {
  readonly type?: string;
  readonly name?: Localized | null;
  readonly priceUzs?: number;
  readonly priceUnit?: PriceUnit;
  readonly minQty?: number | null;
  readonly leadDays?: number | null;
  readonly includes?: LocalizedText | null;
  readonly options?: readonly ServiceOptionInput[];
  readonly sort?: number;
  readonly submit?: boolean;
}

/** Услуги витрины по порядку */
export interface ListingServices {
  readonly items: readonly ListingService[];
}
