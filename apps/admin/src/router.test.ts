import { describe, expect, it } from "vitest";
import { HOME, matchRoute, matchSection, NAV, ROUTES } from "./router";
import { t } from "./texts";

describe("маршруты панели оператора", () => {
  it.each([
    ["/", HOME],
    ["/vendors", "vendors"],
    ["/moderation/", "moderation"],
    ["/requests", "requests"],
    ["/clients", "clients"],
    ["/login", "login"],
    ["/login/telegram", "loginTelegram"],
  ])("%s → %s", (path, route) => {
    expect(matchRoute(path)).toBe(route);
  });

  it.each(["/api", "/vendors/3", "/index.html", "/login/other"])("%s — не найдено", (path) => {
    expect(matchRoute(path)).toBeNull();
  });

  it("разделы — только из навигации; страницы входа разделами не считаются", () => {
    expect(matchSection("/moderation")).toBe("moderation");
    expect(matchSection("/")).toBe(HOME);
    expect(matchSection("/login")).toBeNull();
    expect(matchSection("/login/telegram")).toBeNull();
    expect(matchSection("/nope")).toBeNull();
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
