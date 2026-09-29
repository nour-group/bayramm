// Вендоры в панели оператора: аккаунт (название, форма, договор, менеджер),
// реквизиты и контакты (vendor_contacts, db/pii), чек-лист проверки, пользователи
// кабинета. Контракт — @bayramm/shared/api/staff.
//
//   GET   /staff/vendors?q=&listingStatus=&limit=&offset=   список и поиск
//   POST  /staff/vendors                                     создать
//   GET   /staff/vendors/:id                                 вендор целиком
//   PATCH /staff/vendors/:id                                 правка
//   POST  /staff/vendors/:id/checklist  { item, done }       отметка проверки
//   POST  /staff/vendors/:id/phones     { reason? }          телефоны контакта (в журнал)
//   POST  /staff/vendors/:id/users      { phone, … }         пользователь кабинета
//   PATCH /staff/vendors/:id/users/:userId                   правка (телефон — пока не привязан)
//   POST  /staff/vendors/:id/users/:userId/disable | enable | unlink (снять привязку Telegram)
//   POST  /staff/vendors/:id/users/:userId/phone { reason? } телефон входа (в журнал)
//
// Телефоны только пишутся: прочитать их можно лишь функциями базы read_* — каждое
// чтение ложится в app.pii_access_log. Telegram ID пользователя наружу не
// отдаётся — только «привязан / нет». Журнал действий пишет база (триггер
// audit_staff), API его не трогает.

import { normalizeUzPhone } from "@bayramm/shared";
import type {
  ChecklistItem,
  LegalForm,
  ListingRef,
  RevealedPhone,
  VendorDetail,
  VendorList,
  VendorPhones,
  VendorUser,
} from "@bayramm/shared/api/staff";
import { type Context, Hono } from "hono";
import { sql } from "kysely";
import { phoneHash } from "../auth/crypto";
import { staffOf } from "../auth/session";
import { type Tx, withActor } from "../db/actor";
import {
  clearVendorUserTelegram,
  insertVendorUserProfile,
  readVendorContactPhones,
  readVendorUserPhone,
  saveVendorContacts,
  updateVendorUserProfile,
  vendorContactsAs,
  vendorUserProfilesAs,
} from "../db/pii";
import type { AppVendorAccounts, PiiVendorContacts } from "../db/schema.generated";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { requirePermission } from "./access";
import { type Body, Input, invalidInput, likePattern, limitJson, paging, readBody } from "./input";
import { iso, LISTING_STATUSES, listingBriefs, pathId, staffName } from "./shared";

export const vendors = new Hono<AppEnv>();

const LEGAL_FORMS = ["ooo", "yatt", "self_employed"] as const satisfies readonly LegalForm[];
const LOCALES = ["ru", "uz"] as const;
const USER_ROLES = ["owner", "member"] as const;
const STIR_RE = /^\d{9}$/;
const TELEGRAM_USERNAME_RE = /^@?[A-Za-z0-9_]{5,32}$/;

// ── чек-лист проверки вендора ───────────────────────────────────────────────
// Все четыре пункта нужны для публикации (app.listing_publish_blockers)
export const CHECKLIST_ITEMS = [
  "contract",
  "stir",
  "contacts",
  "pdConsent",
] as const satisfies readonly ChecklistItem[];

const CHECKLIST_COLUMNS = {
  contract: { at: "contract_signed_at", by: "contract_checked_by" },
  stir: { at: "stir_verified_at", by: "stir_verified_by" },
  contacts: { at: "contacts_confirmed_at", by: "contacts_confirmed_by" },
  pdConsent: { at: "pd_consent_signed_at", by: "pd_consent_checked_by" },
} as const satisfies Record<ChecklistItem, { at: keyof AppVendorAccounts; by: keyof AppVendorAccounts }>;

// ── разбор тела ─────────────────────────────────────────────────────────────

interface AccountFields {
  name?: string | null;
  legal_form?: LegalForm | null;
  contract_no?: string | null;
  manager_id?: string | null;
}

type ContactFields = Partial<
  Pick<
    PiiVendorContacts,
    | "legal_name"
    | "stir"
    | "legal_address"
    | "contact_person"
    | "contact_role"
    | "phone"
    | "phone_alt"
    | "telegram_username"
  >
