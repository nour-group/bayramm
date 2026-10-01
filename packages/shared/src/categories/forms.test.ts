import { describe, expect, it } from "vitest";
import type { ListingService } from "../api/services";
import {
  attributeDrafts,
  attributeErrors,
  attributePatch,
  attributesOf,
  attributeText,
  type CategoryConfig,
  categoryConfig,
  chosenServices,
  detailRows,
  draftValue,
  emptyListItem,
  type ListField,
  missingAttributes,
  newOptionDraft,
  newServiceDraft,
  parseAmount,
  priceUnitLabel,
  serviceChangeRows,
  serviceDirty,
  serviceDraftOf,
  serviceErrors,
  serviceInput,
  videoLinkErrors,
  videoLinksValue,
} from "./index";

const cfg = (code: string): CategoryConfig => {
  const category = categoryConfig(code);
  if (category === undefined) throw new Error(`нет категории ${code}`);
  return category;
};
const car = cfg("car");
const photo = cfg("photo");
const cake = cfg("cake");
const studio = cfg("studio");
const fleet = car.attributes.find((a) => a.key === "fleet") as ListField;

describe("parseAmount", () => {
  it("читает суммы с пробелами и пустое", () => {
    expect(parseAmount("150 000")).toBe(150000);
    expect(parseAmount(" 1 200 ")).toBe(1200);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("12a")).toBeNaN();
    expect(parseAmount("-5")).toBeNaN();
  });
});

describe("поля витрины в форме", () => {
  it("пустая форма: каждое поле категории — пустым значением своего вида", () => {
    const drafts = attributeDrafts(car, {});
    expect(drafts.fleet).toEqual([]);
    expect(drafts.decoration).toBe(false);
    expect(drafts.service_area).toBe("");
    expect(drafts.min_order_hours).toBe("");
    expect(attributeDrafts(studio, {}).zones).toEqual({ ru: "", uz: "" });
    expect(attributeDrafts(photo, {}).team).toEqual([]);
  });

  it("сохранённое читается в форму и обратно без изменений — правка пустая", () => {
    const stored = {
      fleet: [{ model: "Chevrolet Malibu", class: "sedan", seats: 4 }],
      decoration: true,
      service_area: "tashkent",
    };
    const drafts = attributeDrafts(car, stored);
    expect(drafts.fleet).toEqual([
      { model: "Chevrolet Malibu", class: "sedan", color: "", seats: "4", year: "" },
    ]);
    expect(attributePatch(car, drafts, drafts)).toEqual({});
    expect(attributesOf(car, drafts)).toEqual(stored);
  });

  it("автопарк: новая машина, пустая строка не уходит, число — числом", () => {
    const before = attributeDrafts(car, {});
    const item = { ...emptyListItem(fleet), model: " Lexus LX ", class: "premium", seats: "7" };
    const drafts = { ...before, fleet: [item, emptyListItem(fleet)], service_area: "uzbekistan" };
    expect(attributePatch(car, drafts, before)).toEqual({
      fleet: [{ model: "Lexus LX", class: "premium", seats: 7 }],
      service_area: "uzbekistan",
    });
    expect(attributeErrors(car, drafts)).toEqual([]);
    expect(missingAttributes(car, attributesOf(car, drafts))).toEqual([]);
  });

  it("ошибки — пути как в ответе API: класс не выбран, мест не число", () => {
    const drafts = {
      ...attributeDrafts(car, {}),
      fleet: [{ ...emptyListItem(fleet), model: "Malibu", seats: "четыре" }],
    };
    expect(attributeErrors(car, drafts).sort()).toEqual([
      "attributes.fleet.0.class",
      "attributes.fleet.0.seats",
    ]);
  });

  it("убрать значение — null в правке; галочка «нет» — тоже null", () => {
    const before = attributeDrafts(car, { decoration: true, min_order_hours: 3, service_area: "tashkent" });
    const drafts = { ...before, decoration: false, min_order_hours: "" };
    expect(attributePatch(car, drafts, before)).toEqual({ decoration: null, min_order_hours: null });
  });

  it("фото-видео: несколько вариантов — в порядке конфигурации; торт: число и галочки", () => {
    const before = attributeDrafts(photo, {});
    const drafts = { ...before, team: ["drone_operator", "photographer"], delivery_days: "30" };
    expect(attributePatch(photo, drafts, before)).toEqual({
      team: ["photographer", "drone_operator"],
      delivery_days: 30,
    });
    const cakeDrafts = { ...attributeDrafts(cake, {}), cake_kinds: ["bento"], lead_days: "3", tasting: true };
    expect(attributeErrors(cake, cakeDrafts)).toEqual([]);
    expect(missingAttributes(cake, attributesOf(cake, cakeDrafts))).toEqual([]);
    expect(attributeErrors(cake, { ...cakeDrafts, lead_days: "400" })).toEqual(["attributes.lead_days"]);
  });

  it("текст на двух языках: пустой язык не уходит", () => {
    const zones = studio.attributes.find((a) => a.key === "zones");
    if (zones === undefined) throw new Error("нет поля zones");
    expect(draftValue(zones, { ru: " Белая зона ", uz: "" })).toEqual({ ru: "Белая зона" });
    expect(draftValue(zones, { ru: "", uz: "" })).toBeNull();
  });

  it("значение словами: варианты, список, да", () => {
    const team = photo.attributes.find((a) => a.key === "team");
    if (team === undefined) throw new Error("нет поля team");
    expect(attributeText("ru", team, ["photographer", "videographer"], "да")).toBe("Фотограф, Видеооператор");
    expect(attributeText("ru", fleet, [{ model: "Malibu", class: "sedan", seats: 4 }], "да")).toBe(
      "Malibu · Седан · 4",
    );
    const decoration = car.attributes.find((a) => a.key === "decoration");
    if (decoration === undefined) throw new Error("нет поля decoration");
    expect(attributeText("uz", decoration, true, "ha")).toBe("ha");
    expect(attributeText("ru", decoration, null, "да")).toBeNull();
  });
});

