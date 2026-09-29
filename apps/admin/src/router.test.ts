import { describe, expect, it } from "vitest";
import {
  HOME,
  matchRoute,
  matchSection,
  NAV,
  parseView,
  pathOf,
  ROUTES,
  SECTION_PERMISSION,
  sectionOf,
} from "./router";
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
    expect(NAV).toEqual([
      "vendors",
      "moderation",
      "requests",
      "clients",
      "notifications",
      "audit",
      "team",
      "settings",
    ]);
  });

  it("у каждого раздела — право, без которого его нет в навигации; команда, настройки и журнал — только администратору", () => {
    for (const section of NAV) expect(SECTION_PERMISSION[section]).toBeTruthy();
    expect(SECTION_PERMISSION.team).toBe("team.manage");
    expect(SECTION_PERMISSION.settings).toBe("settings.write");
    expect(SECTION_PERMISSION.audit).toBe("audit.read");
  });

  it.each([
    [
      "/clients/aaaaaaaa-0000-0000-0000-000000000001",
      { name: "client", id: "aaaaaaaa-0000-0000-0000-000000000001" },
    ],
    [
      "/revisions/BBBBBBBB-0000-0000-0000-000000000001",
      { name: "revision", id: "bbbbbbbb-0000-0000-0000-000000000001" },
    ],
    ["/audit", { name: "audit" }],
  ] as const)("экран %s ↔ путь", (path, view) => {
    expect(parseView(path)).toEqual(view);
    expect(pathOf(view)).toBe(path.toLowerCase());
  });

  it("клиент — в разделе «Клиенты», правка карточки — в «Модерации»", () => {
    expect(sectionOf({ name: "client", id: "x" })).toBe("clients");
    expect(sectionOf({ name: "revision", id: "x" })).toBe("moderation");
  });

  it("у каждого раздела есть название и пояснение", () => {
    for (const route of NAV) {
      expect(t[route]).toBeTruthy();
      expect(t[`${route}Lead`]).toBeTruthy();
    }
  });
});
