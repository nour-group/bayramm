import { describe, expect, it } from "vitest";
import type { VendorActor } from "../db/actor";
import { ApiError } from "../errors";
import { assertVendorCan, VENDOR_PERMISSIONS, vendorCan } from "./access";

const actor = (role: VendorActor["role"]): VendorActor => ({
  kind: "vendor_user",
  id: "aaaaaaaa-0000-0000-0000-000000000011",
  vendorId: "aaaaaaaa-0000-0000-0000-000000000001",
  role,
});

describe("роли кабинета", () => {
  it("заявки и календарь — владелец и сотрудник площадки; карточку — только владелец", () => {
    expect(vendorCan("member", "requests.write")).toBe(true);
    expect(vendorCan("member", "calendar.write")).toBe(true);
    expect(vendorCan("member", "card.propose")).toBe(false);
    expect(vendorCan("member", "photos.write")).toBe(false);
    for (const permission of Object.keys(VENDOR_PERMISSIONS) as (keyof typeof VENDOR_PERMISSIONS)[]) {
      expect(vendorCan("owner", permission), permission).toBe(true);
    }
  });

  it("нет права — 403 vendor_owner_required", () => {
    expect(() => assertVendorCan(actor("owner"), "photos.write")).not.toThrow();
    try {
      assertVendorCan(actor("member"), "photos.write");
      throw new Error("ожидался отказ");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect([(err as ApiError).status, (err as ApiError).code]).toEqual([403, "vendor_owner_required"]);
    }
  });
});
