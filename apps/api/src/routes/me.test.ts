// /me без базы: разбор тела отзыва согласия и отказ без сессии. С базой — test/integration/me.test.ts
import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { call } from "../testing/worker";
import { parseWithdrawConsent } from "./me";

const LISTING = "aaaaaaaa-0000-0000-0000-000000000101";

describe("parseWithdrawConsent", () => {
  it("цели клиента; листинг — только у request_transfer", () => {
    expect(parseWithdrawConsent({ purpose: "bot_notifications" })).toEqual({
      purpose: "bot_notifications",
      listingId: null,
    });
    expect(parseWithdrawConsent({ purpose: "client_service", listingId: null })).toEqual({
      purpose: "client_service",
      listingId: null,
    });
    expect(parseWithdrawConsent({ purpose: "request_transfer", listingId: LISTING.toUpperCase() })).toEqual({
      purpose: "request_transfer",
      listingId: LISTING,
    });
  });

  it.each([
    ["не объект", "bot_notifications"],
    ["массив", []],
    ["null", null],
    ["без цели", {}],
    ["цель вендора", { purpose: "vendor_contact" }],
    ["неизвестная цель", { purpose: "marketing" }],
    ["request_transfer без листинга", { purpose: "request_transfer" }],
    ["листинг не UUID", { purpose: "request_transfer", listingId: "1 or 1=1" }],
    ["листинг у другой цели", { purpose: "bot_notifications", listingId: LISTING }],
  ])("%s — 400 invalid_request", (_name, body) => {
    try {
      parseWithdrawConsent(body);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 400, code: "invalid_request" });
    }
  });
});

describe("без сессии — 401", () => {
  it.each([
    ["GET", "/me/export"],
    ["DELETE", "/me"],
    ["POST", "/me/consents/withdraw"],
  ])("%s %s", async (method, path) => {
    const { res } = await call(path, { method, headers: { "content-type": "application/json" } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  });
});
