import { describe, expect, it } from "vitest";
import { hrefFor, matchRoute, parentOf, ROUTES, TABS, tabOf } from "./router";

describe("маршруты клиента", () => {
  it.each([
    ["/", { name: "catalog" }],
    ["", { name: "catalog" }],
    ["/requests", { name: "requests" }],
    ["/requests/", { name: "requests" }],
    ["/profile", { name: "profile" }],
    ["/venue/lola-zali", { name: "venue", slug: "lola-zali" }],
    ["/venue/lola-zali/", { name: "venue", slug: "lola-zali" }],
    ["/venue/lola-zali/request", { name: "request", slug: "lola-zali" }],
  ])("%s → %o", (path, match) => {
    expect(matchRoute(path)).toEqual(match);
  });

  it.each(["/venue", "/venue/Lola", "/venue/a_b", "/venue/a/b", "/venue/../admin", "/api/me", "/index.html"])(
    "%s — не найдено",
    (path) => {
      expect(matchRoute(path)).toBeNull();
    },
  );

  it("адрес собирается из карты и без пустых параметров", () => {
    expect(hrefFor({ name: "venue", slug: "lola-zali" }, { date: "2026-10-01", guests: null })).toBe(
      "/venue/lola-zali?date=2026-10-01",
    );
    expect(hrefFor({ name: "request", slug: "a-1" })).toBe("/venue/a-1/request");
    expect(hrefFor({ name: "catalog" }, { district: "", sort: undefined })).toBe("/");
  });

  it("всё, что собирает hrefFor, разбирает matchRoute", () => {
    for (const match of [
      { name: "catalog" },
      { name: "venue", slug: "zal-1" },
      { name: "request", slug: "zal-1" },
      { name: "requests" },
      { name: "profile" },
    ] as const)
      expect(matchRoute(hrefFor(match))).toEqual(match);
  });

  it("пути не повторяются; вкладки — каталог, заявки, профиль", () => {
    const paths = Object.values(ROUTES);
    expect(new Set(paths).size).toBe(paths.length);
    expect(TABS).toEqual(["catalog", "requests", "profile"]);
  });

  it("назад с внутреннего экрана — к родителю; вкладка внутреннего — каталог", () => {
    expect(parentOf({ name: "request", slug: "x-1" })).toEqual({ name: "venue", slug: "x-1" });
    expect(parentOf({ name: "venue", slug: "x-1" })).toEqual({ name: "catalog" });
    expect(parentOf({ name: "requests" })).toBeNull();
    expect(tabOf({ name: "venue", slug: "x-1" })).toBe("catalog");
    expect(tabOf({ name: "profile" })).toBe("profile");
    expect(tabOf(null)).toBeNull();
  });
});
