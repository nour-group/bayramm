// @vitest-environment jsdom
// Фото витрины: выбрали больше, чем помещается до предела, — загружаются первые, а строка
// говорит, сколько из выбранных и какой предел; обложка и одобрение — всплывающей строкой.
// Сжатие в браузере подменено (в jsdom нет canvas): экраны test-setup уже загрузил, поэтому
// панель здесь загружается заново — после подмены.
import type { ListingDetail, StaffMe, StaffPhoto } from "@bayramm/shared/api/staff";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "./texts";

let App: ComponentType;

beforeAll(async () => {
  vi.doMock("@bayramm/media/browser", () => ({
    compressForUpload: async (file: File) => ({ blob: file, width: 1600, height: 1200 }),
  }));
  vi.resetModules();
  ({ App } = await import("./App"));
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TOKEN = "T".repeat(43);
const LISTING_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const VENDOR_ID = "aaaaaaaa-0000-0000-0000-000000000001";

const ADMIN: StaffMe = {
  id: "00000000-0000-0000-0000-00000000a001",
  role: "admin",
  displayName: "Test admin",
  username: null,
  permissions: ["catalog.read", "listings.write", "photos.moderate"],
  botLinked: true,
};

const photoId = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`;
const photo = (n: number, extra: Partial<StaffPhoto> = {}): StaffPhoto => ({
  id: photoId(n),
  key: `listings/${LISTING_ID}/${photoId(n)}.webp`,
  width: 1600,
  height: 1200,
  bytes: 200_000,
  sort: n,
  isCover: false,
  moderation: "pending",
  declineReason: null,
  createdAt: "2026-09-29T06:00:00.000Z",
  ...extra,
});

const LISTING: ListingDetail = {
  id: LISTING_ID,
  slug: "oqsaroy",
  categoryCode: "hall",
  status: "draft",
  statusReason: null,
  statusChangedAt: null,
  name: "Oqsaroy Hall",
  districtCode: "chilonzor",
  addressRu: null,
  addressUz: null,
  descriptionRu: "Описание",
  descriptionUz: "Tavsif",
  priceFromUzs: null,
  priceUnit: "per_guest",
  capMin: 50,
  capMax: 300,
  submittedAt: null,
  publishedAt: null,
  version: 3,
  createdAt: "2026-09-29T06:00:00.000Z",
  updatedAt: "2026-09-29T06:00:00.000Z",
  hasPhone: false,
  hasTelegram: false,
  attributes: {},
  missingAttributes: [],
  videoLinks: [],
  parallelCapacity: 1,
  services: [],
  photos: [photo(1, { isCover: true, moderation: "approved" }), photo(2)],
  blockers: { review: [], active: [] },
  vendor: { id: VENDOR_ID, code: "V101", name: "Oqsaroy" },
  history: [],
  pendingRevision: null,
  deleteBlocker: null,
};

let container: HTMLDivElement;
let root: Root;
let calls: string[];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockApi(maxPhotos: number) {
  window.sessionStorage.setItem("bayramm.admin.session", TOKEN);
  const handlers: Record<string, () => Response> = {
    "GET /api/staff/me": () => json(ADMIN),
    "GET /api/staff/dictionaries": () =>
      json({
        categories: [],
        districts: [],
        occasions: [],
        staff: [],
        settings: { minPhotos: 3, maxPhotos, slaHours: 12 },
      }),
    [`GET /api/staff/listings/${LISTING_ID}`]: () => json(LISTING),
    [`GET /api/staff/listings/${LISTING_ID}/availability`]: () =>
      json({ from: "2026-09-01", to: "2026-09-30", busy: [], version: 1 }),
    [`POST /api/staff/listings/${LISTING_ID}/photos`]: () => json(photo(9), 201),
    [`POST /api/staff/listings/${LISTING_ID}/photos/${photo(2).id}/cover`]: () => json(photo(2)),
    [`POST /api/staff/listings/${LISTING_ID}/photos/${photo(2).id}/moderation`]: () => json(photo(2)),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const key = `${init.method ?? "GET"} ${String(input)}`;
      calls.push(key);
      const found = Object.keys(handlers).find((k) => k === key || key.startsWith(`${k}?`));
      return found ? (handlers[found] as () => Response)() : new Response("{}", { status: 404 });
    }),
  );
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount(path: string) {
  window.history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
  await settle();
}

const button = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const toasts = () => document.querySelector(".ui-toasts")?.textContent ?? "";

beforeEach(() => {
  calls = [];
  window.scrollTo = () => {};
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("фото витрины", () => {
  it("выбрали больше предела — загружены первые; строка: сколько из выбранных и какой предел", async () => {
    mockApi(4);
    await mount(`/listings/${LISTING_ID}`);
    // Подтверждение «лиц нет» — без него файлы не выбрать
    await act(async () => container.querySelector<HTMLInputElement>(".upload input[type=checkbox]")?.click());
    const input = container.querySelector<HTMLInputElement>(".upload input[type=file]") as HTMLInputElement;
    const files = [1, 2, 3, 4, 5].map((n) => new File([`photo ${n}`], `${n}.jpg`, { type: "image/jpeg" }));
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
    await settle();
    // Предел 4, на витрине 2: ушли два первых, три — нет
    expect(calls.filter((c) => c === `POST /api/staff/listings/${LISTING_ID}/photos`)).toHaveLength(2);
    expect(container.textContent).toContain(t.photosOverLimit(2, 5, 4));
  });

  it("обложка и одобрение — всплывающей строкой: что сделали и с каким фото", async () => {
    mockApi(10);
    await mount(`/listings/${LISTING_ID}`);
    await act(async () => button(t.makeCover)?.click());
    await settle();
    expect(calls).toContain(`POST /api/staff/listings/${LISTING_ID}/photos/${photo(2).id}/cover`);
    expect(toasts()).toContain(t.toastCover(2));
    await act(async () => button(t.approve)?.click());
    await settle();
    expect(toasts()).toContain(t.toastPhotoApproved(2));
  });

  it("стрелки порядка — значками и на компьютере, с подписью «Фото N: раньше / позже»", async () => {
    mockApi(10);
    await mount(`/listings/${LISTING_ID}`);
    const earlier = container.querySelector(`button[aria-label="${t.moveEarlier(2)}"]`);
    expect(earlier?.querySelector("svg")).not.toBeNull();
    expect(earlier?.textContent).toBe("");
    expect(container.querySelector(`button[aria-label="${t.moveLater(1)}"]`)?.className).toContain(
      "btn-flip",
    );
  });
});
