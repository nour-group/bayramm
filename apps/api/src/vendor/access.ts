// Роли в кабинете вендора (app.vendor_users.role) — единственная таблица.
//
// Решение для v0.1. Спецификация кабинета знает одну роль «вендор» — владельца
// бизнеса; сотрудник заводит ему пользователей по телефону и может отметить
// кого-то сотрудником площадки (member). Разделение такое:
//
//   · заявки и календарь — работа администратора зала изо дня в день: их ведёт
//     любой действующий пользователь вендора (owner и member);
//   · карточка — то, что видят клиенты и за что отвечает владелец по договору:
//     предложить правку (название, описания, поля витрины, видео), отозвать её, завести
//     и править услуги с ценами, загрузить и удалить фото — только владелец (owner);
//     смотреть карточку и услуги может и сотрудник площадки — ему отвечать клиентам;
//   · пользователей кабинета заводит и отключает менеджер Bayramm в панели —
//     своего раздела «Пользователи» в кабинете нет.
//
// То же проверяет база: карточку, услуги, телефон, фото и правки меняет только
// владелец (app.edits_listing в политиках RLS, миграция 20261001010000_cabinet_integrity.sql).
// Кабинет прячет кнопки по роли из GET /vendor/me — только для удобства.

import type { VendorActor, VendorRole } from "../db/actor";
import { ApiError } from "../errors";

export const VENDOR_PERMISSIONS = {
  /** Входящие заявки: читать, отвечать, звонить */
  "requests.write": ["owner", "member"],
  /** Календарь занятости */
  "calendar.write": ["owner", "member"],
  /** Предложить и отозвать правку карточки */
  "card.propose": ["owner"],
  /** Загрузить и удалить фото площадки */
  "photos.write": ["owner"],
} as const satisfies Record<string, readonly VendorRole[]>;

export type VendorPermission = keyof typeof VENDOR_PERMISSIONS;

export function vendorCan(role: VendorRole, permission: VendorPermission): boolean {
  return (VENDOR_PERMISSIONS[permission] as readonly VendorRole[]).includes(role);
}

/** 403 с кодом, по которому кабинет объясняет: это делает владелец кабинета */
export const vendorOwnerRequired = () =>
  new ApiError(403, "vendor_owner_required", "Only the cabinet owner can do this");

/** Право у роли актора — или 403 vendor_owner_required */
export function assertVendorCan(actor: VendorActor, permission: VendorPermission): void {
  if (!vendorCan(actor.role, permission)) throw vendorOwnerRequired();
}