>;

/** Только заданные поля: undefined — «не менять» */
export function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function parseVendor(body: Body, creating: boolean): { account: AccountFields; contacts: ContactFields } {
  const input = new Input(body);
  const name = input.text("name", { min: 2, max: 120, required: creating });
  // Название обязательно: у существующего вендора его можно сменить, но не стереть
  if (name === null) input.fail("name");
  const username = input.pattern("telegramUsername", TELEGRAM_USERNAME_RE);
  const account = definedOnly<AccountFields>({
    name,
    legal_form: input.oneOf("legalForm", LEGAL_FORMS),
    contract_no: input.text("contractNo", { max: 64 }),
    manager_id: input.uuid("managerId"),
  });
  const contacts = definedOnly<ContactFields>({
    legal_name: input.text("legalName", { max: 200 }),
    stir: input.pattern("stir", STIR_RE),
    legal_address: input.text("legalAddress", { max: 300 }),
    contact_person: input.text("contactPerson", { max: 120 }),
    contact_role: input.text("contactRole", { max: 80 }),
    phone: input.phone("phone"),
    phone_alt: input.phone("phoneAlt"),
    telegram_username: typeof username === "string" ? username.replace(/^@/, "") : username,
  });
  input.done();
  return { account, contacts };
}

// Менеджер — действующий сотрудник; иначе внешний ключ дал бы непонятный 404
async function assertManager(trx: Tx, managerId: string | null | undefined): Promise<void> {
  if (managerId === undefined || managerId === null) return;
  const found = await trx
    .selectFrom("app.staff")
    .select("id")
    .where("id", "=", managerId)
    .where("active", "=", true)
    .executeTakeFirst();
  if (!found) throw invalidInput(["managerId"]);
}

// ── чтение ──────────────────────────────────────────────────────────────────

export async function loadVendor(trx: Tx, id: string): Promise<VendorDetail> {
  const row = await trx
    .selectFrom("app.vendor_accounts as v")
    .leftJoin(vendorContactsAs("vc"), "vc.vendor_id", "v.id")
    .select([
      "v.id",
      "v.public_code",
      "v.name",
      "v.legal_form",
      "v.contract_no",
      "v.manager_id",
      "v.created_at",
      "v.updated_at",
      "v.contract_signed_at",
      "v.stir_verified_at",
      "v.contacts_confirmed_at",
      "v.pd_consent_signed_at",
      staffName("v.manager_id").as("manager_name"),
      staffName("v.contract_checked_by").as("contract_by"),
      staffName("v.stir_verified_by").as("stir_by"),
      staffName("v.contacts_confirmed_by").as("contacts_by"),
      staffName("v.pd_consent_checked_by").as("pd_consent_by"),
      "vc.legal_name",
      "vc.stir",
      "vc.legal_address",
      "vc.contact_person",
      "vc.contact_role",
      "vc.telegram_username",
    ])
    .where("v.id", "=", id)
    .executeTakeFirst();
  if (row === undefined) throw notFound();

  const users = await selectUsers(trx).where("u.vendor_id", "=", id).orderBy("u.created_at").execute();
  const listings = await listingBriefs(trx, id);

  const check = (at: Date | null, by: string | null) => ({ done: at !== null, at: iso(at), by });
  return {
    id: row.id,
    code: row.public_code,
    name: row.name,
    legalForm: row.legal_form,
    contractNo: row.contract_no,
    manager: row.manager_id ? { id: row.manager_id, name: row.manager_name } : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    contacts: {
      legalName: row.legal_name,
      stir: row.stir,
      legalAddress: row.legal_address,
      contactPerson: row.contact_person,
      contactRole: row.contact_role,
      telegramUsername: row.telegram_username,
    },
    checklist: {
      contract: check(row.contract_signed_at, row.contract_by),
      stir: check(row.stir_verified_at, row.stir_by),
      contacts: check(row.contacts_confirmed_at, row.contacts_by),
      pdConsent: check(row.pd_consent_signed_at, row.pd_consent_by),
    },
    users: users.map(userView),
    listings,
  };
}

