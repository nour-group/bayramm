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

/**
 * Имя, которое клиент вписал в заявку, по столбцу с id заявки: чья она. null — контакта нет
 * или он удалён по сроку хранения. Телефон не читается. Панель оператора
 */
export function requestContactName(column: string): RawBuilder<string | null> {
  return sql<
    string | null
  >`(select case when c.purged_at is null then c.contact_name end from pii.request_contacts c where c.request_id = ${sql.ref(column)})`;
}

/** Есть ли у листинга телефон для заявок — сам номер не читается. Панель оператора */
export function hasListingPhone(column: string): RawBuilder<boolean> {
  return sql<boolean>`exists (select 1 from pii.listing_contacts c where c.listing_id = ${sql.ref(column)})`;
}

/**
 * Какие контакты витрины вписаны — phone, telegram — без самих значений (pii.listing_contact_kinds).
 * Карточка клиента (какие кнопки в «Связаться»), панель (что заполнено)
 */
export function listingContactKinds(column: string): RawBuilder<("phone" | "telegram")[]> {
  return sql<("phone" | "telegram")[]>`pii.listing_contact_kinds(${sql.ref(column)})`;
}

/**
 * Телефон листинга по столбцу с его id, без причины: у активного — публичный (без
 * журнала), у остальных — только владельцу, с записью в журнал. Каталог (гость), кабинет вендора
 */
export function listingPhone(column: string): RawBuilder<string | null> {
  return sql<string | null>`pii.read_listing_phone(${sql.ref(column)})`;
}

// ── имена пачкой: подписи в журналах и уведомлениях ─────────────────────────
// Один запрос на страницу, а не на строку; телефонов не читают

/** Имена сотрудников по id: id → имя (нет профиля — нет в карте). Панель оператора: журналы, уведомления */
export async function staffNames(trx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom("pii.staff_profiles")
    .select(["staff_id", "display_name"])
    .where("staff_id", "in", [...ids])
    .execute();
  return new Map(rows.map((row) => [row.staff_id, row.display_name]));
}

/**
 * ФИО пользователей кабинета по id: id → ФИО (нет профиля или ФИО не вписано — нет в карте).
 * Панель оператора: журналы, уведомления
 */
