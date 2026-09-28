// Актор запроса и транзакция под ним. Вся изоляция данных — в RLS базы:
// политики читают GUC app.actor_kind / app.actor_id / app.vendor_id
// (supabase/migrations/20260928120000_foundation.sql, «контекст актора»).

import { sql, type Transaction } from "kysely";
import type { Db } from "./client";
import type { AppStaffRole, DB } from "./schema.generated";

export type StaffRole = AppStaffRole;

// kind совпадает со значениями app.actor_kind; guest — актора нет,
// RLS показывает только публичное (активные листинги, справочники).
// Роль сотрудника — для проверок в API (requireStaff); в базу уходят только
// kind и id, роль там читает app.current_staff_role()
export type Actor =
  | { readonly kind: "guest" }
  | { readonly kind: "system" }
  | { readonly kind: "client"; readonly id: string }
  | { readonly kind: "vendor_user"; readonly id: string; readonly vendorId: string }
  | { readonly kind: "staff"; readonly id: string; readonly role: StaffRole };

export type ActorKind = Actor["kind"];
export type ClientActor = Extract<Actor, { kind: "client" }>;
export type StaffActor = Extract<Actor, { kind: "staff" }>;

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
    await sql`select set_config('app.actor_kind', ${s.kind}, true),
                     set_config('app.actor_id', ${s.id}, true),
                     set_config('app.vendor_id', ${s.vendorId}, true)`.execute(trx);
    return fn(trx);
  });
}
