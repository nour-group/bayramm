// Подписи к id в журналах и очереди уведомлений: название витрины или вендора, «№1051» заявки,
// код клиента C-…, имя сотрудника или пользователя кабинета. Берутся пачкой — один запрос на вид
// объекта на страницу, а не на строку. Чего в базе нет (удалено, не было), остаётся без подписи:
// панель покажет короткий id. Телефонов подписи не несут.

import type { Tx } from "../db/actor";
import { staffNames, vendorUserNames } from "../db/pii";
import { isUuid } from "./input";
import { clientRef, num } from "./shared";

/** Что подписать: вид объекта (как в журнале или у получателя) и его id */
export interface LabelRef {
  readonly type: string;
  readonly id: string | null;
}

/** Контакт заявки, вендора и витрины — это та же заявка, вендор и витрина: подпись у них общая */
const SAME_AS: Readonly<Record<string, string>> = {
  request_contact: "request",
  vendor_contact: "vendor",
  listing_contact: "listing",
};

const canonical = (type: string): string => SAME_AS[type] ?? type;
const keyOf = (type: string, id: string): string => `${canonical(type)}:${id.toLowerCase()}`;

/** «№1051» — номер заявки в подписи */
export const requestLabel = (publicNo: number): string => `№${publicNo}`;

/** Найденные подписи: вид и id → слова; нет — null */
export class Labels {
  constructor(private readonly found: ReadonlyMap<string, string>) {}

  get(type: string, id: string | null): string | null {
    return id === null ? null : (this.found.get(keyOf(type, id)) ?? null);
  }
}

type Lookup = (trx: Tx, ids: string[]) => Promise<Map<string, string>>;

const listingLabels: Lookup = async (trx, ids) => {
  const rows = await trx.selectFrom("app.listings").select(["id", "name"]).where("id", "in", ids).execute();
  return new Map(rows.map((row) => [row.id, row.name]));
};

const vendorLabels: Lookup = async (trx, ids) => {
  const rows = await trx
    .selectFrom("app.vendor_accounts")
    .select(["id", "name", "public_code"])
    .where("id", "in", ids)
    .execute();
  return new Map(rows.map((row) => [row.id, row.name ?? row.public_code]));
};

const requestLabels: Lookup = async (trx, ids) => {
  const rows = await trx
    .selectFrom("app.requests")
    .select(["id", "public_no"])
    .where("id", "in", ids)
    .execute();
  return new Map(rows.map((row) => [row.id, requestLabel(num(row.public_no))]));
};

// Код клиента выводится из id, запроса не нужно: он есть и у клиента, удалившего аккаунт
const clientLabels: Lookup = async (_trx, ids) => new Map(ids.map((id) => [id, clientRef(id)]));

const staffLabels: Lookup = (trx, ids) => staffNames(trx, ids);

/** Пользователь кабинета: его имя, а без него — название вендора */
const vendorUserLabels: Lookup = async (trx, ids) => {
  const rows = await trx
    .selectFrom("app.vendor_users as u")
    .innerJoin("app.vendor_accounts as v", "v.id", "u.vendor_id")
    .select(["u.id", "v.name", "v.public_code"])
    .where("u.id", "in", ids)
    .execute();
  const names = await vendorUserNames(trx, ids);
  return new Map(rows.map((row) => [row.id, names.get(row.id) ?? row.name ?? row.public_code]));
};

// Map, а не объект: вид объекта приходит из журнала, и «constructor» не должен находиться
const LOOKUPS: ReadonlyMap<string, Lookup> = new Map([
  ["listing", listingLabels],
  ["vendor", vendorLabels],
  ["request", requestLabels],
  ["client", clientLabels],
  ["staff", staffLabels],
  ["vendor_user", vendorUserLabels],
]);

/** Какие id по каждому виду нужно подписать: без повторов, только те виды, что умеем, и только UUID */
export function groupRefs(refs: Iterable<LabelRef>): Map<string, string[]> {
  const grouped = new Map<string, Set<string>>();
  for (const ref of refs) {
    const type = canonical(ref.type);
    if (ref.id === null || !LOOKUPS.has(type) || !isUuid(ref.id)) continue;
    const ids = grouped.get(type) ?? new Set<string>();
    ids.add(ref.id.toLowerCase());
    grouped.set(type, ids);
  }
  return new Map([...grouped].map(([type, ids]) => [type, [...ids]]));
}

/** Подписи ко всем refs страницы: по одному запросу на вид (запросы транзакции идут по очереди) */
export async function loadLabels(trx: Tx, refs: Iterable<LabelRef>): Promise<Labels> {
  const found = new Map<string, string>();
  for (const [type, ids] of groupRefs(refs)) {
    const lookup = LOOKUPS.get(type);
    if (lookup === undefined) continue;
    for (const [id, label] of await lookup(trx, ids)) found.set(keyOf(type, id), label);
  }
  return new Labels(found);
}
