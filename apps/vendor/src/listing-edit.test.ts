import type { VendorListing } from "@bayramm/shared/api/vendor";
import { categoryConfig } from "@bayramm/shared/categories";
import { describe, expect, it } from "vitest";
import {
  basicsChanges,
  basicsErrors,
  basicsOf,
  capacityErrors,
  districtOptions,
  placeChanges,
  placeErrors,
  placeOf,
  savesDirectly,
  touchedGroups,
  videoErrorIndexes,
  videosChanges,
} from "./listing-edit";

const LISTING: VendorListing = {
  id: "aaaaaaaa-0000-0000-0000-000000000101",
  version: 3,
  slug: "lola",
  name: "Lola zali",
  status: "draft",
  statusReason: null,
  categoryCode: "hall",
  districtCode: "chilonzor",
  address: { ru: "ул. Навои, 1", uz: "" },
  description: { ru: "Большой зал", uz: "Katta zal" },
  priceFromUzs: null,
  priceUnit: "per_guest",
  capMin: 50,
  capMax: 300,
  attributes: {},
  missingAttributes: [],
  videoLinks: [],
  parallelCapacity: 1,
  daySessions: {
    mode: "parts",
    parts: ["morning", "day", "evening"],
    windows: {
      morning: { from: "06:00", to: "11:00" },
      day: { from: "12:00", to: "17:00" },
      evening: { from: "18:00", to: "24:00" },
    },
    custom: null,
    parallelCapacity: 1,
  },
  calendarVersion: 0,
  services: [],
  photos: [],
  phone: null,
  telegram: null,
  contactChange: null,
  blockers: [],
  reviewBlockers: [],
  photoLimits: { min: 3, max: 10 },
};

const hall = categoryConfig("hall");
const car = categoryConfig("car");
const studio = categoryConfig("studio");
const photo = categoryConfig("photo");

describe("группы и предложение", () => {
  it("ключи предложения → карточки-группы; вместимость — одна группа «Место»", () => {
    expect([...touchedGroups({ name: "A", cap_min: 1, cap_max: 5, address_uz: "x" })].sort()).toEqual([
      "basics",
      "place",
    ]);
    expect([...touchedGroups({ attributes: { stage: true }, video_links: [] })].sort()).toEqual([
      "attributes",
      "videos",
    ]);
    expect(touchedGroups(undefined).size).toBe(0);
  });

  it("сразу — пока витрины нет на сайте; предложением — на проверке, на сайте, приостановленная", () => {
    for (const status of ["lead", "draft", "rejected"] as const) expect(savesDirectly(status)).toBe(true);
    for (const status of ["review", "active", "suspended"] as const)
      expect(savesDirectly(status)).toBe(false);
  });
});

describe("только изменённое", () => {
  it("основное: пробелы по краям не изменение", () => {
    expect(basicsChanges(LISTING, basicsOf(LISTING))).toEqual({});
    expect(basicsChanges(LISTING, { ...basicsOf(LISTING), name: "  Lola zali " })).toEqual({});
    expect(
      basicsChanges(LISTING, { name: "Lola Grand", descriptionRu: "Большой зал", descriptionUz: "" }),
    ).toEqual({ name: "Lola Grand", descriptionUz: "" });
  });

  it("место: район, адрес, вместимость — каждое отдельно; числа — числами", () => {
    const values = placeOf(LISTING);
    expect(values).toMatchObject({ districtCode: "chilonzor", capMin: "50", capMax: "300" });
    expect(placeChanges(LISTING, hall, values)).toEqual({});
    expect(
      placeChanges(LISTING, hall, {
        ...values,
        districtCode: "sergeli",
        addressUz: " Navoiy k., 1 ",
        capMin: "80",
        capMax: "350",
      }),
    ).toEqual({ districtCode: "sergeli", addressUz: "Navoiy k., 1", capMin: 80, capMax: 350 });
    // Адрес можно стереть — пустая строка
    expect(placeChanges(LISTING, hall, { ...values, addressRu: "" })).toEqual({ addressRu: "" });
  });

  it("вместимость и район — только у категорий, где они есть", () => {
    const values = { ...placeOf(LISTING), districtCode: "sergeli", capMax: "999" };
    expect(placeChanges(LISTING, car, values)).toEqual({});
    // Студия: район есть, вместимости нет
    expect(placeChanges(LISTING, studio, values)).toEqual({ districtCode: "sergeli" });
  });

  it("стёртая вместимость не уходит (убрать её нельзя) — её показывает проверка", () => {
    const values = { ...placeOf(LISTING), capMax: "" };
    expect(placeChanges(LISTING, hall, values)).toEqual({});
    expect(capacityErrors(LISTING, values)).toEqual({ capMax: "capErrRange" });
  });

  it("видео: порядок и пустые поля не считаются изменением", () => {
    const withLinks = { ...LISTING, videoLinks: ["https://youtu.be/a"] };
    if (!photo) throw new Error("нет категории");
    expect(videosChanges(withLinks, photo, ["https://youtu.be/a", ""])).toEqual({});
    expect(videosChanges(withLinks, photo, ["https://youtu.be/a", "https://youtu.be/b"])).toEqual({
      videoLinks: ["https://youtu.be/a", "https://youtu.be/b"],
    });
    expect(videosChanges(withLinks, photo, [""])).toEqual({ videoLinks: [] });
    // Залы видео не принимают
    if (!hall) throw new Error("нет категории");
    expect(videosChanges(LISTING, { ...hall, maxVideoLinks: 0 }, ["https://youtu.be/a"])).toEqual({});
  });
});

