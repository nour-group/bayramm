// Персональные данные — только через этот файл.
//
// Схема pii (профили, контакты заявок, реквизиты вендоров, телефоны листингов)
// и её функции pii.read_* упоминаются в коде API только здесь. Так любой доступ
// к ПДн виден в ревью одним местом: новая запись, новое чтение или новое
// соединение с таблицей pii — это правка этого файла.
//
//   · записи — именованные функции; trx — транзакция под актором запроса (withActor);
//   · телефоны читаются только функциями pii.read_*: база сама решает, кому
//     отдать номер, и пишет чтение в журнал доступа. Столбцы телефонов API не
//     выбирает никогда;
//   · соединения и подзапросы — готовые выражения для Kysely: таблица с
//     псевдонимом для join и фрагменты sql для select.
//
// Кто какие строки видит, решают RLS и функции базы под актором транзакции, а
// не этот файл. Правило держит тест pii.test.ts рядом: `pii.` в любом другом
// файле src (кроме тестов и сгенерированной схемы) — красный тест.

import { type RawBuilder, sql, type Updateable } from "kysely";
import type { Tx } from "./actor";
import type { AppStaffRole, PiiVendorContacts } from "./schema.generated";

// ── таблицы для join ───────────────────────────────────────────────────────
// «pii.<таблица> as <псевдоним>» с литеральным типом — по нему Kysely проверяет
// столбцы. Столбцы телефонов через join не выбирать: только pii.read_* ниже

/** Профиль сотрудника: имя, Telegram username и чат. Панель оператора, уведомления команде */
export const staffProfilesAs = <A extends string>(alias: A) => `pii.staff_profiles as ${alias}` as const;

/** Профиль клиента: имя, username, Telegram ID. Сам клиент (/me), уведомления клиенту */
export const clientProfilesAs = <A extends string>(alias: A) => `pii.client_profiles as ${alias}` as const;

/** Профиль пользователя вендора: ФИО, Telegram-чат. Кабинет вендора (свой), панель, уведомления */
export const vendorUserProfilesAs = <A extends string>(alias: A) =>
  `pii.vendor_user_profiles as ${alias}` as const;

/** Реквизиты и контакт вендора: юрназвание, СТИР, адрес, контактное лицо. Кабинет вендора, панель */
export const vendorContactsAs = <A extends string>(alias: A) => `pii.vendor_contacts as ${alias}` as const;

/** Контакт заявки: имя и комментарий клиента (видимость — по согласию, RLS). Кабинет вендора, панель */
export const requestContactsAs = <A extends string>(alias: A) => `pii.request_contacts as ${alias}` as const;

// ── фрагменты для select ────────────────────────────────────────────────────

/** Имя сотрудника по столбцу с его id (null — не сотрудник или нет профиля). Панель оператора */
export function staffName(column: string): RawBuilder<string | null> {
  return sql<
    string | null
  >`(select p.display_name from pii.staff_profiles p where p.staff_id = ${sql.ref(column)})`;
}

/** Имя сотрудника по id текстом — например, из payload уведомления (null — нет такого). Панель оператора */
export function staffNameByText(id: RawBuilder<string | null>): RawBuilder<string | null> {
  return sql<string | null>`(select p.display_name from pii.staff_profiles p where p.staff_id::text = ${id})`;
}

/**
 * Сколько пользователей вендора получат уведомление: не отключены, привязали Telegram,
 * бот знает их чат — те же условия, что у app.enqueue_vendor_notice. Панель оператора
 */
export function notifiableVendorUsers(vendorColumn: string): RawBuilder<number> {
  return sql<number>`(select count(*)::int from app.vendor_users u
    join pii.vendor_user_profiles p on p.vendor_user_id = u.id
    where u.vendor_id = ${sql.ref(vendorColumn)} and u.disabled_at is null
      and u.tg_linked_at is not null and p.telegram_chat_id is not null)`;
}

