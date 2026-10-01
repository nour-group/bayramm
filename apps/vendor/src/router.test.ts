import { describe, expect, it } from "vitest";
import { HOME, matchRoute, NAV, pathOf, ROUTES, SECTION_OF } from "./router";

const ID = "eeeeeeee-0000-0000-0000-0000000000a1";

describe("маршруты кабинета вендора", () => {
  it.each([
    ["/", { route: HOME }],
    ["/requests", { route: "requests" }],
    ["/requests/", { route: "requests" }],
    [`/requests/${ID}`, { route: "request", id: ID }],
    [`/requests/${ID.toUpperCase()}`, { route: "request", id: ID }],
    ["/calendar", { route: "calendar" }],
    ["/card", { route: "card" }],
    ["/services", { route: "services" }],
    ["/account", { route: "account" }],
  ])("%s → %j", (path, location) => {
    expect(matchRoute(path)).toEqual(location);
  });

  it.each(["/api", "/cards", "/calendar/2026", "/index.html", "/requests/7", "/requests/:id", "/login"])(
    "%s — не найдено",
    (path) => {
      expect(matchRoute(path)).toBeNull();
    },
  );

  it("путь экрана и разбор пути сходятся", () => {
    for (const location of [
      { route: "requests" },
      { route: "request", id: ID },
      { route: "card" },
      { route: "services" },
      { route: "account" },
    ] as const) {
      expect(matchRoute(pathOf(location))).toEqual(location);
    }
  });

  it("пути не повторяются; в панели заявки, календарь, площадка, услуги, аккаунт; карточка заявки — раздел заявок", () => {
    const paths = Object.values(ROUTES);
    expect(new Set(paths).size).toBe(paths.length);
    expect(NAV).toEqual(["requests", "calendar", "card", "services", "account"]);
    expect(SECTION_OF.request).toBe("requests");
  });
});
