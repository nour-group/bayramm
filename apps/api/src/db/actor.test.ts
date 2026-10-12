import { describe, expect, it } from "vitest";
import { fakeDb } from "../testing/fake-db";
import {
  type Actor,
  actorSettings,
  closePreamble,
  continueAs,
  continueAsSystem,
  GUEST,
  inPreamble,
  SYSTEM,
  withActor,
} from "./actor";

const CLIENT_ID = "cccccccc-0000-0000-0000-000000000001";
const VENDOR_USER_ID = "aaaaaaaa-0000-0000-0000-000000000011";
const VENDOR_ID = "aaaaaaaa-0000-0000-0000-000000000001";

describe("actorSettings", () => {
  it("значения GUC для каждого вида актора", () => {
    expect(actorSettings(GUEST)).toEqual({ kind: "", id: "", vendorId: "" });
    expect(actorSettings(SYSTEM)).toEqual({ kind: "system", id: "", vendorId: "" });
    expect(actorSettings({ kind: "account", id: CLIENT_ID })).toEqual({
      kind: "account",
      id: CLIENT_ID,
      vendorId: "",
    });
    expect(actorSettings({ kind: "client", id: CLIENT_ID })).toEqual({
      kind: "client",
      id: CLIENT_ID,
      vendorId: "",
    });
    expect(actorSettings({ kind: "staff", id: CLIENT_ID, role: "moderator" })).toEqual({
      kind: "staff",
      id: CLIENT_ID,
      vendorId: "",
    });
    expect(
      actorSettings({ kind: "vendor_user", id: VENDOR_USER_ID, vendorId: VENDOR_ID, role: "owner" }),
    ).toEqual({
      kind: "vendor_user",
      id: VENDOR_USER_ID,
      vendorId: VENDOR_ID,
    });
  });

  it("id не UUID — ошибка кода, до базы не доходит", () => {
    expect(() => actorSettings({ kind: "client", id: "1 or 1=1" })).toThrow(TypeError);
    expect(() => actorSettings({ kind: "client", id: "" })).toThrow(TypeError);
    expect(() =>
      actorSettings({ kind: "vendor_user", id: VENDOR_USER_ID, vendorId: "x", role: "owner" }),
    ).toThrow(TypeError);
  });
});

