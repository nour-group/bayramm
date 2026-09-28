import { describe, expect, it } from "vitest";
import { fakeDb } from "../testing/fake-db";
import { type Actor, actorSettings, continueAsSystem, GUEST, SYSTEM, withActor } from "./actor";

const CLIENT_ID = "cccccccc-0000-0000-0000-000000000001";
const VENDOR_USER_ID = "aaaaaaaa-0000-0000-0000-000000000011";
const VENDOR_ID = "aaaaaaaa-0000-0000-0000-000000000001";

describe("actorSettings", () => {
  it("значения GUC для каждого вида актора", () => {
    expect(actorSettings(GUEST)).toEqual({ kind: "", id: "", vendorId: "" });
    expect(actorSettings(SYSTEM)).toEqual({ kind: "system", id: "", vendorId: "" });
    expect(actorSettings({ kind: "client", id: CLIENT_ID })).toEqual({
      kind: "client",
      id: CLIENT_ID,
      vendorId: "",
    });
    expect(actorSettings({ kind: "staff", id: CLIENT_ID })).toEqual({
      kind: "staff",
      id: CLIENT_ID,
      vendorId: "",
    });
    expect(actorSettings({ kind: "vendor_user", id: VENDOR_USER_ID, vendorId: VENDOR_ID })).toEqual({
      kind: "vendor_user",
      id: VENDOR_USER_ID,
      vendorId: VENDOR_ID,
    });
  });

  it("id не UUID — ошибка кода, до базы не доходит", () => {
    expect(() => actorSettings({ kind: "client", id: "1 or 1=1" })).toThrow(TypeError);
    expect(() => actorSettings({ kind: "client", id: "" })).toThrow(TypeError);
    expect(() => actorSettings({ kind: "vendor_user", id: VENDOR_USER_ID, vendorId: "x" })).toThrow(
      TypeError,
    );
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
      { kind: "vendor_user", id: VENDOR_USER_ID, vendorId: VENDOR_ID },
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
    const vendor: Actor = { kind: "vendor_user", id: VENDOR_USER_ID, vendorId: VENDOR_ID };
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