describe("ссылки на видео", () => {
  it("пустые строки не уходят; ошибка — номер поля в форме", () => {
    const drafts = ["", " https://youtu.be/dQw4w9WgXcQ ", "https://example.com/x"];
    expect(videoLinksValue(drafts)).toEqual(["https://youtu.be/dQw4w9WgXcQ", "https://example.com/x"]);
    expect(videoLinkErrors(photo, drafts)).toEqual([2]);
    expect(videoLinkErrors(photo, ["https://www.instagram.com/reel/Cabc123/"])).toEqual([]);
  });

  it("больше, чем можно категории, — все поля с ошибкой; у кортежа видео нет", () => {
    const four = Array.from({ length: 4 }, (_, i) => `https://youtu.be/dQw4w9WgXc${i}`);
    expect(videoLinkErrors(photo, four)).toEqual([0, 1, 2, 3]);
    expect(videoLinkErrors(car, ["https://youtu.be/dQw4w9WgXcQ"])).toEqual([0]);
  });
});

const SERVICE: ListingService = {
  id: "00000000-0000-4000-8000-00000000a001",
  type: "bride_car",
  status: "active",
  name: { ru: "Машина для молодожёнов", uz: "Kelin-kuyov mashinasi" },
  customName: false,
  priceUzs: 300000,
  priceUnit: "per_hour",
  minQty: 3,
  leadDays: null,
  includes: { ru: "Водитель" },
  options: [
    {
      id: "00000000-0000-4000-8000-00000000b001",
      code: "champagne",
      name: { ru: "Шампанское и вода", uz: "Shampan va suv" },
      priceUzs: 50000,
      priceUnit: "per_item",
    },
  ],
  sort: 0,
  proposal: null,
  decision: null,
  submittedAt: null,
  updatedAt: "2026-10-01T07:00:00Z",
};

