// @vitest-environment jsdom
// Что партнёр делает сам: фото (плитка, шторка действий, порядок и обложка, «×», подтверждение
// не отмечено заранее), отзыв витрины с проверки, контакты (сразу или запросом, отзыв запроса).
// Компоненты — отдельно от экрана; API — подменённый fetch.

import { compressForUpload } from "@bayramm/media/browser";
import type { VendorContactChange, VendorListing, VendorPhoto } from "@bayramm/shared/api/vendor";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vendorDict } from "./i18n";
import { VenueContacts } from "./VenueContacts";
import { photoMoves, VenuePhotos } from "./VenuePhotos";
import { WithdrawAction } from "./VenueWithdraw";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const t = vendorDict.ru;
const LISTING_ID = "aaaaaaaa-0000-0000-0000-000000000101";
const BASE = `/api/vendor/listings/${LISTING_ID}`;

const photo = (
  n: number,
  moderation: VendorPhoto["moderation"] = "approved",
  isCover = n === 1,
): VendorPhoto => ({
  id: `dddddddd-0000-0000-0000-${String(n).padStart(12, "0")}`,
  width: 1600,
  height: 1200,
  moderation,
  declineReason: moderation === "declined" ? "На фото виден человек" : null,
  isCover: isCover && moderation === "approved",
  src: `https://media.example/640/p${n}.webp`,
  srcSet: `https://media.example/320/p${n}.webp 320w`,
});

function listingOf(patch: Partial<VendorListing> = {}): VendorListing {
  return {
    id: LISTING_ID,
    version: 1,
    slug: "test-hall",
    name: "Test Hall",
    status: "active",
    statusReason: null,
    categoryCode: "hall",
    districtCode: "chilonzor",
    address: { ru: "Адрес", uz: "Manzil" },
    description: { ru: "Описание", uz: "Tavsif" },
    priceFromUzs: 150_000,
    priceUnit: "per_guest",
    capMin: 50,
    capMax: 300,
    photos: [photo(1), photo(2), photo(3), photo(4), photo(5, "pending")],
    phone: "+998901112233",
    telegram: "lola_zali",
    contactChange: null,
    blockers: [],
    reviewBlockers: [],
    photoLimits: { min: 3, max: 10 },
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
    ...patch,
  };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly headers: Headers;
}
let calls: Call[];
let answers: Record<string, (body: unknown) => { status?: number; body?: unknown }>;

beforeEach(() => {
  calls = [];
  answers = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "https://vendor.bayramm.uz");
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) : (init.body ?? undefined);
      calls.push({ method, path: url.pathname, body, headers: new Headers(init.headers) });
      const answer = answers[`${method} ${url.pathname}`]?.(body) ?? { status: 200, body: {} };
      const status = answer.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(answer.body ?? {}), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  vi.mocked(compressForUpload).mockReset();
  vi.mocked(compressForUpload).mockResolvedValue({
    blob: new Blob([new Uint8Array([9, 9, 9])], { type: "image/webp" }),
  } as Awaited<ReturnType<typeof compressForUpload>>);
});

let host = document.createElement("div");
let root: Root;

async function mount(ui: ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(ui));
}

