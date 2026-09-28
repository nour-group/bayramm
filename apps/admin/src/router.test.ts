import { describe, expect, it } from "vitest";
import { HOME, matchRoute, NAV, ROUTES } from "./router";
import { t } from "./texts";

describe("маршруты панели оператора", () => {
  it.each([
    ["/", HOME],
    ["/vendors", "vendors"],
    ["/moderation/", "moderation"],
    ["/requests", "requests"],
    ["/clients", "clients"],
  ])("%s → %s", (path, route) => {
    expect(matchRoute(path)).toBe(route);
  });

  it.each(["/api", "/login", "/vendors/3", "/index.html"])("%s — не найдено", (path) => {
    expect(matchRoute(path)).toBeNull();
  });

  it("пути не повторяются; в навигации все разделы", () => {
    const paths = Object.values(ROUTES);
    expect(new Set(paths).size).toBe(paths.length);
    expect(NAV).toEqual(["vendors", "moderation", "requests", "clients"]);
  });

  it("у каждого раздела есть название и пояснение", () => {
    for (const route of NAV) {
      expect(t[route]).toBeTruthy();
      expect(t[`${route}Lead`]).toBeTruthy();
    }
  });
});