describe("проверки до запроса", () => {
  it("вместимость: 1–5000, «до» не меньше «от»", () => {
    const check = (capMin: string, capMax: string) =>
      capacityErrors(LISTING, { ...placeOf(LISTING), capMin, capMax });
    expect(check("50", "300")).toEqual({});
    expect(check("300", "300")).toEqual({});
    expect(check("400", "100")).toEqual({ capMax: "capErrOrder" });
    expect(check("0", "100")).toEqual({ capMin: "capErrRange" });
    expect(check("50", "5001")).toEqual({ capMax: "capErrRange" });
    expect(check("50", "12.5")).toEqual({ capMax: "capErrRange" });
    // Диапазон сильнее порядка: сначала поправить число
    expect(check("0", "")).toEqual({ capMin: "capErrRange", capMax: "capErrRange" });
  });

  it("не было вместимости и не вписали — не ошибка (черновик можно сохранить)", () => {
    const empty = { ...LISTING, capMin: null, capMax: null };
    expect(capacityErrors(empty, { ...placeOf(empty), capMin: "", capMax: "" })).toEqual({});
    expect(placeErrors(empty, car, { ...placeOf(empty), capMax: "0" })).toEqual({});
  });

  it("адрес — не длиннее 300; название — 2–80", () => {
    expect(placeErrors(LISTING, hall, { ...placeOf(LISTING), addressRu: "я".repeat(301) })).toEqual({
      addressRu: "errAddressLong",
    });
    expect(basicsErrors({ ...basicsOf(LISTING), name: "A" }, false)).toEqual({ name: "errNameLength" });
    expect(basicsErrors({ ...basicsOf(LISTING), name: "я".repeat(81) }, false)).toEqual({
      name: "errNameLength",
    });
  });

  it("на проверке и на сайте описание не стереть, у черновика — можно", () => {
    const blank = { ...basicsOf(LISTING), descriptionUz: "  " };
    expect(basicsErrors(blank, false)).toEqual({});
    expect(basicsErrors(blank, true)).toEqual({ descriptionUz: "errDescriptionRequired" });
  });

  it("ссылка на видео из ответа сервера: videoLinks.N и video_links.N, весь список — все поля", () => {
    expect(videoErrorIndexes(["videoLinks.1", "name"], 3)).toEqual([1]);
    expect(videoErrorIndexes(["video_links.0"], 3)).toEqual([0]);
    expect(videoErrorIndexes(["videoLinks"], 2)).toEqual([0, 1]);
    expect(videoErrorIndexes(["name"], 2)).toEqual([]);
  });
});

describe("районы по городам", () => {
  const dictionaries = {
    cities: [
      { code: "tashkent", name: { ru: "Ташкент", uz: "Toshkent" } },
      { code: "samarkand", name: { ru: "Самарканд", uz: "Samarqand" } },
    ],
    districts: [
      { code: "chilonzor", name: { ru: "Чиланзар", uz: "Chilonzor" }, city: "tashkent" },
      { code: "registon", name: { ru: "Регистан", uz: "Registon" }, city: "samarkand" },
      { code: "orphan", name: { ru: "Без города", uz: "Shaharsiz" }, city: "nowhere" },
    ],
  };

  it("город — заголовок группы (выбрать нельзя), районы под ним с отступом; район без города — в конце", () => {
    expect(districtOptions(dictionaries, "ru")).toEqual([
      { value: "city:tashkent", label: "Ташкент", disabled: true },
      { value: "chilonzor", label: "Чиланзар", nested: true },
      { value: "city:samarkand", label: "Самарканд", disabled: true },
      { value: "registon", label: "Регистан", nested: true },
      { value: "orphan", label: "Без города" },
    ]);
    expect(districtOptions(dictionaries, "uz")[0]?.label).toBe("Toshkent");
  });

  it("справочника ещё нет — пустой список", () => {
    expect(districtOptions(null, "ru")).toEqual([]);
  });
});
