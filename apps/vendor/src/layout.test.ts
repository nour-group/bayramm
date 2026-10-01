// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentLayout, layoutOf, PHONE_MAX, TABLET_MAX } from "./layout";

describe("раскладка кабинета по ширине", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [320, "phone"],
    [390, "phone"],
    [PHONE_MAX, "phone"],
    [PHONE_MAX + 1, "tablet"],
    [768, "tablet"],
    [TABLET_MAX, "tablet"],
    [TABLET_MAX + 1, "desktop"],
    [1440, "desktop"],
  ] as const)("%ipx — %s", (width, layout) => {
    expect(layoutOf(width)).toBe(layout);
  });

  it("ширину не узнать — телефон: кабинет прежде всего Mini App", () => {
    expect(layoutOf(0)).toBe("phone");
  });

  it("по медиазапросам, как у стилей", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === `(max-width: ${TABLET_MAX}px)`,
      media: query,
    }));
    expect(currentLayout()).toBe("tablet");
  });

  it("matchMedia нет (старый вебвью, ловушка №5) — по ширине окна", () => {
    vi.stubGlobal("matchMedia", undefined);
    vi.stubGlobal("innerWidth", 1280);
    expect(currentLayout()).toBe("desktop");
  });
});