describe("услуга в форме", () => {
  it("новая из каталога: единица — первая у типа; тело — с type", () => {
    const draft = newServiceDraft(car, "bride_car");
    if (draft === undefined) throw new Error("нет типа");
    expect(draft.priceUnit).toBe("per_hour");
    const filled = { ...draft, price: "300 000", minQty: "3" };
    expect(serviceInput(car, filled, { create: true })).toEqual({
      type: "bride_car",
      priceUzs: 300000,
      priceUnit: "per_hour",
      minQty: 3,
      options: [],
    });
    expect(serviceErrors(car, filled, { create: true })).toEqual([]);
    expect(newServiceDraft(car, "no_such")).toBeUndefined();
  });

  it("без цены и с чужой единицей — ошибки полей", () => {
    const draft = newServiceDraft(car, "bride_car");
    if (draft === undefined) throw new Error("нет типа");
    expect(serviceErrors(car, { ...draft, priceUnit: "per_kg" }, { create: true }).sort()).toEqual([
      "priceUnit",
      "priceUzs",
    ]);
  });

  it("«другая услуга»: название на двух языках обязательно", () => {
    const draft = newServiceDraft(cake, "other");
    if (draft === undefined) throw new Error("нет типа");
    const filled = { ...draft, price: "90000" };
    expect(serviceErrors(cake, filled, { create: true })).toEqual(["name"]);
    const named = { ...filled, nameRu: "Макаруны", nameUz: "Makarunlar" };
    expect(serviceErrors(cake, named, { create: true })).toEqual([]);
    expect(serviceInput(cake, named, { create: true }).name).toEqual({ ru: "Макаруны", uz: "Makarunlar" });
  });

  it("опция из шаблона: название из каталога, единица шаблона; цена — от вендора", () => {
    const option = newOptionDraft(car, "bride_car", "extra_hour");
    expect(option).toMatchObject({ code: "extra_hour", nameRu: "Дополнительный час", priceUnit: "per_hour" });
    const draft = newServiceDraft(car, "bride_car");
    if (draft === undefined) throw new Error("нет типа");
    const body = { ...draft, price: "300000", options: [option] };
    expect(serviceErrors(car, body, { create: true })).toEqual(["options.0.priceUzs"]);
    expect(
      serviceErrors(car, { ...body, options: [{ ...option, price: "100000" }] }, { create: true }),
    ).toEqual([]);
    expect(newOptionDraft(car, "bride_car")).toMatchObject({ nameRu: "", priceUnit: "per_hour" });
  });

  it("правка: без type, пустое — null; без изменений — не грязная", () => {
    const draft = serviceDraftOf(SERVICE);
    expect(draft).toMatchObject({ price: "300000", minQty: "3", includesRu: "Водитель", leadDays: "" });
    expect(serviceDirty(car, draft, draft)).toBe(false);
    const changed = { ...draft, price: "350000", minQty: "", includesRu: "" };
    expect(serviceDirty(car, changed, draft)).toBe(true);
    const body = serviceInput(car, changed, { create: false });
    expect(body).toMatchObject({ priceUzs: 350000, minQty: null, leadDays: null, includes: null });
    expect(body).not.toHaveProperty("type");
    expect(body.options?.[0]).toMatchObject({ id: SERVICE.options[0]?.id, code: "champagne" });
    expect(serviceErrors(car, changed, { create: false })).toEqual([]);
  });

  it("предложение правки: форма показывает предложенное, строки — было → стало", () => {
    const proposed: ListingService = {
      ...SERVICE,
      proposal: { changes: { priceUzs: 350000, minQty: null }, submittedAt: "2026-10-01T08:00:00Z" },
    };
    expect(serviceDraftOf(proposed)).toMatchObject({ price: "350000", minQty: "" });
    expect(serviceChangeRows(proposed)).toEqual([
      { field: "priceUzs", before: 300000, after: 350000 },
      { field: "minQty", before: 3, after: null },
    ]);
    expect(serviceChangeRows(SERVICE)).toEqual([]);
  });
});

describe("поля заявки для показа", () => {
  const details = {
    start_time: "10:00",
    hours: 4,
    cars_count: 2,
    car_class: "premium",
    services: [
      {
        id: SERVICE.id,
        type: "bride_car",
        name: SERVICE.name,
        priceUzs: 300000,
        priceUnit: "per_hour" as const,
        qty: 4,
        options: [],
      },
    ],
  };

  it("подписи и значения словами по порядку формы, без услуг", () => {
    expect(detailRows("ru", car, details)).toEqual([
      { key: "start_time", label: "Начало", value: "10:00" },
      { key: "hours", label: "Сколько часов", value: "4" },
      { key: "cars_count", label: "Сколько машин", value: "2" },
      { key: "car_class", label: "Класс машины", value: "Премиум" },
    ]);
    expect(chosenServices(car, details)).toHaveLength(1);
    expect(detailRows("ru", undefined, details)).toEqual([]);
  });

  it("да — только подпись; район — названием из справочника", () => {
    const rows = detailRows(
      "ru",
      cfg("gifts"),
      {
        quantity: 50,
        personalization: true,
        fulfillment: "delivery",
        delivery_district: "yunusobod",
      },
      (code) => (code === "yunusobod" ? "Юнусабад" : undefined),
    );
    expect(rows).toContainEqual({ key: "personalization", label: "Нужна именная надпись", value: null });
    expect(rows).toContainEqual({ key: "delivery_district", label: "Район доставки", value: "Юнусабад" });
  });

  it("единица цены словами", () => {
    expect(priceUnitLabel("ru", "per_kg")).toBe("за кг");
  });
});