/** Есть ли у листинга телефон для заявок — сам номер не читается. Панель оператора */
export function hasListingPhone(column: string): RawBuilder<boolean> {
  return sql<boolean>`exists (select 1 from pii.listing_contacts c where c.listing_id = ${sql.ref(column)})`;
}

/**
 * Телефон листинга по столбцу с его id, без причины: у активного — публичный (без
 * журнала), у остальных — только владельцу, с записью в журнал. Каталог (гость), кабинет вендора
 */
export function listingPhone(column: string): RawBuilder<string | null> {
  return sql<string | null>`pii.read_listing_phone(${sql.ref(column)})`;
}

// ── чтение телефонов (журнал доступа пишет база) ────────────────────────────

type PhoneRow = { phone: string | null };

async function firstPhone(trx: Tx, query: RawBuilder<PhoneRow>): Promise<string | null> {
  const { rows } = await query.execute(trx);
  return rows[0]?.phone ?? null;
}

/**
 * Телефон клиента из заявки. Вендор — без причины (reason не передаётся), пока
 * действует согласие; сотрудник — только admin и с причиной. Кабинет вендора, панель
 */
export function readRequestPhone(trx: Tx, requestId: string, reason?: string | null): Promise<string | null> {
  return firstPhone(
    trx,
    reason === undefined
      ? sql<PhoneRow>`select pii.read_request_phone(${requestId}::uuid) as phone`
      : sql<PhoneRow>`select pii.read_request_phone(${requestId}::uuid, ${reason}::text) as phone`,
  );
}

/** Телефон из профиля клиента: только admin и с причиной (иначе ошибка базы), в журнал. Панель оператора */
export function readClientPhone(trx: Tx, clientId: string, reason: string | null): Promise<string | null> {
  return firstPhone(
    trx,
    sql<PhoneRow>`select pii.read_client_phone(${clientId}::uuid, ${reason}::text) as phone`,
  );
}

/** Телефон листинга с причиной (неопубликованного — в журнал). Панель оператора */
export function readListingPhone(trx: Tx, listingId: string, reason: string | null): Promise<string | null> {
  return firstPhone(
    trx,
    sql<PhoneRow>`select pii.read_listing_phone(${listingId}::uuid, ${reason}::text) as phone`,
  );
}

/** Телефон входа пользователя вендора (в журнал). Панель оператора */
export function readVendorUserPhone(
  trx: Tx,
  vendorUserId: string,
  reason: string | null,
): Promise<string | null> {
  return firstPhone(
    trx,
    sql<PhoneRow>`select pii.read_vendor_user_phone(${vendorUserId}::uuid, ${reason}::text) as phone`,
  );
}

/** Телефоны контактного лица вендора (в журнал). Панель оператора */
export async function readVendorContactPhones(
  trx: Tx,
  vendorId: string,
  reason: string | null,
): Promise<{ phone: string | null; phoneAlt: string | null }> {
  const { rows } = await sql<{ phone: string | null; phone_alt: string | null }>`
    select phone, phone_alt from pii.read_vendor_contact_phones(${vendorId}::uuid, ${reason}::text)`.execute(
    trx,
  );
  return { phone: rows[0]?.phone ?? null, phoneAlt: rows[0]?.phone_alt ?? null };
}

// ── записи ──────────────────────────────────────────────────────────────────

/** Контакт новой заявки: имя, телефон и комментарий клиента. Подача заявки клиентом */
export async function insertRequestContact(
  trx: Tx,
  contact: {
    request_id: string;
    contact_name: string | null;
    contact_phone: string | null;
    comment: string | null;
  },
): Promise<void> {
  await trx.insertInto("pii.request_contacts").values(contact).execute();
}

/**
 * Реквизиты и контакт вендора, включая телефоны, — только заданные поля. Панель оператора.
 * Телефонные столбцы API не читает, поэтому не INSERT … ON CONFLICT (DO UPDATE читал
 * бы их), а UPDATE, и если строки ещё нет — INSERT
 */