export async function vendorUserNames(trx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom("pii.vendor_user_profiles")
    .select(["vendor_user_id", "full_name"])
    .where("vendor_user_id", "in", [...ids])
    .execute();
  const names = new Map<string, string>();
  for (const row of rows) if (row.full_name !== null) names.set(row.vendor_user_id, row.full_name);
  return names;
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

/** Контакты витрины для клиентов: телефон и Telegram (имя без @) */
export interface ListingContactValues {
  readonly phone: string | null;
  readonly telegram: string | null;
}

/**
 * Клиент нажал «Связаться»: контакты опубликованной витрины и событие open — одним вызовом
 * (pii.reveal_listing_contacts; без события контактов не прочитать). null — витрина не
 * опубликована или её нет. Каталог (гость или клиент)
 */
export async function revealListingContacts(
  trx: Tx,
  listingId: string,
  source: "tma" | "web",
  signedIn: boolean,
): Promise<ListingContactValues | null> {
  const { rows } = await sql<ListingContactValues>`
    select phone, telegram from pii.reveal_listing_contacts(${listingId}::uuid, ${source}::text, ${signedIn}::boolean)
  `.execute(trx);
  const row = rows[0];
  return row === undefined ? null : { phone: row.phone, telegram: row.telegram };
}

/** Телефон и Telegram витрины с причиной (неопубликованной — в журнал). Панель оператора */
export async function readListingContacts(
  trx: Tx,
  listingId: string,
  reason: string | null,
): Promise<ListingContactValues> {
  const { rows } = await sql<ListingContactValues>`
    select phone, telegram from pii.read_listing_contacts(${listingId}::uuid, ${reason}::text)
  `.execute(trx);
  return { phone: rows[0]?.phone ?? null, telegram: rows[0]?.telegram ?? null };
}

// ── запросы партнёра на смену контактов витрины ─────────────────────────────
// Витрина на проверке или на сайте: телефон и Telegram партнёр меняет запросом
// (pii.listing_contact_changes, одна ждущая строка на витрину), решает администратор или
// модератор. Значения читает только pii.read_listing_contact_change (в журнал доступа к ПДн);
// таблицы API не видит — всё функциями базы

/** Последний запрос на смену контактов — без значений: что меняется, причина отказа, время */
export interface ContactChangeState {
  readonly id: string;
  readonly status: "pending" | "approved" | "declined" | "withdrawn";
  readonly reason: string | null;
  readonly submittedAt: Date;
  readonly decidedAt: Date | null;
  readonly phoneChanged: boolean;
  readonly telegramChanged: boolean;
}

/**
 * Состояние последнего запроса на смену контактов (ждущий — первым); null — запросов не было.
 * Без значений, в журнал не пишется. Кабинет вендора, панель оператора, оповещения
 */
export async function contactChangeState(trx: Tx, listingId: string): Promise<ContactChangeState | null> {
  const { rows } = await sql<{
    change_id: string;
    status: ContactChangeState["status"];
    reason: string | null;
    submitted_at: Date;
    decided_at: Date | null;
    phone_changed: boolean;
    telegram_changed: boolean;
  }>`select change_id, status, reason, submitted_at, decided_at, phone_changed, telegram_changed
     from app.contact_change_state(${listingId}::uuid)`.execute(trx);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.change_id,
    status: row.status,
    reason: row.reason,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    phoneChanged: row.phone_changed,
    telegramChanged: row.telegram_changed,
  };
}

/** Значения ждущего запроса (в журнал доступа к ПДн); null — ждущего нет. Кабинет вендора (свой), панель */
export async function readContactChange(
  trx: Tx,
  listingId: string,
  reason: string | null,
): Promise<{ readonly phone: string; readonly telegram: string | null } | null> {
  const { rows } = await sql<{ phone: string | null; telegram: string | null }>`
    select phone, telegram from pii.read_listing_contact_change(${listingId}::uuid, ${reason}::text)`.execute(
    trx,
  );
  const row = rows[0];
  return row === undefined || row.phone === null ? null : { phone: row.phone, telegram: row.telegram };
}

/**
 * Запрос на смену контактов витрины на проверке или на сайте: заменяет ждущий. null — значения
 * те же, что сейчас (no_changes). Витрина вне сайта — BR038 (там контакты пишутся сразу).
 * Команде — оповещение. Кабинет вендора (владелец)
 */
export async function submitContactChange(
  trx: Tx,
  listingId: string,
  phone: string,
  telegram: string | null,
): Promise<string | null> {
  const { rows } = await sql<{ id: string | null }>`
    select app.vendor_submit_contact_change(${listingId}::uuid, ${phone}::text, ${telegram}::text) as id`.execute(
    trx,
  );
  return rows[0]?.id ?? null;
}

/** Отозвать ждущий запрос; ждущего нет — BR037. Кабинет вендора (владелец) */
export async function withdrawContactChange(trx: Tx, listingId: string): Promise<void> {
  await sql`select app.vendor_withdraw_contact_change(${listingId}::uuid)`.execute(trx);
}

/** Одобрить ждущий запрос: значения — в контакты витрины; ждущего нет — BR037. Панель оператора */
export async function approveContactChange(trx: Tx, listingId: string): Promise<void> {
  await sql`select app.staff_approve_contact_change(${listingId}::uuid)`.execute(trx);
}

/** Отклонить ждущий запрос — только с причиной (BR010); ждущего нет — BR037. Панель оператора */
export async function declineContactChange(trx: Tx, listingId: string, reason: string): Promise<void> {
  await sql`select app.staff_decline_contact_change(${listingId}::uuid, ${reason}::text)`.execute(trx);
}

