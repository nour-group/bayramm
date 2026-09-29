// Лимит частоты по клиенту на POST /requests — на настоящей базе: он стоит после
// проверки сессии, ключ — id клиента. Логика привязок — юнит-тесты src/ratelimit.test.ts
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../src/index";
import { adminClient, bearer, cleanup, loginToken, makeEnv, newTelegramUser, tgIdHash } from "./helpers";

let admin: Client;

beforeAll(async () => {
  admin = await adminClient();
});

afterAll(async () => {
  await cleanup(admin);
  await admin.end();
});

function limiter(success: boolean): RateLimit & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async limit({ key }) {
      calls.push(key);
      return { success };
    },
  };
}

async function postRequest(env: Env, headers: Record<string, string>): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const res = await app.request(
    "/requests",
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" },
    env,
    ctx,
  );
  await Promise.all(pending);
  return res;
}

describe("POST /requests: лимит по клиенту", () => {
  it("исчерпан — 429 rate_limited без кэша, ключ — аккаунт клиента", async () => {
    const user = newTelegramUser();
    const token = await loginToken(user);
    const { rows } = await admin.query<{ id: string }>(
      "select account_id as id from app.clients where tg_id_hash = $1",
      [tgIdHash(user.id)],
    );
    const deny = limiter(false);

    const res = await postRequest(
      { ...makeEnv(), RATE_LIMIT_REQUESTS_ACTOR: deny },
      bearer(token).headers as Record<string, string>,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    expect(deny.calls).toEqual([`account:${rows[0]?.id}`]);
  });

  it("не исчерпан — запрос идёт дальше, к проверке тела", async () => {
    const token = await loginToken(newTelegramUser());
    const allow = limiter(true);
    const res = await postRequest(
      { ...makeEnv(), RATE_LIMIT_REQUESTS_ACTOR: allow },
      bearer(token).headers as Record<string, string>,
    );
    expect(res.status).toBe(400);
    expect(allow.calls).toHaveLength(1);
  });

  it("гость — 401, лимит по клиенту не тратится", async () => {
    const deny = limiter(false);
    const res = await postRequest({ ...makeEnv(), RATE_LIMIT_REQUESTS_ACTOR: deny }, {});
    expect(res.status).toBe(401);
    expect(deny.calls).toHaveLength(0);
  });
});
