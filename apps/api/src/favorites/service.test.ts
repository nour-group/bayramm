// Избранное без базы: разбор id и отказы до первого запроса. С базой —
// test/integration/favorites.test.ts, правила таблицы — pgTAP 18_favorites
import { describe, expect, it } from "vitest";
import { call } from "../testing/worker";
import { FAVORITES_MAX, listingIdParam, parseIdsQuery, parseListingIds } from "./service";

const A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

async function codeOf(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return "ok";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

describe("разбор id", () => {
  it("id из пути: UUID (регистр не важен); иное — 404, как у любого несуществующего", async () => {
    expect(listingIdParam(A.toUpperCase())).toBe(A);
    for (const bad of ["nope", "", `${A}x`, "1; drop table"]) {
      expect(await codeOf(() => listingIdParam(bad)), bad).toBe("not_found");
    }
  });

  it("список: UUID без повторов, порядок как прислали", () => {
    expect(parseListingIds([B, A, B.toUpperCase()], "listingIds")).toEqual([B, A]);
    expect(parseListingIds([], "listingIds")).toEqual([]);
  });

  it("не массив, не UUID, больше лимита — 400 с именем поля", async () => {
    const tooMany = Array.from({ length: FAVORITES_MAX + 1 }, () => A);
    for (const bad of [undefined, "x", {}, [42], ["nope"], tooMany]) {
      expect(await codeOf(() => parseListingIds(bad, "listingIds"))).toBe("invalid_request");
    }
  });

  it("строка запроса ids: через запятую; пусто — пустой список", () => {
    expect(parseIdsQuery(`${A},${B}`)).toEqual([A, B]);
    expect(parseIdsQuery(undefined)).toEqual([]);
    expect(parseIdsQuery("")).toEqual([]);
  });
});

describe("маршруты без базы", () => {
  it.each([
    ["GET", "/me/favorites"],
    ["PUT", `/me/favorites/${A}`],
    ["DELETE", `/me/favorites/${A}`],
    ["POST", "/me/favorites"],
  ])("%s %s без токена — 401", async (method, path) => {
    const { res } = await call(path, { method });
    expect(res.status).toBe(401);
  });

  it("GET /catalog/cards: кривые ids — 400 до базы", async () => {
    for (const query of ["ids=nope", `ids=${A}&ids=${B}`, `ids=${A},x`]) {
      const { res } = await call(`/catalog/cards?${query}`);
      expect(res.status, query).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    }
  });
});