describe("withActor", () => {
  it("транзакция: begin → set_config(…, true) × 3 → запросы fn → commit", async () => {
    const fake = fakeDb();
    const result = await withActor(fake.db, { kind: "client", id: CLIENT_ID }, async (trx) => {
      await trx.selectFrom("app.clients").select("id").execute();
      return 42;
    });

    expect(result).toBe(42);
    expect(fake.log[0]).toBe("begin");
    expect(fake.log.at(-1)).toBe("commit");
    const [settings, query] = fake.queries;
    expect(settings?.sql).toMatch(/set_config\('app\.actor_kind', \$1, true\)/);
    expect(settings?.sql).toMatch(/set_config\('app\.actor_id', \$2, true\)/);
    expect(settings?.sql).toMatch(/set_config\('app\.vendor_id', \$3, true\)/);
    // значения — параметрами, не в тексте SQL
    expect(settings?.parameters).toEqual(["client", CLIENT_ID, ""]);
    expect(settings?.sql).not.toContain(CLIENT_ID);
    expect(query?.sql).toContain('from "app"."clients"');
  });

  it.each<[string, Actor, string[]]>([
    ["guest", GUEST, ["", "", ""]],
    ["system", SYSTEM, ["system", "", ""]],
    [
      "vendor_user",
      { kind: "vendor_user", id: VENDOR_USER_ID, vendorId: VENDOR_ID, role: "owner" },
      ["vendor_user", VENDOR_USER_ID, VENDOR_ID],
    ],
  ])("актор %s", async (_name, actor, params) => {
    const fake = fakeDb();
    await withActor(fake.db, actor, async () => undefined);
    expect(fake.queries[0]?.parameters).toEqual(params);
  });

  it("ошибка в fn откатывает транзакцию и летит дальше", async () => {
    const fake = fakeDb();
    const boom = new Error("boom");
    await expect(
      withActor(fake.db, SYSTEM, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(fake.log).toContain("rollback");
    expect(fake.log).not.toContain("commit");
  });

  it("кривой id — ошибка до открытия транзакции", async () => {
    const fake = fakeDb();
    await expect(withActor(fake.db, { kind: "client", id: "nope" }, async () => 1)).rejects.toThrow(
      TypeError,
    );
    expect(fake.log).toEqual([]);
  });
});

describe("continueAsSystem", () => {
  it("в той же транзакции переключает GUC на system — дальше запросы идут как system", async () => {
    const fake = fakeDb();
    const vendor: Actor = { kind: "vendor_user", id: VENDOR_USER_ID, vendorId: VENDOR_ID, role: "owner" };
    await withActor(fake.db, vendor, async (trx) => {
      await trx.selectFrom("app.photos").select("id").execute();
      await continueAsSystem(trx);
      await trx.selectFrom("app.photos").select("id").execute();
    });
    expect(fake.log.filter((entry) => entry === "begin")).toHaveLength(1);
    expect(fake.queries.map((q) => q.parameters)).toEqual([
      ["vendor_user", VENDOR_USER_ID, VENDOR_ID],
      [],
      ["system", "", ""],
      [],
    ]);
    expect(fake.log.at(-1)).toBe("commit");
  });
});

describe("continueAs: тот же актор повторно не выставляется", () => {
  it("второй continueAs тем же актором — без set_config; другим — с ним; и обратно — снова", async () => {
    const fake = fakeDb();
    const client: Actor = { kind: "client", id: CLIENT_ID };
    await withActor(fake.db, client, async (trx) => {
      await continueAs(trx, client);
      await continueAs(trx, SYSTEM);
      await continueAs(trx, SYSTEM);
      await continueAs(trx, client);
    });
    expect(fake.queries.map((q) => q.parameters)).toEqual([
      ["client", CLIENT_ID, ""],
      ["system", "", ""],
      ["client", CLIENT_ID, ""],
    ]);
  });

  it("новая транзакция начинает с пустого: set_config в ней выставляется всегда", async () => {
    const fake = fakeDb();
    const client: Actor = { kind: "client", id: CLIENT_ID };
    await withActor(fake.db, client, async () => undefined);
    await withActor(fake.db, client, async () => undefined);
    expect(fake.queries).toHaveLength(2);
  });
});

describe("транзакция преамбулы запроса", () => {
  const vendor: Actor = { kind: "vendor_user", id: VENDOR_USER_ID, vendorId: VENDOR_ID, role: "owner" };
  const sets = (fake: ReturnType<typeof fakeDb>) =>
    fake.queries.filter((q) => q.sql.includes("set_config")).map((q) => q.parameters);

  it("шаги преамбулы и первый withActor — одна транзакция; system выставляется один раз", async () => {
    const fake = fakeDb();
    await inPreamble(fake.db, async (trx) => trx.selectFrom("app.sessions").select("id").execute());
    await inPreamble(fake.db, async (trx) => trx.selectFrom("app.vendor_users").select("id").execute());
    // Пока обработчик не пришёл, транзакция открыта
    expect(fake.log).not.toContain("commit");
    await withActor(fake.db, vendor, async (trx) => trx.selectFrom("app.listings").select("id").execute());

    expect(fake.log.filter((e) => e === "begin")).toHaveLength(1);
    expect(fake.log.filter((e) => e === "commit")).toHaveLength(1);
    expect(fake.log.at(-1)).toBe("commit");
    expect(sets(fake)).toEqual([
      ["system", "", ""],
      ["vendor_user", VENDOR_USER_ID, VENDOR_ID],
    ]);
    // Запрос обработчика идёт только после set_config его актора
    expect(fake.queries.at(-2)?.parameters).toEqual(["vendor_user", VENDOR_USER_ID, VENDOR_ID]);
    expect(fake.queries.at(-1)?.sql).toContain('from "app"."listings"');
  });

  it("ошибка в обработчике откатывает всё, транзакцию никто больше не получит", async () => {
    const fake = fakeDb();
    await inPreamble(fake.db, async () => undefined);
    const boom = new Error("boom");
    await expect(
      withActor(fake.db, vendor, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(fake.log).toContain("rollback");
    expect(fake.log).not.toContain("commit");
    // Закрывать нечего, а следующий withActor — новая транзакция
    await closePreamble(fake.db);
    await withActor(fake.db, vendor, async () => undefined);
    expect(fake.log.filter((e) => e === "begin")).toHaveLength(2);
  });

  it("первый withActor забирает транзакцию; второй (в том числе параллельный) — своя", async () => {
    const fake = fakeDb();
    await inPreamble(fake.db, async () => undefined);
    await Promise.all([
      withActor(fake.db, vendor, async () => undefined),
      withActor(fake.db, vendor, async () => undefined),
    ]);
    expect(fake.log.filter((e) => e === "begin")).toHaveLength(2);
    expect(fake.log.filter((e) => e === "commit")).toHaveLength(2);
  });

  it("кривой id актора — ошибка до базы, ожидающая транзакция не тронута и закрывается", async () => {
    const fake = fakeDb();
    await inPreamble(fake.db, async () => undefined);
    await expect(withActor(fake.db, { kind: "client", id: "nope" }, async () => 1)).rejects.toThrow(
      TypeError,
    );
    expect(fake.log).not.toContain("rollback");
    await closePreamble(fake.db);
    expect(fake.log.at(-1)).toBe("commit");
  });

  it("closePreamble: никто не взял — фиксирует один раз; повтор и без преамбулы — ничего", async () => {
    const fake = fakeDb();
    await closePreamble(fake.db);
    expect(fake.log).toEqual([]);
    await inPreamble(fake.db, async () => undefined);
    await closePreamble(fake.db);
    await closePreamble(fake.db);
    expect(fake.log.filter((e) => e === "commit")).toHaveLength(1);
  });

  it("ошибка шага преамбулы откатывает её, следующий шаг открывает новую транзакцию", async () => {
    const fake = fakeDb();
    const boom = new Error("boom");
    await expect(
      inPreamble(fake.db, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(fake.log).toContain("rollback");
    await inPreamble(fake.db, async () => undefined);
    expect(fake.log.filter((e) => e === "begin")).toHaveLength(2);
    await closePreamble(fake.db);
  });

  it("у разных запросов (разные Db) преамбулы не смешиваются", async () => {
    const a = fakeDb();
    const b = fakeDb();
    await inPreamble(a.db, async () => undefined);
    await withActor(b.db, vendor, async () => undefined);
    // Транзакция a осталась открытой и не досталась обработчику b
    expect(b.log.filter((e) => e === "begin")).toHaveLength(1);
    expect(a.log).not.toContain("commit");
    await closePreamble(a.db);
    expect(a.log.at(-1)).toBe("commit");
  });
});
