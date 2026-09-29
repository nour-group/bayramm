// Ограничение частоты: без базы, с поддельными привязками Rate Limiting
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "./db/actor";
import type { AppEnv } from "./env";
import { handleError } from "./errors";
import { limitByActor, RATE_LIMIT_PERIOD_SECONDS } from "./ratelimit";
import { allowAllLimiter, call, makeCtx, makeEnv } from "./testing/worker";

afterEach(() => vi.restoreAllMocks());

/** Привязка, которая отказывает всем; ключи — в calls */
function denyAllLimiter(): RateLimit & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async limit({ key }) {
      calls.push(key);
      return { success: false };
    },
  };
}

const post = (headers: Record<string, string> = {}) =>
  ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  }) as RequestInit;

describe("POST /auth/*: лимит по IP", () => {
  it("превышение — 429 с Retry-After и стабильным кодом, до обработчика и базы", async () => {
    const limiter = denyAllLimiter();
    const { res, pending } = await call(
      "/auth/telegram",
      post({ "CF-Connecting-IP": "203.0.113.7" }),
      makeEnv({ RATE_LIMIT_AUTH_IP: limiter }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(RATE_LIMIT_PERIOD_SECONDS));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: { code: "rate_limited", message: "Too many requests" } });
    expect(limiter.calls).toHaveLength(1);
    // пул базы не открывался
    expect(pending).toHaveLength(0);
  });

  it("ключ — HMAC от IP: адреса в нём нет, один IP — один ключ, разные — разные", async () => {
    const limiter = allowAllLimiter();
    const env = makeEnv({ RATE_LIMIT_AUTH_IP: limiter });
    for (const ip of ["203.0.113.7", "203.0.113.7", "2001:db8::1"]) {
      await call("/auth/telegram", post({ "CF-Connecting-IP": ip }), env);
    }
    const [a, b, c] = limiter.calls;
    expect(a).toMatch(/^ip:[A-Za-z0-9_-]{43}$/);
    expect(a).not.toContain("203.0.113.7");
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it("лимит не исчерпан — запрос доходит до обработчика", async () => {
    const limiter = allowAllLimiter();
    const { res } = await call(
      "/auth/telegram",
      post({ "CF-Connecting-IP": "203.0.113.7" }),
      makeEnv({ RATE_LIMIT_AUTH_IP: limiter }),
    );
    // пустое тело — отказ самого обработчика, а не лимита
    expect(res.status).toBe(400);
    expect(limiter.calls).toHaveLength(1);
  });

  it("под лимитом все POST /auth/*: вход сотрудника и выход тоже", async () => {
    const limiter = denyAllLimiter();
    const env = makeEnv({ RATE_LIMIT_AUTH_IP: limiter });
    for (const path of ["/auth/staff/telegram", "/auth/logout"]) {
      const { res } = await call(path, post({ "CF-Connecting-IP": "203.0.113.7" }), env);
      expect(res.status, path).toBe(429);
    }
  });

  it("без CF-Connecting-IP (локальный запуск) лимит по IP не применяется", async () => {
    const limiter = denyAllLimiter();
    const { res } = await call("/auth/telegram", post(), makeEnv({ RATE_LIMIT_AUTH_IP: limiter }));
    expect(res.status).toBe(400);
    expect(limiter.calls).toHaveLength(0);
  });

  it("GET и чужие пути лимит не трогает", async () => {
    const limiter = denyAllLimiter();
    const env = makeEnv({ RATE_LIMIT_AUTH_IP: limiter, RATE_LIMIT_REQUESTS_IP: limiter });
    const headers = { "CF-Connecting-IP": "203.0.113.7" };
    await call("/health", { headers }, makeEnv({ ...env, HYPERDRIVE: undefined as unknown as Hyperdrive }));
    await call("/me", { headers }, env);
    await call("/requests", { headers }, env);
    expect(limiter.calls).toHaveLength(0);
  });

  it("привязка упала или её нет — запрос проходит, причина в логе", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: RateLimit = {
      limit: async () => {
        throw new Error("binding down");
      },
    };
    const headers = { "CF-Connecting-IP": "203.0.113.7" };
    const failing = await call("/auth/telegram", post(headers), makeEnv({ RATE_LIMIT_AUTH_IP: broken }));
    expect(failing.res.status).toBe(400);
    const missing = await call(
      "/auth/telegram",
      post(headers),
      makeEnv({ RATE_LIMIT_AUTH_IP: undefined as unknown as RateLimit }),
    );
    expect(missing.res.status).toBe(400);
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe("POST /requests", () => {
  it("лимит по IP — до базы", async () => {
    const limiter = denyAllLimiter();
    const { res, pending } = await call(
      "/requests",
      post({ "CF-Connecting-IP": "203.0.113.7" }),
      makeEnv({ RATE_LIMIT_REQUESTS_IP: limiter }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(pending).toHaveLength(0);
  });

  it("гость не считается лимитом по актору (его отсечёт маршрут)", async () => {
    const actorLimiter = denyAllLimiter();
    const { res } = await call(
      "/requests",
      post({ "CF-Connecting-IP": "203.0.113.7" }),
      makeEnv({ RATE_LIMIT_REQUESTS_ACTOR: actorLimiter }),
    );
    expect(res.status).not.toBe(429);
    expect(actorLimiter.calls).toHaveLength(0);
  });

  it("кривой токен — 401 до лимита по актору", async () => {
    const actorLimiter = denyAllLimiter();
    const { res } = await call(
      "/requests",
      post({ Authorization: "Bearer nope" }),
      makeEnv({ RATE_LIMIT_REQUESTS_ACTOR: actorLimiter }),
    );
    expect(res.status).toBe(401);
    expect(actorLimiter.calls).toHaveLength(0);
  });
});

describe("limitByActor", () => {
  function appWith(actor: Actor, env: Env) {
    const app = new Hono<AppEnv>();
    app.use(async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    app.post("/x", limitByActor("RATE_LIMIT_REQUESTS_ACTOR"), (c) => c.json({ ok: true }));
    app.onError(handleError);
    return (init: RequestInit = { method: "POST" }) => app.request("/x", init, env, makeCtx().ctx);
  }

  it("ключ — вид и id актора", async () => {
    const limiter = allowAllLimiter();
    const env = makeEnv({ RATE_LIMIT_REQUESTS_ACTOR: limiter });
    const id = "cccccccc-0000-0000-0000-000000000001";
    expect((await appWith({ kind: "client", id }, env)()).status).toBe(200);
    expect(limiter.calls).toEqual([`client:${id}`]);
  });

  it("клиент исчерпал лимит — 429", async () => {
    const env = makeEnv({ RATE_LIMIT_REQUESTS_ACTOR: denyAllLimiter() });
    const res = await appWith({ kind: "client", id: "cccccccc-0000-0000-0000-000000000001" }, env)();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("гость и system не считаются", async () => {
    const limiter = denyAllLimiter();
    const env = makeEnv({ RATE_LIMIT_REQUESTS_ACTOR: limiter });
    expect((await appWith({ kind: "guest" }, env)()).status).toBe(200);
    expect((await appWith({ kind: "system" }, env)()).status).toBe(200);
    expect(limiter.calls).toHaveLength(0);
  });
});