const selectUsers = (trx: Tx) =>
  trx
    .selectFrom("app.vendor_users as u")
    .leftJoin(vendorUserProfilesAs("p"), "p.vendor_user_id", "u.id")
    .select([
      "u.id",
      "u.role",
      "u.locale",
      "u.tg_linked_at",
      sql<boolean>`u.account_id is not null`.as("account_linked"),
      "u.last_login_at",
      "u.disabled_at",
      "u.created_at",
      "p.full_name",
    ]);

type UserRow = Awaited<ReturnType<ReturnType<typeof selectUsers>["executeTakeFirstOrThrow"]>>;

// Telegram ID и хэши наружу не отдаём: только факт привязки
function userView(row: UserRow): VendorUser {
  return {
    id: row.id,
    fullName: row.full_name,
    role: row.role === "member" ? "member" : "owner",
    locale: row.locale,
    telegramLinked: row.tg_linked_at !== null,
    telegramLinkedAt: iso(row.tg_linked_at),
    accountLinked: row.account_linked,
    lastLoginAt: iso(row.last_login_at),
    disabledAt: iso(row.disabled_at),
    createdAt: iso(row.created_at),
  };
}

// ── список ──────────────────────────────────────────────────────────────────

vendors.get("/", requirePermission("catalog.read"), async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const statusParam = c.req.query("listingStatus");
  const status = LISTING_STATUSES.find((s) => s === statusParam);
  const { limit, offset } = paging((key) => c.req.query(key));

  // Телефон ищется по псевдониму — тому же HMAC, что у пользователей кабинета
  const phone = q.replace(/\D/g, "").length >= 9 ? normalizeUzPhone(q) : null;
  const hash = phone ? await phoneHash(c.env.ID_HASH_KEY, phone) : null;
  const stir = STIR_RE.test(q) ? q : null;

  const rows = await withActor(c.var.db, staffOf(c), (trx) => {
    let query = trx
      .selectFrom("app.vendor_accounts as v")
      .leftJoin(vendorContactsAs("vc"), "vc.vendor_id", "v.id")
      .select([
        "v.id",
        "v.public_code",
        "v.name",
        "v.legal_form",
        "v.created_at",
        "v.contract_signed_at",
        "v.stir_verified_at",
        "v.contacts_confirmed_at",
        "v.pd_consent_signed_at",
        "vc.legal_name",
        "vc.contact_person",
        staffName("v.manager_id").as("manager_name"),
        sql<ListingRef[]>`coalesce((
          select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'status', l.status) order by l.created_at)
          from app.listings l where l.vendor_id = v.id), '[]'::jsonb)`.as("listings"),
        sql<number>`(select count(*)::int from app.vendor_users u
                     where u.vendor_id = v.id and u.disabled_at is null)`.as("users"),
        sql<number>`(select count(*)::int from app.vendor_users u
                     where u.vendor_id = v.id and u.disabled_at is null and u.tg_linked_at is not null)`.as(
          "linked_users",
        ),
        sql<number>`(count(*) over ())::int`.as("total"),
      ]);
    if (q !== "") {
      const pattern = likePattern(q);
      query = query.where((eb) =>
        eb.or([
          eb("v.name", "ilike", pattern),
          eb("v.public_code", "ilike", pattern),
          eb("vc.legal_name", "ilike", pattern),
          eb("vc.contact_person", "ilike", pattern),
          eb.exists(
            eb
              .selectFrom("app.listings as l")
              .select("l.id")
              .whereRef("l.vendor_id", "=", "v.id")
              .where((w) => w.or([w("l.name", "ilike", pattern), w("l.slug", "ilike", pattern)])),
          ),
          ...(stir ? [eb("vc.stir", "=", stir)] : []),
          ...(hash
            ? [
                eb.exists(
                  eb
                    .selectFrom("app.vendor_users as u")
                    .select("u.id")
                    .whereRef("u.vendor_id", "=", "v.id")
                    .where("u.phone_hash", "=", hash),
                ),
              ]
            : []),
        ]),
      );
    }
    if (status) {
      query = query.where((eb) =>
        eb.exists(
          eb
            .selectFrom("app.listings as l")
            .select("l.id")
            .whereRef("l.vendor_id", "=", "v.id")
            .where("l.status", "=", status),
        ),
      );
    }
    return query.orderBy("v.created_at", "desc").orderBy("v.id").limit(limit).offset(offset).execute();
  });

  const body: VendorList = {
    total: rows[0]?.total ?? 0,
    items: rows.map((row) => ({
      id: row.id,
      code: row.public_code,
      name: row.name,
      legalForm: row.legal_form,
      legalName: row.legal_name,
      contactPerson: row.contact_person,
      managerName: row.manager_name,
      createdAt: iso(row.created_at),
      checklist: {
        contract: row.contract_signed_at !== null,
        stir: row.stir_verified_at !== null,
        contacts: row.contacts_confirmed_at !== null,
        pdConsent: row.pd_consent_signed_at !== null,
      },
      listings: row.listings,
      users: row.users,
      linkedUsers: row.linked_users,
    })),
  };
  return c.json(body);
});

