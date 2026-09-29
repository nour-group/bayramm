// Слой базы на настоящем Postgres: роль API, withActor, RLS между клиентами,
// перевод ошибок базы в HTTP
import { sql } from "kysely";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUEST, SYSTEM, withActor } from "../../src/db/actor";
import { createDb, type Db } from "../../src/db/client";
import { toApiError } from "../../src/errors";
import {
  adminClient,
  apiDatabaseUrl,
  bearer,
  call,
  cleanup,
  loginToken,
  newTelegramUser,
  tgIdHash,
} from "./helpers";

let admin: Client;
let db: Db;
let a: { id: string; accountId: string; token: string; telegramId: number };
let b: { id: string; accountId: string; token: string; telegramId: number };

async function signUp() {
  const user = newTelegramUser();
  const token = await loginToken(user);
  const res = await call("/me", bearer(token));
  const { id, account } = (await res.json()) as { id: string; account: { id: string } };
  return { id, accountId: account.id, token, telegramId: user.id };
}

beforeAll(async () => {
  admin = await adminClient();
  db = createDb(apiDatabaseUrl);
  a = await signUp();
  b = await signUp();
});

afterAll(async () => {
  await db.destroy();
  await cleanup(admin);
  await admin.end();
});

async function dbError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error("ожидалась ошибка базы");
}

describe("подключение", () => {
  it("API работает ролью bayramm_api без BYPASSRLS", async () => {
    const row = await withActor(db, GUEST, async (trx) => {
      const { rows } = await sql<{ user: string; bypass: boolean; superuser: boolean }>`
        select current_user as user, rolbypassrls as bypass, rolsuper as superuser
        from pg_roles where rolname = current_user`.execute(trx);
      return rows[0];
    });
    expect(row).toEqual({ user: "bayramm_api", bypass: false, superuser: false });
  });

  it("актор живёт только в своей транзакции (set_config(..., true))", async () => {
    const inside = await withActor(db, { kind: "client", id: a.id }, async (trx) => {
      const { rows } = await sql<{ kind: string; id: string }>`
        select current_setting('app.actor_kind', true) as kind, current_setting('app.actor_id', true) as id`.execute(
        trx,
      );
      return rows[0];
    });
    expect(inside).toEqual({ kind: "client", id: a.id });

    // Пул в одно соединение — это то же соединение, но уже вне транзакции
    const { rows } = await sql<{ kind: string | null }>`
      select nullif(current_setting('app.actor_kind', true), '') as kind`.execute(db);
    expect(rows[0]?.kind).toBeNull();
  });
});

