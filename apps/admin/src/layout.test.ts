// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentLayout, layoutOf, PHONE_MAX, TABLET_MAX } from "./layout";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("раскладка по ширине", () => {
  it.each([
    [320, "phone"],
    [PHONE_MAX, "phone"],
    [PHONE_MAX + 1, "tablet"],
    [TABLET_MAX, "tablet"],
    [TABLET_MAX + 1, "desktop"],
    [0, "desktop"],
  ] as const)("%ipx — %s", (width, layout) => {
    expect(layoutOf(width)).toBe(layout);
  });

  it("по медиазапросам — теми же, что в styles.css", () => {
    const queries: string[] = [];
    vi.stubGlobal("matchMedia", (query: string) => {
      queries.push(query);
      return { matches: query === `(max-width: ${TABLET_MAX}px)` };
    });
    expect(currentLayout()).toBe("tablet");
    expect(queries).toEqual([`(max-width: ${PHONE_MAX}px)`, `(max-width: ${TABLET_MAX}px)`]);
  });

  it("matchMedia нет (старый вебвью, ловушка №5) — по ширине окна", () => {
    vi.stubGlobal("matchMedia", undefined);
    vi.stubGlobal("innerWidth", 375);
    expect(currentLayout()).toBe("phone");
  });
});
