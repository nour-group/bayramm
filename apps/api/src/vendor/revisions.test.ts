// Правка карточки из кабинета без базы: разбор тела и «только изменённые поля».
// С базой (одна открытая правка, чужая площадка, оповещение команде) —
// test/integration/vendor.test.ts
import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { changedOnly } from "../staff/revision-diff";
import { revisionFromBody } from "../staff/revisions";

const LISTING = {
  name: "Lola zali",
  description_ru: "Зал на 300 гостей",
  description_uz: null,
  attributes: { halls_count: 2, stage: true },
  video_links: [],
};

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
    expect(invalid({ address_ru: "x", name: "A" })).toEqual(expect.arrayContaining(["address_ru", "name"]));
  });

  it("цены и пакеты v0.1 правкой не меняются — неизвестные ключи", () => {
    expect(invalid({ price_from_uzs: 180000 })).toEqual(["price_from_uzs"]);
    expect(invalid({ price_unit: "per_guest" })).toEqual(["price_unit"]);
    expect(
      invalid({ packages: [{ kind: "weekday", name_ru: "Будни", name_uz: "Ish kunlari", price_uzs: 1 }] }),
    ).toEqual(["packages"]);
  });
});

describe("правка из кабинета: только изменённые поля", () => {
  it("совпадает с карточкой — в правку не попадает", () => {
    const values = revisionFromBody(
      { name: " Lola zali ", description_ru: "Зал на 300 гостей", attributes: { stage: true } },
      "hall",
    );
    expect(changedOnly(values, LISTING)).toEqual({});
  });

  it("новые описание на узбекском и поле витрины — в правке, остальное — нет", () => {
    const values = revisionFromBody(
      { name: "Lola zali", description_uz: "300 mehmonga zal", attributes: { halls_count: 3, stage: true } },
      "hall",
    );
    expect(changedOnly(values, LISTING)).toEqual({
      description_uz: "300 mehmonga zal",
      attributes: { halls_count: 3 },
    });
  });
});