afterEach(() => {
  if (host.isConnected) {
    act(() => root.unmount());
    host.remove();
  }
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => {});
}
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("элемент не найден");
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const sheet = () => document.querySelector('[role="dialog"], [role="alertdialog"]');
const buttonIn = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const label = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
/** Ввод в поле, как с клавиатуры: React слушает input */
async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error("поле не найдено");
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const calls_ = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe("photoMoves: что можно сделать с фото", () => {
  const photos = [photo(1), photo(2), photo(3), photo(4), photo(5, "pending")];
  const moves = (n: number) => photoMoves(photos, photos[n - 1] as VendorPhoto);
  const idOf = (n: number) => (photos[n - 1] as VendorPhoto).id;

  it("обложка не двигается; ждущее решения и отклонённое — только удалить", () => {
    expect(moves(1)).toMatchObject({ cover: false, start: false, earlier: false, later: false });
    expect(moves(5)).toMatchObject({ cover: false, start: false, earlier: false, later: false });
    const declined = photoMoves([photo(1), photo(2, "declined")], photo(2, "declined"));
    expect(declined).toMatchObject({ cover: false, earlier: false, later: false });
  });

  it("остальные: сразу после обложки — только «позже»; в конце — всё, кроме «позже»", () => {
    expect(moves(2)).toMatchObject({ cover: true, start: false, earlier: false, later: true });
    expect(moves(3)).toMatchObject({ cover: true, start: false, earlier: true, later: true });
    expect(moves(4)).toMatchObject({ cover: true, start: true, earlier: true, later: false });
  });

  it("порядок после шага — все одобренные, обложка первой, ждущее не входит", () => {
    expect(moves(4).order("start")).toEqual([idOf(1), idOf(4), idOf(2), idOf(3)]);
    expect(moves(4).order("earlier")).toEqual([idOf(1), idOf(2), idOf(4), idOf(3)]);
    expect(moves(2).order("later")).toEqual([idOf(1), idOf(3), idOf(2), idOf(4)]);
  });

  it("обложка в списке не помечена — первое фото двигается как любое, «в начало» — на его место", () => {
    const none = [photo(1, "approved", false), photo(2, "approved", false), photo(3, "approved", false)];
    const third = photoMoves(none, none[2] as VendorPhoto);
    expect(third).toMatchObject({ cover: true, start: true, earlier: true, later: false });
    expect(third.order("start").at(0)).toBe((none[2] as VendorPhoto).id);
  });
});

