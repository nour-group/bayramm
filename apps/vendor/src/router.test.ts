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

  it("параметры адреса: день календаря и витрина, блок витрины; чужие и кривые — отбрасываются", () => {
    const listing = "aaaaaaaa-0000-0000-0000-000000000101";
    const day = { route: "calendar", listing, day: "2026-11-14" } as const;
    expect(pathOf(day)).toBe(`/calendar?listing=${listing}&day=2026-11-14`);
    expect(matchRoute("/calendar", `?listing=${listing}&day=2026-11-14`)).toEqual(day);
    expect(matchRoute("/calendar", "?listing=7&day=14.11")).toEqual({ route: "calendar" });
    expect(pathOf({ route: "card", focus: "sessions" })).toBe("/card?focus=sessions");
    expect(matchRoute("/card", "?focus=attributes")).toEqual({ route: "card", focus: "attributes" });
    expect(matchRoute("/card", "?focus=photos")).toEqual({ route: "card" });
    // Параметры — только своим экранам
    expect(pathOf({ route: "requests", day: "2026-11-14" })).toBe("/requests");
    expect(matchRoute("/requests", "?day=2026-11-14")).toEqual({ route: "requests" });
  });

  it("пути не повторяются; в панели заявки, календарь, площадка, услуги, аккаунт; карточка заявки — раздел заявок", () => {
    const paths = Object.values(ROUTES);
    expect(new Set(paths).size).toBe(paths.length);
    expect(NAV).toEqual(["requests", "calendar", "card", "services", "account"]);
    expect(SECTION_OF.request).toBe("requests");
  });
});
