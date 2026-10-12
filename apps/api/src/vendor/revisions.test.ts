// Правка карточки из кабинета без базы: разбор тела и «только изменённые поля».
// С базой (одна открытая правка, чужая площадка, оповещение команде) —
// test/integration/vendor.test.ts
import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { changedOnly, revisionFields } from "../staff/revision-diff";
import { parseRevision, revisionFromBody } from "../staff/revisions";

const LISTING = {
  name: "Lola zali",
  description_ru: "Зал на 300 гостей",
  description_uz: null,
  attributes: { halls_count: 2, stage: true },
  video_links: [],
  cap_min: 80,
  cap_max: 300,
  district_code: "chilonzor",
  address_ru: null,
  address_uz: null,
};

function invalid(body: Record<string, unknown>, category = "hall"): string[] {
  try {
    revisionFromBody(body, category);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    return (err as ApiError).details ?? [];
  }
  throw new Error("правка прошла проверку");
}

describe("правка из кабинета: разбор тела", () => {
  it("неизвестный ключ и неверные поля — 422 со всеми именами", () => {
    expect(invalid({ slug: "x", name: "A" })).toEqual(expect.arrayContaining(["slug", "name"]));
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

describe("правка из кабинета: вместимость, район и адрес", () => {
  it("ключи принимаются, адрес можно убрать пустой строкой", () => {
    const values = revisionFromBody(
      { cap_min: 100, cap_max: 350, district_code: "sergeli", address_ru: " ул. Навои, 1 ", address_uz: "" },
      "hall",
    );
    expect(values.fields).toEqual({
      cap_min: 100,
      cap_max: 350,
      district_code: "sergeli",
      address_ru: "ул. Навои, 1",
      address_uz: "",
    });
  });

  it("«до» меньше «от», вне 1–5000, не число, null — ошибка поля", () => {
    expect(invalid({ cap_min: 300, cap_max: 100 })).toEqual(["cap_max"]);
    expect(invalid({ cap_max: 0 })).toEqual(["cap_max"]);
    expect(invalid({ cap_max: 5001 })).toEqual(["cap_max"]);
    expect(invalid({ cap_min: "80" })).toEqual(["cap_min"]);
    expect(invalid({ cap_max: null })).toEqual(["cap_max"]);
    expect(invalid({ district_code: null })).toEqual(["district_code"]);
    expect(invalid({ district_code: "" })).toEqual(["district_code"]);
  });

  it("вместимость — только у категорий с guest_capacity, район — с district", () => {
    expect(invalid({ cap_min: 1, cap_max: 5, district_code: "sergeli" }, "car")).toEqual([
      "cap_min",
      "cap_max",
      "district_code",
    ]);
    // Студия: район есть, вместимости нет
    expect(revisionFromBody({ district_code: "sergeli" }, "studio").fields.district_code).toBe("sergeli");
    expect(invalid({ cap_max: 5 }, "studio")).toEqual(["cap_max"]);
  });

  it("предложение в базе читается так же: не та категория — не проходит проверку", () => {
    expect(parseRevision({ cap_max: 350 }, "hall").valid).toBe(true);
    expect(parseRevision({ cap_max: 350 }, "car").valid).toBe(false);
    expect(parseRevision({ cap_min: 400, cap_max: 350 }, "hall").valid).toBe(false);
  });
});

describe("правка из кабинета: что изменилось", () => {
  it("совпадает с карточкой — в правку не попадает; пустой адрес при пустом адресе — тоже", () => {
    const values = revisionFromBody(
      { cap_min: 80, cap_max: 300, district_code: "chilonzor", address_ru: "", address_uz: "" },
      "hall",
    );
    expect(changedOnly(values, LISTING)).toEqual({});
  });

  it("изменённые вместимость, район и адрес — в правке", () => {
    const values = revisionFromBody(
      { cap_max: 350, district_code: "sergeli", address_uz: "Navoiy k., 1" },
      "hall",
    );
    expect(changedOnly(values, LISTING)).toEqual({
      cap_max: 350,
      district_code: "sergeli",
      address_uz: "Navoiy k., 1",
    });
  });

  it("поля правки для панели: вместимость — одна строка на два ключа", () => {
    expect(revisionFields(["cap_min", "cap_max", "address_ru", "name", "district_code"])).toEqual([
      "name",
      "capacity",
      "districtCode",
      "addressRu",
    ]);
  });
});
