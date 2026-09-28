import { describe, expect, it } from "vitest";
import { trimTrailingSlashes } from "./strings";

describe("trimTrailingSlashes", () => {
  it.each([
    ["https://x.supabase.co/", "https://x.supabase.co"],
    ["https://x.supabase.co///", "https://x.supabase.co"],
    ["https://x.supabase.co", "https://x.supabase.co"],
    ["/requests/", "/requests"],
    ["/", ""],
    ["", ""],
    ["a//b/", "a//b"],
  ])("%s → %s", (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected);
  });

  it("линейна на длинной строке из «/» с символом в конце", () => {
    const hostile = `${"/".repeat(200_000)}x`;
    const started = Date.now();
    expect(trimTrailingSlashes(hostile)).toBe(hostile);
    expect(trimTrailingSlashes("/".repeat(200_000))).toBe("");
    expect(Date.now() - started).toBeLessThan(50);
  });
});
