// Правка карточки из кабинета без базы: разбор тела и «только изменённые поля».
// С базой (одна открытая правка, чужая площадка, оповещение команде) —
// test/integration/vendor.test.ts
import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { revisionFromBody } from "../staff/revisions";
import { changedOnly } from "./revisions";

const LISTING = {
  name: "Lola zali",
  price_from_uzs: "25000000",
  price_unit: "per_event" as const,
  description_ru: "Зал на 300 гостей",
  description_uz: null,
};
const PACKAGES = [
  {
    kind: "weekday" as const,
    name_ru: "Будни",
    name_uz: "Ish kunlari",
    price_uzs: 25000000,
    price_unit: "per_event" as const,
  },
  {
    kind: "weekend" as const,
    name_ru: "Выходные",
    name_uz: "Dam olish",
    price_uzs: 30000000,
    price_unit: "per_event" as const,
  },
];

function invalid(body: Record<string, unknown>): string[] {
  try {
    revisionFromBody(body, "hall");
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    return (err as ApiError).details ?? [];
  }
  throw new Error("правка прошла проверку");
}

describe("правка из кабинета: разбор тела", () => {
  it("неизвестный ключ и неверные поля — 422 со всеми именами", () => {
    expect(invalid({ address_ru: "x", price_from_uzs: 0, name: "A" })).toEqual(
      expect.arrayContaining(["address_ru", "price_from_uzs", "name"]),
    );
  });

  it("цена «по запросу» и пакет без цены — не проходят", () => {
    expect(invalid({ price_from_uzs: "по запросу" })).toEqual(["price_from_uzs"]);
    expect(
      invalid({ packages: [{ kind: "weekday", name_ru: "Будни", name_uz: "Ish kunlari", price_uzs: null }] }),
    ).toEqual(["packages.0.price_uzs"]);
  });
});

describe("правка из кабинета: только изменённые поля", () => {
  it("совпадает с карточкой — в правку не попадает", () => {
    const values = revisionFromBody(
      {
        name: " Lola zali ",
        price_from_uzs: 25000000,
        price_unit: "per_event",
        description_ru: "Зал на 300 гостей",
        packages: PACKAGES,
      },
      "hall",
    );
    expect(changedOnly(values, LISTING, PACKAGES)).toEqual({});
  });

  it("новые цена, описание на узбекском и пакеты — в правке, остальное — нет", () => {
    const packages = [PACKAGES[0], { ...PACKAGES[1], price_uzs: 32000000 }];
    const values = revisionFromBody(
      {
        name: "Lola zali",
        price_from_uzs: 26000000,
        description_uz: "300 mehmonga zal",
        packages,
      },
      "hall",
    );
    expect(changedOnly(values, LISTING, PACKAGES)).toEqual({
      price_from_uzs: 26000000,
      description_uz: "300 mehmonga zal",
      packages,
    });
  });

  it("пакет без единицы цены — за гостя, как в панели", () => {
    const custom = { kind: "custom", name_ru: "VIP", name_uz: "VIP", price_uzs: 40000000 };
    const values = revisionFromBody({ packages: [...PACKAGES, custom] }, "hall");
    expect(changedOnly(values, LISTING, PACKAGES).packages?.[2]).toEqual({
      ...custom,
      price_unit: "per_guest",
    });
  });
});
