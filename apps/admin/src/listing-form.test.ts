import type { ListingDetail } from "@bayramm/shared/api/staff";
import {
  type CategoryConfig,
  categoryConfig,
  emptyListItem,
  type ListField,
} from "@bayramm/shared/categories";
import { describe, expect, it } from "vitest";
import { formErrors, formParts, formState, listingBody } from "./pages/ListingForm";

/* Форма витрины по категории: что спрашивать, что уходит в правку (только изменённое) и
   какие ошибки видны до отправки — те же пути, что в ответе 422 сервера. */

const cfg = (code: string): CategoryConfig => {
  const category = categoryConfig(code);
  if (!category) throw new Error(code);
  return category;
};

const listing = (categoryCode: string, extra: Partial<ListingDetail> = {}): ListingDetail => ({
  id: "bbbbbbbb-0000-0000-0000-000000000001",
  slug: "v",
  categoryCode,
  status: "draft",
  statusReason: null,
  statusChangedAt: null,
  name: "Витрина",
  districtCode: null,
  addressRu: null,
  addressUz: null,
  descriptionRu: null,
  descriptionUz: null,
  priceFromUzs: null,
  priceUnit: "per_event",
  capMin: null,
  capMax: null,
  submittedAt: null,
  publishedAt: null,
  version: 3,
  createdAt: "2026-10-01T07:00:00Z",
  updatedAt: "2026-10-01T07:00:00Z",
  hasPhone: false,
  attributes: {},
  missingAttributes: [],
  videoLinks: [],
  parallelCapacity: 1,
  services: [],
  photos: [],
  blockers: { review: [], active: [] },
  vendor: { id: "aaaaaaaa-0000-0000-0000-000000000001", code: "V101", name: "Lola" },
  history: [],
  pendingRevision: null,
  ...extra,
});

describe("что спрашивает форма витрины", () => {
  it("площадка — вместимость; фото — видео и заказы одновременно; торты — ничего лишнего", () => {
    expect(formParts(cfg("hall"))).toEqual({ capacity: true, videos: false, parallel: false });
    expect(formParts(cfg("photo"))).toEqual({ capacity: false, videos: true, parallel: true });
    expect(formParts(cfg("car"))).toEqual({ capacity: false, videos: false, parallel: true });
    expect(formParts(cfg("cake"))).toEqual({ capacity: false, videos: false, parallel: false });
  });

  it("видео: сохранённые ссылки и пустое поле для новой, пока можно добавить", () => {
    const photo = cfg("photo");
    expect(formState(listing("photo"), photo).videos).toEqual([""]);
    const three = ["a", "b", "c"].map((x) => `https://youtu.be/${x.repeat(11)}`);
    expect(formState(listing("photo", { videoLinks: three }), photo).videos).toEqual(three);
  });
});

describe("правка витрины — только изменённое", () => {
  it("без правок — пустое тело", () => {
    const car = cfg("car");
    const state = formState(listing("car"), car);
    expect(listingBody(car, state, state)).toEqual({});
  });

  it("кортеж: машина в автопарке, где работает, заказы одновременно", () => {
    const car = cfg("car");
    const before = formState(listing("car"), car);
    const fleet = car.attributes.find((a) => a.key === "fleet") as ListField;
    const now = {
      ...before,
      values: { ...before.values, parallelCapacity: "3" },
      attributes: {
        ...before.attributes,
        fleet: [{ ...emptyListItem(fleet), model: "Malibu", class: "sedan" }],
        service_area: "tashkent",
      },
    };
    expect(listingBody(car, now, before)).toEqual({
      attributes: { fleet: [{ model: "Malibu", class: "sedan" }], service_area: "tashkent" },
      parallelCapacity: 3,
    });
    expect(formErrors(car, now)).toEqual([]);
  });

  it("площадка: вместимость числами; у торта вместимость не уходит", () => {
    const hall = cfg("hall");
    const before = formState(listing("hall"), hall);
    const now = { ...before, values: { ...before.values, capMin: "50", capMax: "300", name: "Navruz" } };
    expect(listingBody(hall, now, before)).toEqual({ name: "Navruz", capMin: 50, capMax: 300 });
    const cake = cfg("cake");
    const cakeBefore = formState(listing("cake"), cake);
    expect(
      listingBody(cake, { ...cakeBefore, values: { ...cakeBefore.values, capMax: "10" } }, cakeBefore),
    ).toEqual({});
  });

  it("фото: видео целиком, без пустых полей", () => {
    const photo = cfg("photo");
    const before = formState(listing("photo"), photo);
    const now = { ...before, videos: ["https://youtu.be/dQw4w9WgXcQ", ""] };
    expect(listingBody(photo, now, before)).toEqual({ videoLinks: ["https://youtu.be/dQw4w9WgXcQ"] });
  });
});

describe("ошибки до отправки", () => {
  it("число мест не числом, ссылка не на YouTube и Instagram, заказов одновременно 0", () => {
    const car = cfg("car");
    const before = formState(listing("car"), car);
    const fleet = car.attributes.find((a) => a.key === "fleet") as ListField;
    const now = {
      ...before,
      values: { ...before.values, parallelCapacity: "0" },
      attributes: {
        ...before.attributes,
        fleet: [{ ...emptyListItem(fleet), model: "M", class: "sedan", seats: "x" }],
      },
    };
    expect(formErrors(car, now).sort()).toEqual(["attributes.fleet.0.seats", "parallelCapacity"]);

    const photo = cfg("photo");
    const photoBefore = formState(listing("photo"), photo);
    // Номер ошибки — в отправленном списке: пустое поле не отправляется
    expect(formErrors(photo, { ...photoBefore, videos: ["", "https://example.com/x"] })).toEqual([
      "videoLinks.0",
    ]);
  });
});
