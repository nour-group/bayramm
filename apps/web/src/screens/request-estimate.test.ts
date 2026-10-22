import type { PublicService } from "@bayramm/shared/api";
import { describe, expect, it } from "vitest";
import { estimate, fieldsFromQty, qtyFieldOf, suggestedQty, withFieldQty } from "./request-estimate";

const service = (patch: Partial<PublicService>): PublicService => ({
  id: "s1",
  type: "bride_car",
  name: { ru: "Машина", uz: "Mashina" },
  priceUzs: 350_000,
  priceUnit: "per_hour",
  minQty: 3,
  leadDays: null,
  includes: null,
  options: [],
  ...patch,
});

const car = service({});
const cake = service({ id: "s2", type: "cake", priceUnit: "per_kg", minQty: null, priceUzs: 200_000 });
const banquet = service({ id: "s3", type: "banquet", priceUnit: "per_guest", minQty: null });
const KORTEJ_FIELDS = ["start_time", "hours", "cars_count", "car_class"];

describe("количество услуги из поля формы той же единицы", () => {
  it("поле есть в форме — количество за ним; нет или единица другая — своё", () => {
    expect(qtyFieldOf(car, KORTEJ_FIELDS)).toBe("hours");
    expect(qtyFieldOf(car, ["start_time"])).toBeNull();
    expect(qtyFieldOf(banquet, KORTEJ_FIELDS)).toBeNull();
    expect(qtyFieldOf(cake, ["weight_kg"])).toBe("weight_kg");
  });

  it("часы формы — количество услуги, не меньше минимального; поле пусто — минимальное", () => {
    const chosen = [{ id: "s1", qty: "3", options: [] }];
    expect(withFieldQty(chosen, [car], { hours: "6" }, KORTEJ_FIELDS)).toEqual([
      { id: "s1", qty: "6", options: [] },
    ]);
    expect(withFieldQty(chosen, [car], { hours: "2" }, KORTEJ_FIELDS)[0]?.qty).toBe("3");
    expect(withFieldQty(chosen, [car], {}, KORTEJ_FIELDS)[0]?.qty).toBe("3");
    // Поля нет в форме — количество услуги своё
    expect(
      withFieldQty([{ id: "s1", qty: "5", options: [] }], [car], { hours: "6" }, ["start_time"])[0]?.qty,
    ).toBe("5");
  });

  it("сумма — по часам формы: 6 ч × 350 000, а не 3 ч с витрины", () => {
    const chosen = withFieldQty([{ id: "s1", qty: "3", options: [] }], [car], { hours: "6" }, KORTEJ_FIELDS);
    const total = estimate(
      [car],
      chosen.map((c) => ({ id: c.id, qty: Number(c.qty), options: c.options })),
      null,
    );
    expect(total).toEqual({ total: 2_100_000, counted: 1, needsGuests: false });
  });

  it("количество с витрины — в пустое поле формы; заполненное не трогает; несколько — большее", () => {
    const venue = [
      { id: "s1", qty: "4", options: [] },
      { id: "s4", qty: "5", options: [] },
    ];
    const second = service({ id: "s4" });
    expect(fieldsFromQty(venue, [car, second], {}, KORTEJ_FIELDS)).toEqual({ hours: "5" });
    expect(fieldsFromQty(venue, [car, second], { hours: "2" }, KORTEJ_FIELDS)).toEqual({});
    expect(fieldsFromQty(venue, [car, second], {}, ["start_time"])).toEqual({});
  });

  it("предложение при выборе услуги — из поля той же единицы", () => {
    expect(suggestedQty(car, { hours: "8" })).toBe("8");
    expect(suggestedQty(car, {})).toBe("3");
    expect(suggestedQty(banquet, { hours: "8" })).toBe("");
  });
});