// ── создать, прочитать, изменить ────────────────────────────────────────────

vendors.post("/", requirePermission("vendors.write"), limitJson, async (c) => {
  const { account, contacts } = parseVendor(await readBody(c.req.raw), true);
  const vendor = await withActor(c.var.db, staffOf(c), async (trx) => {
    await assertManager(trx, account.manager_id);
    const created = await trx
      .insertInto("app.vendor_accounts")
      .values(account)
      .returning("id")
      .executeTakeFirstOrThrow();
    await saveVendorContacts(trx, created.id, contacts);
    return loadVendor(trx, created.id);
  });
  return c.json(vendor, 201);
});

vendors.get("/:id", requirePermission("catalog.read"), async (c) => {
  const id = pathId(c.req.param("id"));
  return c.json(await withActor(c.var.db, staffOf(c), (trx) => loadVendor(trx, id)));
});

vendors.patch("/:id", requirePermission("vendors.write"), limitJson, async (c) => {
  const id = pathId(c.req.param("id"));
  const { account, contacts } = parseVendor(await readBody(c.req.raw), false);
  const vendor = await withActor(c.var.db, staffOf(c), async (trx) => {
    await assertManager(trx, account.manager_id);
    if (Object.keys(account).length > 0) {
      const updated = await trx
        .updateTable("app.vendor_accounts")
        .set(account)
        .where("id", "=", id)
        .returning("id")
        .executeTakeFirst();
      if (!updated) throw notFound();
    } else {
      // Есть ли вендор: иначе контакты упали бы на внешнем ключе
      await loadVendor(trx, id);
    }
    await saveVendorContacts(trx, id, contacts);
    return loadVendor(trx, id);
  });
  return c.json(vendor);
});

// ── чек-лист проверки ───────────────────────────────────────────────────────

vendors.post("/:id/checklist", requirePermission("vendors.write"), limitJson, async (c) => {
  const actor = staffOf(c);
  const id = pathId(c.req.param("id"));
  const input = new Input(await readBody(c.req.raw));
  const item = input.oneOf("item", CHECKLIST_ITEMS, true);
  const done = input.bool("done", true);
  input.done();
  if (!item || done === undefined) throw invalidInput(["item", "done"]);

  const vendor = await withActor(c.var.db, actor, async (trx) => {
    const current = await trx
      .selectFrom("app.vendor_accounts as v")
      .leftJoin(vendorContactsAs("vc"), "vc.vendor_id", "v.id")
      .select(["v.id", "vc.stir"])
      .where("v.id", "=", id)
      .executeTakeFirst();
    if (current === undefined) throw notFound();

    // СТИР сверяют с реестром — отметить можно, только когда он вписан
    if (item === "stir" && done && current.stir === null) {
      throw new ApiError(409, "stir_missing", "Enter the STIR before marking it verified");
    }

    const columns = CHECKLIST_COLUMNS[item];
    const set: Record<string, unknown> = done
      ? { [columns.at]: sql`coalesce(${sql.ref(columns.at)}, now())`, [columns.by]: actor.id }
      : { [columns.at]: null, [columns.by]: null };

    // Согласие ПДн подписано по действующему тексту цели vendor_contact: его версия
    // и юрлицо оператора остаются в pd_consent_text_id
    if (item === "pdConsent") {
      if (done) {
        const text = await trx
          .selectFrom("app.consent_texts")
          .select("id")
          .where("purpose", "=", "vendor_contact")
          .where("published_at", "<=", sql<Date>`now()`)
          .where((eb) => eb.or([eb("retired_at", "is", null), eb("retired_at", ">", sql<Date>`now()`)]))
          .orderBy("version", "desc")
          .orderBy(sql`locale = 'ru'`, "desc")
          .limit(1)
          .executeTakeFirst();
        if (!text) {
          throw new ApiError(409, "consent_text_missing", "No current consent text for vendor contacts");
        }
        set.pd_consent_text_id = text.id;
      } else {
        set.pd_consent_text_id = null;
      }
    }

    await trx.updateTable("app.vendor_accounts").set(set).where("id", "=", id).execute();
    return loadVendor(trx, id);
  });
  return c.json(vendor);
});