describe("RLS: клиент не видит и не меняет чужое", () => {
  it("app.clients и pii.client_profiles — только своя строка", async () => {
    const seen = await withActor(db, { kind: "client", id: a.id }, async (trx) => ({
      clients: await trx.selectFrom("app.clients").select("id").execute(),
      foreignProfile: await trx
        .selectFrom("pii.client_profiles")
        .select(["client_id", "first_name"])
        .where("client_id", "=", b.id)
        .execute(),
      foreignById: await trx.selectFrom("app.clients").select("id").where("id", "=", b.id).execute(),
    }));
    expect(seen.clients).toEqual([{ id: a.id }]);
    expect(seen.foreignProfile).toEqual([]);
    expect(seen.foreignById).toEqual([]);
  });

  it("app.sessions — только свои (аккаунт видит свои, клиент — ни одной сессии аккаунта)", async () => {
    const owners = await withActor(db, { kind: "account", id: a.accountId }, (trx) =>
      trx.selectFrom("app.sessions").select("account_id").execute(),
    );
    expect(owners.length).toBeGreaterThan(0);
    expect(new Set(owners.map((s) => s.account_id))).toEqual(new Set([a.accountId]));
    const asClient = await withActor(db, { kind: "client", id: a.id }, (trx) =>
      trx.selectFrom("app.sessions").select("id").execute(),
    );
    expect(asClient).toEqual([]);
  });

  it("аккаунт не видит чужой аккаунт, способы входа и профиль", async () => {
    const seen = await withActor(db, { kind: "account", id: a.accountId }, async (trx) => ({
      accounts: await trx.selectFrom("app.accounts").select("id").execute(),
      identities: await trx.selectFrom("app.account_identities").select("account_id").execute(),
    }));
    expect(seen.accounts).toEqual([{ id: a.accountId }]);
    expect(new Set(seen.identities.map((i) => i.account_id))).toEqual(new Set([a.accountId]));
  });

  it("чужие строки не обновляются", async () => {
    const result = await withActor(db, { kind: "client", id: a.id }, async (trx) => ({
      client: await trx
        .updateTable("app.clients")
        .set({ locale: "ru" })
        .where("id", "=", b.id)
        .executeTakeFirst(),
      sessions: await trx
        .updateTable("app.sessions")
        .set({ revoked_at: sql<Date>`now()` })
        .where("account_id", "=", b.accountId)
        .executeTakeFirst(),
    }));
    const asAccount = await withActor(db, { kind: "account", id: a.accountId }, (trx) =>
      trx
        .updateTable("app.sessions")
        .set({ revoked_at: sql<Date>`now()` })
        .where("account_id", "=", b.accountId)
        .executeTakeFirst(),
    );
    expect(asAccount.numUpdatedRows).toBe(0n);
    expect(result.client.numUpdatedRows).toBe(0n);
    expect(result.sessions.numUpdatedRows).toBe(0n);
    // сессия B жива
    expect((await call("/me", bearer(b.token))).status).toBe(200);
  });

  it("гость не видит ни клиентов, ни профилей, ни сессий", async () => {
    const seen = await withActor(db, GUEST, async (trx) => ({
      clients: await trx.selectFrom("app.clients").select("id").execute(),
      profiles: await trx.selectFrom("pii.client_profiles").select("client_id").execute(),
      sessions: await trx.selectFrom("app.sessions").select("id").execute(),
    }));
    expect(seen).toEqual({ clients: [], profiles: [], sessions: [] });
  });

  it("GET /me каждому — свой профиль", async () => {
    expect(((await (await call("/me", bearer(a.token))).json()) as { id: string }).id).toBe(a.id);
    expect(((await (await call("/me", bearer(b.token))).json()) as { id: string }).id).toBe(b.id);
  });
});

describe("ошибки базы → HTTP", () => {
  it("42501 (RLS WITH CHECK) → 404: чужой объект не подтверждается", async () => {
    const err = await dbError(() =>
      withActor(db, { kind: "client", id: a.id }, (trx) =>
        trx
          .insertInto("app.sessions")
          .values({
            token_hash: new Uint8Array(32),
            account_id: b.accountId,
            via: "tg_webapp",
            app: "web",
            proof_at: sql<Date>`now()`,
            expires_at: sql<Date>`now() + interval '1 day'`,
          })
          .execute(),
      ),
    );
    expect(err).toMatchObject({ code: "42501" });
    expect(toApiError(err)).toMatchObject({ status: 404, code: "not_found" });
  });

  it("23505 → 409 conflict", async () => {
    const err = await dbError(() =>
      withActor(db, SYSTEM, (trx) =>
        trx
          .insertInto("app.clients")
          .values({ account_id: b.accountId, tg_id_hash: tgIdHash(a.telegramId) })
          .execute(),
      ),
    );
    expect(err).toMatchObject({ code: "23505" });
    expect(toApiError(err)).toMatchObject({ status: 409, code: "conflict" });
  });

  it("BR003 из триггера → 403 forbidden_for_actor (клиент не снимает и не ставит блокировку)", async () => {
    const err = await dbError(() =>
      withActor(db, { kind: "client", id: a.id }, (trx) =>
        trx
          .updateTable("app.clients")
          .set({ blocked_at: sql<Date>`now()`, blocked_reason: "self" })
          .where("id", "=", a.id)
          .execute(),
      ),
    );
    expect(err).toMatchObject({ code: "BR003" });
    expect(toApiError(err)).toMatchObject({ status: 403, code: "forbidden_for_actor" });
  });

  it("check-ограничение → 422 invalid_input", async () => {
    const err = await dbError(() =>
      withActor(db, SYSTEM, (trx) =>
        trx
          .insertInto("app.clients")
          .values({ account_id: a.accountId, tg_id_hash: new Uint8Array(3) })
          .execute(),
      ),
    );
    expect(err).toMatchObject({ code: "23514" });
    expect(toApiError(err)).toMatchObject({ status: 422, code: "invalid_input" });
  });
});
