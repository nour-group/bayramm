// Кабинет вендора целиком, без базы: всё, что отсекается до первого запроса к
// Postgres. С базой (изоляция вендоров, переходы, согласие) — test/integration/vendor.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { initDataFor } from "../testing/init-data";
import { call } from "../testing/worker";

afterEach(() => vi.restoreAllMocks());

const ID = "eeeeeeee-0000-0000-0000-0000000000a1";

describe("/vendor без сессии кабинета", () => {
  it.each([
    ["GET", "/vendor/me"],
    ["PATCH", "/vendor/me"],
    ["GET", "/vendor/requests"],
    ["GET", `/vendor/requests/${ID}`],
    ["PATCH", `/vendor/requests/${ID}`],
    ["POST", `/vendor/requests/${ID}/call`],
    ["GET", `/vendor/listings/${ID}`],
    ["GET", `/vendor/listings/${ID}/calendar`],
    ["PUT", `/vendor/listings/${ID}/calendar/2026-10-05`],
    ["DELETE", `/vendor/listings/${ID}/calendar/2026-10-05`],
  ])("%s %s без токена — 401", async (method, path) => {
    const { res } = await call(path, { method });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Authentication required" } });
  });

  it("кривой токен — 401 без запроса к базе", async () => {
    const { res } = await call("/vendor/requests", { headers: { Authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/vendor/telegram: отказ до базы", () => {
  const login = (body: unknown) =>
    call("/auth/vendor/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("тело не JSON или без initData — 400", async () => {
    for (const body of ["not json", {}, { initData: "" }, { initData: 42 }]) {
      const { res } = await login(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("слишком большое тело — 413", async () => {
    const { res } = await login({ initData: "x".repeat(40 * 1024) });
    expect(res.status).toBe(413);
  });

  it("подпись чужого бота — 401", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const initData = await initDataFor(
      { id: 100000001, first_name: "Vendor" },
      { botToken: "999:other-bot" },
    );
    const { res } = await login({ initData });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "Invalid Telegram init data" },
    });
    expect(warn).toHaveBeenCalledWith("auth: initData rejected", "bad_hash");
  });
});
