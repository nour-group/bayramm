// Маршруты клиента без базы: всё, что отсекается до первого запроса к Postgres.
// С базой — test/integration/client-api.test.ts
import { describe, expect, it } from "vitest";
import { call } from "../testing/worker";
import { clientSource } from "./requests";

async function error(res: Response) {
  return ((await res.json()) as { error: { code: string; details?: string[] } }).error;
}

describe("каталог: отказ до базы", () => {
  it("неверные параметры — 400 invalid_request со списком", async () => {
    const { res } = await call("/catalog/listings?guests=abc&sort=cheap&limit=100");
    expect(res.status).toBe(400);
    expect(await error(res)).toMatchObject({ code: "invalid_request", details: ["guests", "limit", "sort"] });
  });

  it("испорченный курсор — 400 invalid_cursor", async () => {
    const { res } = await call("/catalog/listings?cursor=bm90LWEtY3Vyc29y");
    expect(res.status).toBe(400);
    expect((await error(res)).code).toBe("invalid_cursor");
  });

  it("карточка: слаг не того вида — 404, кривая дата — 400", async () => {
    expect((await call("/catalog/listings/Not_A_Slug")).res.status).toBe(404);
    expect((await call("/catalog/listings/a")).res.status).toBe(404);
    const { res } = await call("/catalog/listings/hall-one?date=2026-13-01");
    expect(res.status).toBe(400);
    expect(await error(res)).toMatchObject({ code: "invalid_request", details: ["date"] });
  });

  it("«Связаться»: слаг не того вида — 404, тело без action или signedIn — 400; ответ не кэшируется", async () => {
    const post = (slug: string, body: unknown) =>
      call(`/catalog/listings/${slug}/contact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    expect((await post("Not_A_Slug", { action: "open", signedIn: false })).res.status).toBe(404);
    for (const [body, details] of [
      [{}, ["action", "signedIn"]],
      [{ action: "call", signedIn: false }, ["action"]],
      [{ action: "open", signedIn: "yes" }, ["signedIn"]],
      ["not json", ["action", "signedIn"]],
      [{ action: "open", signedIn: true, pad: "x".repeat(300) }, ["action", "signedIn"]],
    ] as const) {
      const { res } = await post("hall-one", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await error(res)).toMatchObject({ code: "invalid_request", details });
    }
  });

  it("тексты согласий: неизвестная локаль — 400", async () => {
    const { res } = await call("/consent-texts?locale=en");
    expect(res.status).toBe(400);
    expect(await error(res)).toMatchObject({ code: "invalid_request", details: ["locale"] });
  });
});

describe("заявки: без входа", () => {
  it("GET и POST /requests, отзыв — 401; ответ не кэшируется", async () => {
    for (const [path, method] of [
      ["/requests", "GET"],
      ["/requests", "POST"],
      ["/requests/eeeeeeee-0000-4000-8000-000000000001/withdraw", "POST"],
    ] as const) {
      const { res } = await call(path, { method, body: method === "POST" ? "{}" : undefined });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect((await error(res)).code).toBe("unauthorized");
    }
  });

  it("кривой токен — 401 до базы, тоже без кэша", async () => {
    const { res } = await call("/requests", { headers: { Authorization: "Bearer" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("clientSource", () => {
  it("только явное tma — Mini App; всё остальное — web", () => {
    expect(clientSource("tma")).toBe("tma");
    expect(clientSource(" TMA ")).toBe("tma");
    for (const value of [undefined, "", "web", "telegram", "tma2"])
      expect(clientSource(value), value).toBe("web");
  });
});