// ── телефоны контактного лица (чтение — в журнал доступа к ПДн) ─────────────

/** Тело { reason? } запроса «показать телефон»; пустое тело — без причины */
export async function readReason(request: Request, required = false): Promise<string | null> {
  const text = await request.text();
  let body: unknown = {};
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(400, "invalid_request", "Body must be JSON");
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "Body must be a JSON object");
  }
  const input = new Input(body as Body);
  const reason = input.text("reason", { max: 500, required });
  input.done();
  return reason ?? null;
}

export async function readVendorPhones(
  trx: Tx,
  vendorId: string,
  reason: string | null,
): Promise<VendorPhones> {
  return readVendorContactPhones(trx, vendorId, reason);
}

vendors.post("/:id/phones", requirePermission("vendor_phones.read"), limitJson, async (c) => {
  const id = pathId(c.req.param("id"));
  const reason = await readReason(c.req.raw);
  const phones = await withActor(c.var.db, staffOf(c), async (trx) => {
    await loadVendor(trx, id);
    return readVendorPhones(trx, id, reason);
  });
  return c.json(phones);
});

// ── пользователи кабинета ───────────────────────────────────────────────────
// Сотрудник заводит пользователя по телефону; привязку к Telegram делает бот,
// когда вендор поделится своим контактом (тот же номер → тот же phone_hash)

async function loadUser(trx: Tx, vendor: string, user: string): Promise<VendorUser> {
  const row = await selectUsers(trx)
    .where("u.id", "=", user)
    .where("u.vendor_id", "=", vendor)
    .executeTakeFirst();
  if (row === undefined) throw notFound();
  return userView(row);
}

function userIds(c: Context<AppEnv>) {
  return { vendor: pathId(c.req.param("id")), user: pathId(c.req.param("userId")) };
}

vendors.post("/:id/users", requirePermission("vendor_users.write"), limitJson, async (c) => {
  const id = pathId(c.req.param("id"));
  const input = new Input(await readBody(c.req.raw));
  const phone = input.phone("phone", true);
  const fullName = input.text("fullName", { max: 120 });
  const role = input.oneOf("role", USER_ROLES) ?? "owner";
  const locale = input.oneOf("locale", LOCALES) ?? undefined;
  input.done();
  if (typeof phone !== "string") throw invalidInput(["phone"]);

  const hash = await phoneHash(c.env.ID_HASH_KEY, phone);
  const user = await withActor(c.var.db, staffOf(c), async (trx) => {
    const created = await trx
      .insertInto("app.vendor_users")
      .values({ vendor_id: id, phone_hash: hash, role, ...(locale ? { locale } : {}) })
      .returning("id")
      .executeTakeFirstOrThrow();
    await insertVendorUserProfile(trx, created.id, phone, fullName ?? null);
    return loadUser(trx, id, created.id);
  });
  return c.json(user, 201);
});

