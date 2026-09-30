// Актор запроса и транзакция под ним. Вся изоляция данных — в RLS базы:
// политики читают GUC app.actor_kind / app.actor_id / app.vendor_id
// (supabase/migrations/20260928120000_foundation.sql, «контекст актора»).

import { sql, type Transaction } from "kysely";
import type { Db } from "./client";
import type { AppActorKind, AppStaffRole, DB } from "./schema.generated";

export type StaffRole = AppStaffRole;
/** Роль в кабинете вендора (app.vendor_users.role): что кому можно — vendor/access.ts */
export type VendorRole = "owner" | "member";

/**
 * Вид актора в журналах статусов (заявки, карточки): account там не бывает — статусы
 * меняют роли (клиент, партнёр, сотрудник) и система, а не аккаунт
 */
export type RoleActorKind = Exclude<AppActorKind, "account">;
export const roleActorKind = (kind: AppActorKind) => kind as RoleActorKind;

// kind совпадает со значениями app.actor_kind; guest — актора нет,
// RLS показывает только публичное (активные листинги, справочники).
// account — человек над своим аккаунтом (профиль, способы входа, удаление);
// роли клиента, партнёра и сотрудника — отдельные акторы, их API выводит из
// членств аккаунта (auth/session.ts).
// Роль сотрудника — для проверок в API (requireStaff); в базу уходят только
// kind и id, роль там читает app.current_staff_role(). Так же роль партнёра: API
// проверяет её сам (vendor/access.ts), база — по app.vendor_users (app.edits_listing)
export type Actor =
  | { readonly kind: "guest" }
  | { readonly kind: "system" }
  | { readonly kind: "account"; readonly id: string }
  | { readonly kind: "client"; readonly id: string }
  | {
      readonly kind: "vendor_user";
      readonly id: string;
      readonly vendorId: string;
      readonly role: VendorRole;
    }
  | { readonly kind: "staff"; readonly id: string; readonly role: StaffRole };

export type ActorKind = Actor["kind"];
export type AccountActor = Extract<Actor, { kind: "account" }>;
export type ClientActor = Extract<Actor, { kind: "client" }>;
export type StaffActor = Extract<Actor, { kind: "staff" }>;
export type VendorActor = Extract<Actor, { kind: "vendor_user" }>;

export type Tx = Transaction<DB>;

export const GUEST: Actor = { kind: "guest" };
// Служебные операции: вход, поиск сессии по токену. Видит всё — только на сервере
export const SYSTEM: Actor = { kind: "system" };

/** Значения GUC для актора. Пустая строка — «не задано» (функции app.actor_* превращают её в null). */
export interface ActorSettings {
  kind: string;
  id: string;
  vendorId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: string): string {
  // Кривой id — ошибка кода, а не ввода: база упала бы на ::uuid уже внутри политики
  if (!UUID_RE.test(value)) throw new TypeError("withActor: id актора должен быть UUID");
  return value.toLowerCase();
}

export function actorSettings(actor: Actor): ActorSettings {
  switch (actor.kind) {
    case "guest":
      return { kind: "", id: "", vendorId: "" };
    case "system":
      return { kind: "system", id: "", vendorId: "" };
    case "account":
    case "client":
    case "staff":
      return { kind: actor.kind, id: uuid(actor.id), vendorId: "" };
    case "vendor_user":
      return { kind: "vendor_user", id: uuid(actor.id), vendorId: uuid(actor.vendorId) };
  }
}

/**
 * Открывает транзакцию, выставляет актора (set_config(..., true) — только на эту
 * транзакцию) и выполняет fn. Ошибка в fn откатывает транзакцию целиком.
 *
 * Все запросы внутри fn — только через trx: запрос через db в обход транзакции
 * пошёл бы без актора, а при пуле в одно соединение — повис бы.
 */
export async function withActor<T>(db: Db, actor: Actor, fn: (trx: Tx) => Promise<T>): Promise<T> {
  const s = actorSettings(actor);
  return db.transaction().execute(async (trx) => {
    await setActor(trx, s);
    return fn(trx);
  });
}

async function setActor(trx: Tx, s: ActorSettings): Promise<void> {
  await sql`select set_config('app.actor_kind', ${s.kind}, true),
                   set_config('app.actor_id', ${s.id}, true),
                   set_config('app.vendor_id', ${s.vendorId}, true)`.execute(trx);
}

/**
 * Переключает уже открытую транзакцию на другого актора до её конца. Только
 * для шагов одного и того же человека: например, вход (system) → действие
 * от имени его же аккаунта.
 */
export async function continueAs(trx: Tx, actor: Actor): Promise<void> {
  await setActor(trx, actorSettings(actor));
}

/**
 * Переключает уже открытую транзакцию на актора system до её конца.
 *
 * Только для служебного шага в конце транзакции, начатой под настоящим
 * актором: например, отметить фото, загруженное вендором, как проверенное
 * сервером — это не может делать сам вендор (триггер photos_guard). Всё, что
 * выполняется после вызова, видит и меняет всё, как system.
 */
export async function continueAsSystem(trx: Tx): Promise<void> {
  await setActor(trx, actorSettings(SYSTEM));
}
