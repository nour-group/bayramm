// Права сотрудников по ролям — единственная таблица. Проверяется на каждом
// запросе (requirePermission перед обработчиком); панель получает список прав в
// GET /staff/me только затем, чтобы не показывать недоступные кнопки.
//
// Разделение намеренное: кто заполняет карточку (менеджер), тот её не публикует
// (модератор). Администратор может всё. Роли не упорядочены — каждое право
// перечисляет их явно.
//
// Телефоны клиентов, кроме этой проверки, база отдаёт только администратору
// и только с причиной (функции базы read_request_phone / read_client_phone).

import type { StaffPermission } from "@bayramm/shared/api/staff";
import { requireStaff } from "../auth/session";
import type { StaffRole } from "../db/actor";

const ALL = ["admin", "manager", "moderator"] as const satisfies readonly StaffRole[];

export const PERMISSIONS = {
  /** Списки и карточки вендоров, листингов, справочники */
  "catalog.read": ALL,
  /** Создавать и править вендоров, их реквизиты, контакты и чек-лист проверки */
  "vendors.write": ["admin", "manager"],
  /** Пользователи кабинета вендора: завести по телефону, отключить */
  "vendor_users.write": ["admin", "manager"],
  /** Создавать и править карточки: поля, пакеты, телефон, фото, занятость */
  "listings.write": ["admin", "manager"],
  /** Отправить карточку на проверку */
  "listings.submit": ["admin", "manager"],
  /** Опубликовать (в том числе вернуть из приостановки) — одобряет и фото карточки */
  "listings.publish": ["admin", "moderator"],
  /** Приостановить и отклонить — только с причиной */
  "listings.moderate": ["admin", "moderator"],
  /** Вернуть в черновик: на доработку после проверки или отказа */
  "listings.draft": ALL,
  /** Решение по отдельному фото: одобрить или отклонить */
  "photos.moderate": ["admin", "moderator"],
  /** Телефоны вендора (контактное лицо, вход, телефон карточки) — с записью в журнал */
  "vendor_phones.read": ALL,
  /** Заявки клиентов и SLA */
  "requests.read": ["admin", "manager"],
  /** Телефон клиента из заявки — с причиной и записью в журнал */
  "client_phones.read": ["admin"],
} as const satisfies Record<StaffPermission, readonly StaffRole[]>;

export type Permission = StaffPermission;

export function can(role: StaffRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly StaffRole[]).includes(role);
}

/** Права роли — для панели (какие кнопки показывать) */
export function permissionsOf(role: StaffRole): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((permission) => can(role, permission));
}

/** Middleware: сотрудник с этим правом, иначе 401/403 (см. requireStaff) */
export function requirePermission(permission: Permission) {
  return requireStaff(...PERMISSIONS[permission]);
}