vendors.patch("/:id/users/:userId", requirePermission("vendor_users.write"), limitJson, async (c) => {
  const ids = userIds(c);
  const input = new Input(await readBody(c.req.raw));
  const phone = input.phone("phone");
  const fullName = input.text("fullName", { max: 120 });
  const role = input.oneOf("role", USER_ROLES);
  const locale = input.oneOf("locale", LOCALES);
  if (phone === null) input.fail("phone");
  if (role === null) input.fail("role");
  if (locale === null) input.fail("locale");
  input.done();

  const hash = typeof phone === "string" ? await phoneHash(c.env.ID_HASH_KEY, phone) : undefined;
  const user = await withActor(c.var.db, staffOf(c), async (trx) => {
    const current = await loadUser(trx, ids.vendor, ids.user);
    // Привязанный пользователь входит по своему номеру: сменить его — значит отвязать.
    // Для этого — отвязать или отключить и завести нового
    if (hash && (current.telegramLinked || current.accountLinked)) {
      throw new ApiError(409, "user_linked", "Phone of a Telegram-linked user cannot be changed");
    }
    const account = definedOnly({ phone_hash: hash, role: role ?? undefined, locale: locale ?? undefined });
    if (Object.keys(account).length > 0) {
      await trx.updateTable("app.vendor_users").set(account).where("id", "=", ids.user).execute();
    }
    const profile = definedOnly({ phone: phone ?? undefined, full_name: fullName });
    if (Object.keys(profile).length > 0) {
      await updateVendorUserProfile(trx, ids.user, profile);
    }
    return loadUser(trx, ids.vendor, ids.user);
  });
  return c.json(user);
});

async function setDisabled(trx: Tx, vendor: string, user: string, disabled: boolean): Promise<VendorUser> {
  await loadUser(trx, vendor, user);
  await trx
    .updateTable("app.vendor_users")
    .set({ disabled_at: disabled ? sql<Date>`coalesce(disabled_at, now())` : null })
    .where("id", "=", user)
    .execute();
  if (disabled) {
    // Отключение действует сразу: открытые сессии кабинета отзываются
    await trx
      .updateTable("app.sessions")
      .set({ revoked_at: sql<Date>`now()` })
      .where("vendor_user_id", "=", user)
      .where("revoked_at", "is", null)
      .execute();
  }
  return loadUser(trx, vendor, user);
}

vendors.post("/:id/users/:userId/disable", requirePermission("vendor_users.write"), async (c) => {
  const ids = userIds(c);
  return c.json(await withActor(c.var.db, staffOf(c), (trx) => setDisabled(trx, ids.vendor, ids.user, true)));
});

vendors.post("/:id/users/:userId/enable", requirePermission("vendor_users.write"), async (c) => {
  const ids = userIds(c);
  return c.json(
    await withActor(c.var.db, staffOf(c), (trx) => setDisabled(trx, ids.vendor, ids.user, false)),
  );
});

// Отвязать: вендор сменил аккаунт, Telegram или номер. Пользователь вендора отвязывается
// от аккаунта партнёра (доступ в кабинет пропадает со следующим запросом), хэш и время
// привязки Telegram снимаются вместе (ограничение базы), Telegram ID и чат — из профиля;
// старые сессии кабинета отзываются. Привязать заново вендор может сам — снова доказав
// номер: контактом в боте или кодом из сообщения
vendors.post("/:id/users/:userId/unlink", requirePermission("vendor_users.write"), async (c) => {
  const ids = userIds(c);
  const user = await withActor(c.var.db, staffOf(c), async (trx) => {
    await loadUser(trx, ids.vendor, ids.user);
    await trx
      .updateTable("app.vendor_users")
      .set({ account_id: null, tg_user_hash: null, tg_linked_at: null })
      .where("id", "=", ids.user)
      .execute();
    await clearVendorUserTelegram(trx, ids.user);
    await trx
      .updateTable("app.sessions")
      .set({ revoked_at: sql<Date>`now()` })
      .where("vendor_user_id", "=", ids.user)
      .where("revoked_at", "is", null)
      .execute();
    return loadUser(trx, ids.vendor, ids.user);
  });
  return c.json(user);
});

vendors.post("/:id/users/:userId/phone", requirePermission("vendor_phones.read"), limitJson, async (c) => {
  const ids = userIds(c);
  const reason = await readReason(c.req.raw);
  const body: RevealedPhone = await withActor(c.var.db, staffOf(c), async (trx) => {
    await loadUser(trx, ids.vendor, ids.user);
    return { phone: await readVendorUserPhone(trx, ids.user, reason) };
  });
  return c.json(body);
});
