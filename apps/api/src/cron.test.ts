// Cron и немедленная отправка без базы: база недоступна — шаги не роняют воркер
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { runCron } from "./cron";
import type { AppEnv } from "./env";
import worker from "./index";
import { outboxKick } from "./notify/kick";
import { BOT_TOKEN, makeCtx, makeEnv } from "./testing/worker";

let errors: MockInstance;

beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("в Telegram не ходим");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cron", () => {
  it("воркер экспортирует scheduled рядом с fetch", () => {
    expect(typeof worker.fetch).toBe("function");
    expect(typeof worker.scheduled).toBe("function");
  });

  it("база недоступна — каждый шаг в лог, воркер не падает, в логе нет секретов", async () => {
    const env = makeEnv();
    await expect(runCron(env)).resolves.toBe(false);
    const logged = JSON.stringify(errors.mock.calls);
    for (const step of ["sla", "outbox", "telegram_updates"])
      expect(logged).toContain(`cron: ${step} failed`);
    for (const secret of [BOT_TOKEN, env.ID_HASH_KEY, "nothing"]) expect(logged).not.toContain(secret);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("outboxKick", () => {
  const app = new Hono<AppEnv>();
  app.post("/ok", outboxKick, (c) => c.json({ ok: true }, 201));
  app.post("/bad", outboxKick, (c) => c.json({ error: "no" }, 409));

  it("после успешного ответа — один проход отправителя в waitUntil; ошибка — только в лог", async () => {
    const { ctx, pending } = makeCtx();
    const res = await app.request("/ok", { method: "POST" }, makeEnv(), ctx);
    expect(res.status).toBe(201);
    expect(pending).toHaveLength(1);
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });

  it("ответ с ошибкой — не запускается", async () => {
    const { ctx, pending } = makeCtx();
    const res = await app.request("/bad", { method: "POST" }, makeEnv(), ctx);
    expect(res.status).toBe(409);
    expect(pending).toHaveLength(0);
  });
});
