import { describe, expect, it } from "vitest";
import type { Identity } from "./context";
import { chromeOf, GUEST_SECTIONS, isPersonal, sectionsOf, signInGate } from "./nav";
import { type Match, matchRoute, TABS } from "./routes";

/* Оболочка гостя и после входа: какая, какие разделы, куда уводить с личного экрана */

const IDENTITIES: readonly Identity[] = ["telegram", "site", "guest", "demo"];

describe("оболочка", () => {
  it("Telegram — всегда приложение, даже после удаления аккаунта во вкладке", () => {
    expect(chromeOf("telegram", true, false)).toBe("app");
    expect(chromeOf("telegram", true, true)).toBe("app");
  });

  it("сайт: после входа — приложение, без входа или с удалённым аккаунтом — гость", () => {
    expect(chromeOf("site", false, false)).toBe("app");
    expect(chromeOf("demo", false, false)).toBe("app");
    expect(chromeOf("guest", false, false)).toBe("guest");
    expect(chromeOf("site", false, true)).toBe("guest");
    expect(chromeOf("demo", false, true)).toBe("guest");
  });

  it("разделы: гостю — каталог и сохранённое, после входа — все четыре по порядку", () => {
    expect(sectionsOf("guest")).toEqual(["catalog", "favorites"]);
    expect(sectionsOf("app")).toEqual(["catalog", "favorites", "requests", "profile"]);
    expect(sectionsOf("app")).toBe(TABS);
    // Разделы гостя — подмножество вкладок, в том же порядке
    expect(TABS.filter((tab) => (GUEST_SECTIONS as readonly string[]).includes(tab))).toEqual([
      ...GUEST_SECTIONS,
    ]);
    // Ни одного личного раздела у гостя
    for (const tab of GUEST_SECTIONS) expect(isPersonal({ name: tab })).toBe(false);
  });
});

describe("личные экраны", () => {
  it.each([
    ["/requests", true],
    ["/profile", true],
    ["/", false],
    ["/catalog", false],
    ["/favorites", false],
    ["/docs", false],
    ["/venue/lola-zali", false],
    ["/venue/lola-zali/request", false],
    ["/auth", false],
    ["/nope", false],
  ])("%s — личный: %s", (path, personal) => {
    expect(isPersonal(matchRoute(path))).toBe(personal);
  });

  it("гость с личного экрана — в хаб с возвратом сюда, вместе со строкой запроса", () => {
    expect(signInGate({ name: "requests" }, "guest", "/requests?open=r1")).toBe(
      "/auth?return=%2Frequests%3Fopen%3Dr1",
    );
    expect(signInGate({ name: "profile" }, "guest", "/profile")).toBe("/auth?return=%2Fprofile");
  });

  it("со входом (Telegram, сайт, демо) — экран на месте; не личный — у всех на месте", () => {
    for (const identity of IDENTITIES.filter((i) => i !== "guest")) {
      expect(signInGate({ name: "requests" }, identity, "/requests")).toBeNull();
      expect(signInGate({ name: "profile" }, identity, "/profile")).toBeNull();
    }
    const open: readonly (Match | null)[] = [
      { name: "home" },
      { name: "catalog" },
      { name: "favorites" },
      { name: "venue", slug: "a" },
      { name: "request", slug: "a" },
      { name: "auth" },
      null,
    ];
    for (const match of open)
      for (const identity of IDENTITIES) expect(signInGate(match, identity, "/x")).toBeNull();
  });

  it("путь возврата — только свой: чужой адрес не попадает в хаб", () => {
    expect(signInGate({ name: "profile" }, "guest", "//evil.example/profile")).toBe("/auth");
  });
});