export async function saveVendorContacts(
  trx: Tx,
  vendorId: string,
  contacts: Omit<Updateable<PiiVendorContacts>, "vendor_id" | "updated_at">,
): Promise<void> {
  if (Object.keys(contacts).length === 0) return;
  const updated = await trx
    .updateTable("pii.vendor_contacts")
    .set(contacts)
    .where("vendor_id", "=", vendorId)
    .returning("vendor_id")
    .executeTakeFirst();
  if (!updated)
    await trx
      .insertInto("pii.vendor_contacts")
      .values({ vendor_id: vendorId, ...contacts })
      .execute();
}

/**
 * Телефон листинга для заявок: UPDATE, а если строки нет, INSERT (столбец API не
 * читает). null — убрать (у карточки на проверке или в каталоге триггер не даст). Панель оператора
 */
export async function saveListingPhone(trx: Tx, listingId: string, phone: string | null): Promise<void> {
  if (phone === null) {
    await trx.deleteFrom("pii.listing_contacts").where("listing_id", "=", listingId).execute();
    return;
  }
  const updated = await trx
    .updateTable("pii.listing_contacts")
    .set({ public_phone: phone })
    .where("listing_id", "=", listingId)
    .returning("listing_id")
    .executeTakeFirst();
  if (!updated) {
    await trx
      .insertInto("pii.listing_contacts")
      .values({ listing_id: listingId, public_phone: phone })
      .execute();
  }
}

/** Профиль нового пользователя вендора: телефон входа и ФИО. Панель оператора */
export async function insertVendorUserProfile(
  trx: Tx,
  vendorUserId: string,
  phone: string,
  fullName: string | null,
): Promise<void> {
  await trx
    .insertInto("pii.vendor_user_profiles")
    .values({ vendor_user_id: vendorUserId, phone, full_name: fullName })
    .execute();
}

/** Правка профиля пользователя вендора: телефон входа и/или ФИО. Панель оператора */
export async function updateVendorUserProfile(
  trx: Tx,
  vendorUserId: string,
  profile: { phone?: string; full_name?: string | null },
): Promise<void> {
  await trx
    .updateTable("pii.vendor_user_profiles")
    .set(profile)
    .where("vendor_user_id", "=", vendorUserId)
    .execute();
}

/** Снять привязку Telegram (ID пользователя и чата) с профиля пользователя вендора. Панель оператора */
export async function clearVendorUserTelegram(trx: Tx, vendorUserId: string): Promise<void> {
  await trx
    .updateTable("pii.vendor_user_profiles")
    .set({ telegram_user_id: null, telegram_chat_id: null })
    .where("vendor_user_id", "=", vendorUserId)
    .execute();
}

/**
 * Приглашение сотрудника: имя для панели, роль и способ входа — имя пользователя Telegram
 * или HMAC номера телефона (phoneHash из auth/crypto.ts; сам номер нигде не хранится).
 * Строку сотрудника и профиль с именем (pii.staff_profiles) пишут функции базы
 * app.staff_invite и app.staff_invite_phone — только администратору; занятое имя или
 * номер — 23505 (username_taken, staff_phone_taken). Панель оператора
 */
export async function inviteStaff(
  trx: Tx,
  invite: { displayName: string; role: AppStaffRole } & ({ username: string } | { phoneHash: Uint8Array }),
): Promise<void> {
  if ("username" in invite) {
    // Имя приводит к виду виджета (без «@», нижний регистр) триггер базы
    await sql`select app.staff_invite(${invite.username}::text, ${invite.displayName}::text,
                                      ${invite.role}::app.staff_role)`.execute(trx);
    return;
  }
  await sql`select app.staff_invite_phone(${invite.phoneHash}::bytea, ${invite.displayName}::text,
                                          ${invite.role}::app.staff_role)`.execute(trx);
}
