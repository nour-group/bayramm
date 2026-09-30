// Кабинет вендора: какой пользователь вендора действует в запросе.
//
// Партнёр — роль на аккаунте: app.vendor_users.account_id. Сотрудник заводит
// пользователя вендора с телефоном; к аккаунту он привязывается, когда аккаунт
// доказал этот номер — кодом из сообщения или контактом в боте. Человек может быть
// партнёром нескольких вендоров: тогда кабинет называет вендора заголовком
// X-Bayramm-Vendor, одно членство выбирается само. Отключённый пользователь вендора
// теряет доступ на следующем же запросе.

import { SYSTEM, type Tx, type VendorActor, type VendorRole, withActor } from "../db/actor";
import type { Db } from "../db/client";
import { ApiError, forbidden } from "../errors";

// Коды 403 — стабильные: по ним кабинет объясняет, что делать дальше
export const vendorNotLinked = () =>
  new ApiError(403, "vendor_not_linked", "Account is not a partner of any vendor");
export const vendorDisabled = () => new ApiError(403, "vendor_disabled", "Vendor access is disabled");
export const vendorChoiceRequired = () =>
  new ApiError(409, "vendor_choice_required", "Several vendors: choose one with X-Bayramm-Vendor");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Membership {
  readonly vendorUserId: string;
  readonly vendorId: string;
  readonly role: VendorRole;
  readonly disabled: boolean;
}

/** Членства аккаунта в вендорах, старые первыми; trx — под актором system */
export async function membershipsIn(trx: Tx, accountId: string): Promise<Membership[]> {
  const rows = await trx
    .selectFrom("app.vendor_users")
    .select(["id", "vendor_id", "role", "disabled_at"])
    .where("account_id", "=", accountId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return rows.map((row) => ({
    vendorUserId: row.id,
    vendorId: row.vendor_id,
    // Неизвестная роль — меньшие права
    role: row.role === "owner" ? "owner" : "member",
    disabled: row.disabled_at !== null,
  }));
}

/** Партнёр ли аккаунт: членств нет — 403 vendor_not_linked, все отключены — 403 vendor_disabled */
export function assertPartner(memberships: readonly Membership[]): Membership[] {
  if (memberships.length === 0) throw vendorNotLinked();
  const active = memberships.filter((m) => !m.disabled);
  if (active.length === 0) throw vendorDisabled();
  return active;
}

/**
 * Пользователь вендора для запроса. Членств нет — 403 vendor_not_linked; все
 * отключены — 403 vendor_disabled; заголовок называет вендора не из действующих
 * членств — 403; несколько членств без заголовка — 409 vendor_choice_required.
 */
export function chooseMembership(
  memberships: readonly Membership[],
  header: string | undefined,
): VendorActor {
  const active = assertPartner(memberships);

  const wanted = header?.trim();
  let chosen: Membership | undefined;
  if (wanted) {
    if (!UUID_RE.test(wanted)) throw forbidden();
    chosen = active.find((m) => m.vendorId === wanted.toLowerCase());
    if (chosen === undefined) throw forbidden();
  } else if (active.length === 1) {
    chosen = active[0];
  } else {
    throw vendorChoiceRequired();
  }
  if (chosen === undefined) throw vendorNotLinked();
  return { kind: "vendor_user", id: chosen.vendorUserId, vendorId: chosen.vendorId, role: chosen.role };
}

export async function vendorActorFor(
  db: Db,
  accountId: string,
  header: string | undefined,
): Promise<VendorActor> {
  const memberships = await withActor(db, SYSTEM, (trx) => membershipsIn(trx, accountId));
  return chooseMembership(memberships, header);
}
