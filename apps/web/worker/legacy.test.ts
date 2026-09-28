import { describe, expect, it } from "vitest";
import { isTaklifnomaPath, taklifnomaRedirect } from "./legacy";

describe("taklifnoma legacy paths", () => {
  it.each([
    "/paketlar",
    "/paketlar.html",
    "/classic",
    "/arabic.html",
    "/envelope/",
    "/demo/wedding-1",
    "/og.png",
    "/manifest.webmanifest",
  ])("%s goes to taklifnoma", (p) => {
    expect(isTaklifnomaPath(p)).toBe(true);
  });

  it.each(["/", "/api/health", "/vendor/42", "/assets/index.js", "/robots.txt", "/demo"])(
    "%s stays in Bayramm",
    (p) => {
      expect(isTaklifnomaPath(p)).toBe(false);
    },
  );

  it("keeps path and query in a permanent redirect", () => {
    const res = taklifnomaRedirect(new URL("https://bayramm.uz/classic.html?to=Aziza"));
    expect(res?.status).toBe(301);
    expect(res?.headers.get("location")).toBe("https://taklifnoma.bayramm.uz/classic.html?to=Aziza");
  });
});
