import { describe, expect, it } from "vitest";
import { HOME, matchRoute, NAV, ROUTES } from "./router";

describe("маршруты кабинета вендора", () => {
  it.each([
    ["/", HOME],
    ["/requests", "requests"],
    ["/requests/", "requests"],
    ["/calendar", "calendar"],
    ["/card", "card"],
    ["/login", "login"],
  ])("%s → %s", (path, route) => {
    expect(matchRoute(path)).toBe(route);
  });

  it.each(["/api", "/cards", "/calendar/2026", "/index.html"])("%s — не найдено", (path) => {
    expect(matchRoute(path)).toBeNull();
  });

  it("пути не повторяются; в навигации заявки, календарь, карточка", () => {
    const paths = Object.values(ROUTES);
    expect(new Set(paths).size).toBe(paths.length);
    expect(NAV).toEqual(["requests", "calendar", "card"]);
  });
});
