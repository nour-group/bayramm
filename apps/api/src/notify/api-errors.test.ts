// Ответы 5xx → счётчик в базе после ответа: без базы (порт 1) — только в лог, запрос не страдает;
// в базу уходит только метод и шаблон маршрута
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { AppEnv } from "../env";
import { handleError } from "../errors";
import { BOT_TOKEN, makeCtx, makeEnv } from "../testing/worker";
import { reportApiError, routeLabel } from "./api-errors";

let warn: MockInstance;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function appWith(onError = true) {
  const app = new Hono<AppEnv>();
  app.get("/staff/requests/:id", () => {
    throw new Error("boom 998001234567");
  });
  app.get("/fine/:id", (c) => c.json({ ok: true }));
  app.get("/gone/:id", (c) => c.json({ error: "no" }, 404));
  app.onError((err, c) => {
    const res = handleError(err, c);
    if (onError && res.status >= 500) reportApiError(c);
    return res;
  });
  return app;
}

describe("routeLabel", () => {
  it("метод и шаблон маршрута; не ASCII и пробелы — «?»; пусто — «*»", () => {
    expect(routeLabel("GET", "/staff/requests/:id")).toBe("GET /staff/requests/:id");
    expect(routeLabel("POST", "/a b/Иван")).toBe("POST /a?b/????");
    expect(routeLabel("get", "")).toBe("OTHER *");
    expect(routeLabel("DELETE", "x".repeat(500)).length).toBe("DELETE ".length + 190);
  });
});

describe("reportApiError", () => {
  it("500 — ответ сразу, счётчик в waitUntil; база недоступна — предупреждение без значений и секретов", async () => {
    const { ctx, pending } = makeCtx();
    const env = makeEnv();
    const res = await appWith().request("/staff/requests/42", {}, env, ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal_error", message: "Internal error" } });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("api error: not recorded");
    expect(logged).toContain("GET /staff/requests/:id");
    for (const secret of ["42", "998001234567", BOT_TOKEN, env.ID_HASH_KEY, "nothing"])
      expect(logged).not.toContain(secret);
  });

  it("2xx и 4xx — ничего не пишется", async () => {
    for (const path of ["/fine/1", "/gone/1"]) {
      const { ctx, pending } = makeCtx();
      await appWith().request(path, {}, makeEnv(), ctx);
      expect(pending, path).toHaveLength(0);
    }
  });

  it("без базы или без контекста запроса — ничего, ответ как обычно", async () => {
    const { ctx, pending } = makeCtx();
    const noDb = await appWith().request(
      "/staff/requests/1",
      {},
      makeEnv({ HYPERDRIVE: undefined as unknown as Hyperdrive }),
      ctx,
    );
    expect(noDb.status).toBe(500);
    expect(pending).toHaveLength(0);
    const noCtx = await appWith().request("/staff/requests/1", {}, makeEnv());
    expect(noCtx.status).toBe(500);
  });
});