describe("фото: плитки и шторка действий", () => {
  const props = (patch: Partial<Parameters<typeof VenuePhotos>[0]> = {}) => ({
    listing: listingOf(),
    portfolio: false,
    t,
    owner: true,
    onChanged: vi.fn(async () => {}),
    ...patch,
  });

  it("у владельца плитка — кнопка, в углу «×»; обложка и ждущее фото подписаны, число и порядок — одной строкой", async () => {
    await mount(<VenuePhotos {...props()} />);
    expect(host.querySelectorAll(".photos li")).toHaveLength(5);
    expect(host.querySelectorAll("button.photo-tile")).toHaveLength(5);
    expect(host.querySelectorAll("button.photo-x")).toHaveLength(5);
    expect(label("Фото 2: действия")).not.toBeNull();
    expect(label("Удалить фото 2")).not.toBeNull();
    expect([...host.querySelectorAll(".photo-chip")].map((c) => c.textContent)).toEqual([
      "обложка",
      "на проверке",
    ]);
    expect(host.textContent).toContain("Нужно от 3, всего до 10.");
    // Ни «команда выбирает порядок», ни предупреждающей плашки
    expect(host.textContent).not.toContain("команда Bayramm");
    expect(host.querySelector(".notice-warn")).toBeNull();
  });

  it("сотрудник площадки: плитки — просто снимки, ни «×», ни загрузки", async () => {
    await mount(<VenuePhotos {...props({ owner: false })} />);
    expect(host.querySelectorAll(".photos img")).toHaveLength(5);
    expect(host.querySelector("button.photo-tile, button.photo-x, input")).toBeNull();
  });

  it("шторка: «Сделать обложкой» и «Переместить позже» у фото в середине; порядок уходит на сервер сразу", async () => {
    const onChanged = vi.fn(async () => {});
    answers[`PUT ${BASE}/photos/order`] = () => ({ body: { photos: [] } });
    await mount(<VenuePhotos {...props({ onChanged })} />);
    await click(label("Фото 3: действия"));
    const open = sheet();
    expect(open?.textContent).toContain("Фото 3");
    const texts = [...(open?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
    expect(texts).toEqual([
      "Сделать обложкой",
      "Переместить раньше",
      "Переместить позже",
      "Удалить",
      "Закрыть",
    ]);
    await click(buttonIn(open as Element, "Переместить позже"));
    const [order] = calls_("PUT", `${BASE}/photos/order`);
    expect(order?.body).toEqual({
      ids: [photo(1).id, photo(2).id, photo(4).id, photo(3).id],
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(sheet()).toBeNull();
  });

  it("«Сделать обложкой» — POST …/cover без тела; у обложки и ждущего фото такой кнопки нет", async () => {
    answers[`POST ${BASE}/photos/${photo(4).id}/cover`] = () => ({ body: { photos: [] } });
    await mount(<VenuePhotos {...props()} />);
    await click(label("Фото 4: действия"));
    await click(buttonIn(sheet() as Element, "Сделать обложкой"));
    expect(calls_("POST", `${BASE}/photos/${photo(4).id}/cover`)).toHaveLength(1);

    await click(label("Фото 1: действия"));
    expect([...(sheet()?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
      "Удалить",
      "Закрыть",
    ]);
    await click(buttonIn(sheet() as Element, "Закрыть"));

    await click(label("Фото 5: действия"));
    expect(sheet()?.textContent).toContain("Порядок и обложка — у фото, которые одобрила команда.");
    expect(buttonIn(sheet() as Element, "Сделать обложкой")).toBeUndefined();
  });

  it("не вышло — понятная ошибка в шторке, шторка остаётся", async () => {
    answers[`PUT ${BASE}/photos/order`] = () => ({
      status: 503,
      body: { error: { code: "service_unavailable", message: "x" } },
    });
    await mount(<VenuePhotos {...props()} />);
    await click(label("Фото 3: действия"));
    await click(buttonIn(sheet() as Element, "Переместить раньше"));
    expect(sheet()?.querySelector('[role="alert"]')?.textContent).toContain("Сервер временно недоступен");
  });

  it("«Удалить» в шторке и «×» ведут к одному подтверждению; удаление — DELETE", async () => {
    answers[`DELETE ${BASE}/photos/${photo(2).id}`] = () => ({ status: 204 });
    const onChanged = vi.fn(async () => {});
    await mount(<VenuePhotos {...props({ onChanged })} />);
    await click(label("Удалить фото 2"));
    expect(sheet()?.getAttribute("role")).toBe("alertdialog");
    expect(sheet()?.textContent).toContain("Удалить фото?");
    await click(buttonIn(sheet() as Element, "Отмена"));
    expect(calls_("DELETE", `${BASE}/photos/${photo(2).id}`)).toHaveLength(0);

    await click(label("Фото 2: действия"));
    await click(buttonIn(sheet() as Element, "Удалить"));
    expect(sheet()?.getAttribute("role")).toBe("alertdialog");
    await click(buttonIn(sheet() as Element, "Удалить"));
    expect(calls_("DELETE", `${BASE}/photos/${photo(2).id}`)).toHaveLength(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("отклонённое фото: причина одной строкой, без «удалите и загрузите»", async () => {
    await mount(
      <VenuePhotos {...props({ listing: listingOf({ photos: [photo(1), photo(2, "declined")] }) })} />,
    );
    const decline = host.querySelectorAll(".photo-decline");
    expect(decline).toHaveLength(1);
    expect(decline[0]?.textContent).toBe("Отклонено: На фото виден человек");
    expect(host.textContent).not.toContain("загрузите новое");
  });
});

describe("фото: подтверждение не отмечено заранее", () => {
  const fileInput = () => host.querySelector<HTMLInputElement>('input[type="file"]');
  const choose = async (files: File[]) => {
    const input = fileInput();
    if (!input) throw new Error("выбор файлов не найден");
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await settle();
  };
  const file = new File([new Uint8Array([1, 2, 3])], "a.jpg", { type: "image/jpeg" });

  it("no_people: одна галочка «На фото нет людей и лиц…», без неё файлы не выбрать; X-No-Faces", async () => {
    answers[`POST ${BASE}/photos`] = () => ({ status: 201, body: photo(9, "pending") });
    await mount(
      <VenuePhotos listing={listingOf()} portfolio={false} t={t} owner onChanged={async () => {}} />,
    );
    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(host.textContent).toContain(t.noFacesAck);
    expect(host.querySelector('input[type="radio"]')).toBeNull();
    expect(box?.checked).toBe(false);
    expect(fileInput()?.disabled).toBe(true);
    await click(box);
    expect(fileInput()?.disabled).toBe(false);
    await choose([file]);
    const [upload] = calls_("POST", `${BASE}/photos`);
    expect(upload?.headers.get("X-No-Faces")).toBe("1");
    expect(upload?.headers.get("X-Photo-Consent")).toBeNull();
    // Подтверждение — про выбранные фото: следующие — снова
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  });

  it("portfolio: «Что на фото» — «Лиц нет» / «Люди согласны», ничего не выбрано; от выбора — свой заголовок", async () => {
    answers[`POST ${BASE}/photos`] = () => ({ status: 201, body: photo(9, "pending") });
    await mount(<VenuePhotos listing={listingOf()} portfolio t={t} owner onChanged={async () => {}} />);
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    const group = host.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(host.textContent).toContain("Что на фото");
    const radios = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(2);
    expect(radios.map((r) => r.checked)).toEqual([false, false]);
    expect(fileInput()?.disabled).toBe(true);

    await click(radios[1]);
    expect(fileInput()?.disabled).toBe(false);
    await choose([file]);
    const [upload] = calls_("POST", `${BASE}/photos`);
    expect(upload?.headers.get("X-Photo-Consent")).toBe("1");
    expect(upload?.headers.get("X-No-Faces")).toBeNull();
    // После загрузки выбор сброшен
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((r) => r.checked)).toEqual(
      [false, false],
    );

    await click(host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0]);
    await choose([file]);
    const uploads = calls_("POST", `${BASE}/photos`);
    expect(uploads[1]?.headers.get("X-No-Faces")).toBe("1");
    expect(uploads[1]?.headers.get("X-Photo-Consent")).toBeNull();
  });
});

describe("«Отозвать с проверки»", () => {
  const review = listingOf({ status: "review" });

  it("кнопка → подтверждение → POST …/withdraw; витрина перечитывается", async () => {
    answers[`POST ${BASE}/withdraw`] = () => ({ body: listingOf({ status: "draft" }) });
    const onWithdrawn = vi.fn(async () => {});
    await mount(<WithdrawAction listing={review} t={t} owner onWithdrawn={onWithdrawn} />);
    await click(buttonIn(host, "Отозвать с проверки"));
    expect(sheet()?.getAttribute("role")).toBe("alertdialog");
    expect(sheet()?.textContent).toContain("Отозвать витрину с проверки?");
    await click(buttonIn(sheet() as Element, "Отмена"));
    expect(calls_("POST", `${BASE}/withdraw`)).toHaveLength(0);
    await click(buttonIn(host, "Отозвать с проверки"));
    await click(buttonIn(sheet() as Element, "Отозвать"));
    expect(calls_("POST", `${BASE}/withdraw`)).toHaveLength(1);
    expect(onWithdrawn).toHaveBeenCalledTimes(1);
    expect(sheet()).toBeNull();
  });

  it("уже не на проверке (409) — как отозвано: витрина перечитывается; другая ошибка — в подтверждении", async () => {
    answers[`POST ${BASE}/withdraw`] = () => ({
      status: 409,
      body: { error: { code: "illegal_transition", message: "x" } },
    });
    const onWithdrawn = vi.fn(async () => {});
    await mount(<WithdrawAction listing={review} t={t} owner onWithdrawn={onWithdrawn} />);
    await click(buttonIn(host, "Отозвать с проверки"));
    await click(buttonIn(sheet() as Element, "Отозвать"));
    expect(onWithdrawn).toHaveBeenCalledTimes(1);

    answers[`POST ${BASE}/withdraw`] = () => ({
      status: 503,
      body: { error: { code: "internal_error", message: "x" } },
    });
    await click(buttonIn(host, "Отозвать с проверки"));
    await click(buttonIn(sheet() as Element, "Отозвать"));
    expect(sheet()?.querySelector('[role="alert"]')?.textContent).toContain("Ошибка на сервере");
    expect(onWithdrawn).toHaveBeenCalledTimes(1);
  });

  it("сотрудник площадки кнопки не видит", async () => {
    await mount(<WithdrawAction listing={review} t={t} owner={false} onWithdrawn={async () => {}} />);
    expect(host.textContent).toBe("");
  });
});

describe("контакты витрины", () => {
  const props = (patch: Partial<Parameters<typeof VenueContacts>[0]> = {}) => ({
    listing: listingOf(),
    t,
    owner: true,
    onChanged: vi.fn(async () => {}),
    ...patch,
  });
  const fields = () => [...document.querySelectorAll<HTMLInputElement>("form.contacts-form input")];

  it("карточка: телефон и Telegram, «Изменить» — только владельцу", async () => {
    await mount(<VenueContacts {...props()} />);
    expect(host.textContent).toContain("+998 90 111 22 33");
    expect(host.textContent).toContain("@lola_zali");
    expect(buttonIn(host, "Изменить")).toBeDefined();
    act(() => root.unmount());
    host.remove();
    await mount(<VenueContacts {...props({ owner: false, listing: listingOf({ telegram: null }) })} />);
    expect(host.textContent).toContain("не указано");
    expect(buttonIn(host, "Изменить")).toBeUndefined();
    expect(host.querySelector("input")).toBeNull();
  });

  it("витрина вне сайта: «Сохранить», сразу; Telegram — @имя или ссылка, телефон — маской", async () => {
    answers[`PUT ${BASE}/contacts`] = () => ({
      body: { sentForModeration: false, listing: listingOf({ status: "draft" }) },
    });
    const onChanged = vi.fn(async () => {});
    await mount(<VenueContacts {...props({ listing: listingOf({ status: "draft" }), onChanged })} />);
    await click(buttonIn(host, "Изменить"));
    expect(sheet()?.textContent).toContain("Контакты витрины");
    expect(sheet()?.textContent).not.toContain("после проверки командой");
    const [phone, telegram] = fields();
    expect(phone?.value).toBe("90 111 22 33");
    expect(telegram?.value).toBe("lola_zali");
    await type(phone ?? null, "+998 91 222-33-44");
    expect(fields()[0]?.value).toBe("91 222 33 44");
    await type(telegram ?? null, "https://t.me/new_lola");
    expect(fields()[1]?.value).toBe("new_lola");
    await click(buttonIn(sheet() as Element, "Сохранить"));
    const [put] = calls_("PUT", `${BASE}/contacts`);
    expect(put?.body).toEqual({ phone: "+998912223344", telegram: "new_lola" });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(sheet()).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Контакты сохранены");
  });

  it("опубликованная: «Отправить изменения» и строка про проверку командой; Telegram можно убрать (null)", async () => {
    answers[`PUT ${BASE}/contacts`] = () => ({ body: { sentForModeration: true, listing: listingOf() } });
    await mount(<VenueContacts {...props()} />);
    await click(buttonIn(host, "Изменить"));
    expect(sheet()?.textContent).toContain("Клиенты увидят новые контакты после проверки командой Bayramm.");
    expect(buttonIn(sheet() as Element, "Сохранить")).toBeUndefined();
    await type(fields()[1] ?? null, "");
    await click(buttonIn(sheet() as Element, "Отправить изменения"));
    expect(calls_("PUT", `${BASE}/contacts`)[0]?.body).toEqual({ phone: "+998901112233", telegram: null });
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Отправлено на проверку команде Bayramm");
  });

  it("неполный номер и неверный Telegram — ошибки у полей, запроса нет", async () => {
    await mount(<VenueContacts {...props()} />);
    await click(buttonIn(host, "Изменить"));
    await type(fields()[0] ?? null, "90 12");
    await type(fields()[1] ?? null, "ab");
    await click(buttonIn(sheet() as Element, "Отправить изменения"));
    expect(calls_("PUT", `${BASE}/contacts`)).toHaveLength(0);
    const errors = [...(sheet()?.querySelectorAll(".field-error") ?? [])].map((e) => e.textContent);
    expect(errors).toEqual([
      "Номер — 9 цифр после +998",
      "5–32 знака: латиница, цифры и «_», с буквы и не на «_»",
    ]);
    expect(fields()[0]?.getAttribute("aria-invalid")).toBe("true");
  });

  it("чужой код страны: «только Узбекистан» сразу", async () => {
    await mount(<VenueContacts {...props()} />);
    await click(buttonIn(host, "Изменить"));
    await type(fields()[0] ?? null, "+7 912 345 67 89");
    expect(sheet()?.querySelector(".field-error")?.textContent).toBe(
      "Только номера Узбекистана: +998 и 9 цифр",
    );
  });

  it("ответ сервера: те же значения — «ничего не изменили»; неверное поле — у поля; витрина сменила статус — перечитать", async () => {
    const onChanged = vi.fn(async () => {});
    await mount(<VenueContacts {...props({ onChanged })} />);
    await click(buttonIn(host, "Изменить"));
    await type(fields()[1] ?? null, "other_name");

    answers[`PUT ${BASE}/contacts`] = () => ({
      status: 422,
      body: { error: { code: "no_changes", message: "x" } },
    });
    await click(buttonIn(sheet() as Element, "Отправить изменения"));
    expect(sheet()?.querySelector('[role="alert"]')?.textContent).toBe("Вы ничего не изменили.");

    answers[`PUT ${BASE}/contacts`] = () => ({
      status: 422,
      body: { error: { code: "invalid_input", message: "x", details: ["telegram"] } },
    });
    await click(buttonIn(sheet() as Element, "Отправить изменения"));
    expect(sheet()?.querySelector(".field-error")?.textContent).toContain("5–32 знака");

    answers[`PUT ${BASE}/contacts`] = () => ({
      status: 409,
      body: { error: { code: "contacts_not_live", message: "x" } },
    });
    await click(buttonIn(sheet() as Element, "Отправить изменения"));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(sheet()?.textContent).toContain("Статус витрины изменился");
  });

  const pending: VendorContactChange = {
    status: "pending",
    submittedAt: "2026-10-12T05:00:00Z",
    decidedAt: null,
    reason: null,
    phone: "+998912223344",
    telegram: null,
  };

  it("запрос ждёт: «на проверке» и новые значения, шторка вписывает их же; «Отозвать» — POST", async () => {
    answers[`POST ${BASE}/contact-change/withdraw`] = () => ({ body: listingOf() });
    const onChanged = vi.fn(async () => {});
    await mount(<VenueContacts {...props({ listing: listingOf({ contactChange: pending }), onChanged })} />);
    expect(host.querySelector(".contact-pending .chip")?.textContent).toBe("на проверке");
    expect(host.querySelector(".contact-pending-value")?.textContent).toBe("Новые: +998 91 222 33 44");
    // Нынешние контакты у клиентов прежние — их и показывает карточка
    expect(host.querySelector(".contact-rows")?.textContent).toContain("+998 90 111 22 33");
    await click(buttonIn(host, "Изменить"));
    expect(fields()[0]?.value).toBe("91 222 33 44");
    expect(fields()[1]?.value).toBe("");
    await click(buttonIn(sheet() as Element, "Отмена"));
    await click(buttonIn(host, "Отозвать"));
    expect(calls_("POST", `${BASE}/contact-change/withdraw`)).toHaveLength(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("сотрудник площадки видит только «на проверке» — без номеров и кнопок; отказ — с причиной", async () => {
    const none = { ...pending, phone: null, telegram: null };
    await mount(<VenueContacts {...props({ owner: false, listing: listingOf({ contactChange: none }) })} />);
    expect(host.querySelector(".contact-pending .chip")?.textContent).toBe("на проверке");
    expect(host.querySelector(".contact-pending-value")).toBeNull();
    expect(host.querySelector("button")).toBeNull();
    act(() => root.unmount());
    host.remove();
    const declined: VendorContactChange = {
      ...pending,
      status: "declined",
      reason: "Номер не зала",
      phone: null,
    };
    await mount(<VenueContacts {...props({ listing: listingOf({ contactChange: declined }) })} />);
    expect(host.textContent).toContain("Новые контакты отклонены: Номер не зала");
    expect(host.querySelector(".contact-pending")).toBeNull();
  });
});
