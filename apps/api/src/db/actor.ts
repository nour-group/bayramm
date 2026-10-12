// Актор запроса и транзакция под ним. Вся изоляция данных — в RLS базы:
// политики читают GUC app.actor_kind / app.actor_id / app.vendor_id
// (supabase/migrations/20260928120000_foundation.sql, «контекст актора»).

import { type ControlledTransaction, sql, type Transaction } from "kysely";
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
 *
 * Если до этого запрос открыл транзакцию преамбулы (inPreamble: вход по токену, членства
 * вендора), её продолжает первый withActor обработчика: актор переключается set_config'ом, а не
 * новой транзакцией — без лишних begin и commit и без своего круга до базы на каждый шаг.
 * Фиксируется она так же, как обычная: по концу fn (commit) или откатом по ошибке.
 */
export async function withActor<T>(db: Db, actor: Actor, fn: (trx: Tx) => Promise<T>): Promise<T> {
  const s = actorSettings(actor);
  const carried = preambles.get(db);
  if (carried !== undefined) {
    // Забирает один вызов: параллельный второй откроет свою транзакцию и дождётся соединения
    preambles.delete(db);
    clearTimeout(carried.timer);
    return finishIn(carried.trx, async (trx) => {
      await setActor(trx, s);
      return fn(trx);
    });
  }
  return db.transaction().execute(async (trx) => {
    await setActor(trx, s);
    return fn(trx);
  });
}

// ── одна транзакция на запрос ───────────────────────────────────────────────
//
// Запрос с токеном раньше открывал отдельную транзакцию на каждый шаг (сессия, членства
// вендора, сам обработчик) — по четыре оператора (begin, set_config, запрос, commit) и по кругу
// до базы на каждый. Теперь шаги преамбулы (authenticate, requireVendor) идут в одной открытой
// транзакции, и её продолжает первый withActor обработчика. Остальные транзакции обработчика —
// как прежде, отдельные: каждая фиксируется сама (журнал попыток кода, например, переживает
// последующий отказ). До обработчика ничего в ней не пишется: шаги преамбулы только читают.

/**
 * Сколько транзакция преамбулы ждёт обработчика, прежде чем её закроют: до первого обращения к
 * базе обработчик может читать тело запроса (фото — до 10 МБ по мобильной сети) или звать
 * внешний сервис, а открытая транзакция всё это время держит соединение с базой (Hyperdrive).
 * Закрыли — обработчик откроет свою, как до объединения
 */
export const PREAMBLE_HOLD_MS = 1_000;

interface Held {
  readonly trx: ControlledTransaction<DB>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Транзакция преамбулы запроса, ещё не отданная обработчику; ключ — база запроса (один Db на запрос) */
const preambles = new WeakMap<Db, Held>();
/** Что выставлено в GUC транзакции сейчас: повторный set_config тем же актором пропускается */
const current = new WeakMap<Tx, string>();

async function finishIn<T>(trx: ControlledTransaction<DB>, fn: (trx: Tx) => Promise<T>): Promise<T> {
  try {
    const result = await fn(trx);
    await trx.commit().execute();
    return result;
  } catch (error) {
    // Исходную ошибку не подменяем сбоем отката (обрыв связи)
    await trx
      .rollback()
      .execute()
      .catch(() => {});
    throw error;
  }
}

/**
 * Шаг преамбулы под актором system: сессия по токену, членства аккаунта. Транзакция остаётся
 * открытой для следующего шага и для первого withActor обработчика; если обработчик базы не
 * коснулся, закрывает её closePreamble (authenticate и database — в finally). Ошибка шага
 * откатывает транзакцию и закрывает её: запрос всё равно ответит ошибкой.
 */
export async function inPreamble<T>(db: Db, fn: (trx: Tx) => Promise<T>): Promise<T> {
  let held = preambles.get(db);
  if (held === undefined) {
    held = { trx: await db.startTransaction().execute(), timer: undefined };
    preambles.set(db, held);
  }
  const open = held;
  // Пока идёт шаг, часы не нужны; между шагами и до обработчика — PREAMBLE_HOLD_MS
  clearTimeout(open.timer);
  try {
    await setActor(open.trx, actorSettings(SYSTEM));
    const result = await fn(open.trx);
    open.timer = setTimeout(() => void closePreamble(db), PREAMBLE_HOLD_MS);
    return result;
  } catch (error) {
    if (preambles.get(db) === open) preambles.delete(db);
    await open.trx
      .rollback()
      .execute()
      .catch(() => {});
    throw error;
  }
}

/** Закрыть транзакцию преамбулы, которую никто не взял: обработчик базы не касался, ждал дольше срока или запрос отклонён */
export async function closePreamble(db: Db): Promise<void> {
  const held = preambles.get(db);
  if (held === undefined) return;
  preambles.delete(db);
  clearTimeout(held.timer);
  try {
    await finishIn(held.trx, async () => undefined);
  } catch (err) {
    console.error("db: preamble close failed", err instanceof Error ? err.name : typeof err);
  }
}

async function setActor(trx: Tx, s: ActorSettings): Promise<void> {
  const key = `${s.kind}|${s.id}|${s.vendorId}`;
  // Тот же актор уже выставлен в этой транзакции (SQL-функции, подменяющие GUC, возвращают его
  // назад) — лишний круг до базы не нужен
  if (current.get(trx) === key) return;
  await sql`select set_config('app.actor_kind', ${s.kind}, true),
                   set_config('app.actor_id', ${s.id}, true),
                   set_config('app.vendor_id', ${s.vendorId}, true)`.execute(trx);
  current.set(trx, key);
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