/** Строка очереди запросов на смену контактов (без значений) */
export interface ContactChangeRow {
  readonly changeId: string;
  readonly listingId: string;
  readonly listingName: string;
  readonly listingStatus: "lead" | "draft" | "review" | "active" | "suspended" | "rejected";
  readonly categoryCode: string;
  readonly vendorId: string;
  readonly vendorCode: string;
  readonly submittedAt: Date;
  readonly phoneChanged: boolean;
  readonly telegramChanged: boolean;
}

/** Очередь ждущих запросов, старые сверху: строки и сколько всего. Панель оператора */
export async function listContactChanges(
  trx: Tx,
  limit: number,
  offset: number,
): Promise<{ readonly total: number; readonly items: readonly ContactChangeRow[] }> {
  const { rows } = await sql<{
    change_id: string;
    listing_id: string;
    listing_name: string;
    listing_status: ContactChangeRow["listingStatus"];
    category_code: string;
    vendor_id: string;
    vendor_code: string;
    submitted_at: Date;
    phone_changed: boolean;
    telegram_changed: boolean;
    total: string;
  }>`select change_id, listing_id, listing_name, listing_status, category_code, vendor_id, vendor_code, submitted_at,
            phone_changed, telegram_changed, total
     from app.staff_contact_changes(${limit}::int, ${offset}::int)`.execute(trx);
  return {
    total: rows[0] === undefined ? 0 : Number(rows[0].total),
    items: rows.map((row) => ({
      changeId: row.change_id,
      listingId: row.listing_id,
      listingName: row.listing_name,
      listingStatus: row.listing_status,
      categoryCode: row.category_code,
      vendorId: row.vendor_id,
      vendorCode: row.vendor_code,
      submittedAt: row.submitted_at,
      phoneChanged: row.phone_changed,
      telegramChanged: row.telegram_changed,
    })),
  };
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

/**
 * Telegram витрины для клиентов (имя без @) рядом с телефоном; null — убрать. Строки контактов
 * без телефона не бывает — false: сначала телефон. Панель оператора
 */
export async function saveListingTelegram(
  trx: Tx,
  listingId: string,
  telegram: string | null,
): Promise<boolean> {
  const updated = await trx
    .updateTable("pii.listing_contacts")
    .set({ public_telegram: telegram })
    .where("listing_id", "=", listingId)
    .returning("listing_id")
    .executeTakeFirst();
  return updated !== undefined || telegram === null;
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
 * Приглашение в кабинет вендора: строку пользователя и профиль с номером и именем
 * (pii.vendor_user_profiles) пишет функция базы app.staff_invite_vendor_user — администратору
 * и менеджеру. phoneHash — HMAC того же номера (phoneHash из auth/crypto.ts). accepted —
 * номер уже подтверждён у аккаунта, приглашение принято сразу. Номер уже у вендора — 23505
 * (phone_taken), сотрудник площадки без владельца — BR031, человек уже в кабинете — BR032.
 * Панель оператора
 */
export async function inviteVendorUser(
  trx: Tx,
  invite: {
    vendorId: string;
    phone: string;
    phoneHash: Uint8Array;
    fullName: string | null;
    role: "owner" | "member";
    locale: "ru" | "uz" | null;
  },
): Promise<{ id: string; accepted: boolean }> {
  const { rows } = await sql<{ vendor_user_id: string; accepted: boolean }>`
    select vendor_user_id, accepted
    from app.staff_invite_vendor_user(${invite.vendorId}::uuid, ${invite.phoneHash}::bytea, ${invite.phone}::text,
                                      ${invite.fullName}::text, ${invite.role}::text,
                                      ${invite.locale}::app.locale)`.execute(trx);
  const row = rows[0];
  if (row === undefined) throw new Error("app.staff_invite_vendor_user: нет строки");
  return { id: row.vendor_user_id, accepted: row.accepted };
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
