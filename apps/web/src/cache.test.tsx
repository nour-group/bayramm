// @vitest-environment jsdom
import type { CatalogPage } from "@bayramm/shared/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CACHE_TTL, catalogKey, withCache } from "./api/cache";
import { ApiError } from "./api/errors";
import { createMockApi } from "./api/mock";
import type { ClientApi } from "./api/types";
import { LANG_KEY } from "./context";
import { scrollWhenReady } from "./scroll";
import {
  byText,
  cleanup,
  click,
  field,
  LISTINGS,
  mount,
  NOW,
  pickDate,
  settle,
  type,
  waitFor,
} from "./test/harness";

/* Кэш публичных ответов вкладки (api/cache.ts) и что он даёт экранам: один запрос на всех,
   «назад» в каталог — сразу с той же выдачей и прокруткой, витрина заранее при наведении. */

/** Демо-API, который считает вызовы своих методов */
function counted(api: ClientApi = createMockApi({ now: () => NOW, listings: LISTINGS })) {
  const calls: Record<string, number> = {};
  const wrapped = Object.fromEntries(
    Object.entries(api).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (...args: unknown[]) => {
            calls[name] = (calls[name] ?? 0) + 1;
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value,
    ]),
  ) as unknown as ClientApi;
  return { api: wrapped, calls };
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const PAGE: CatalogPage = { items: [], nextCursor: null };

describe("withCache", () => {
  it("один запрос на всех, пока ответ в пути; потом — из кэша до конца срока", async () => {
    let now = 0;
    const pending = deferred<CatalogPage>();
    const catalog = vi.fn(() => pending.promise);
    const api = withCache({ ...createMockApi(), catalog }, () => now);
    const a = api.catalog({ category: "car" });
    const b = api.catalog({ category: "car", limit: undefined });
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(api.peek?.catalog({ category: "car" })).toBeUndefined();
    pending.resolve(PAGE);
    await expect(Promise.all([a, b])).resolves.toEqual([PAGE, PAGE]);
    expect(api.peek?.catalog({ category: "car" })).toBe(PAGE);
    now += CACHE_TTL.catalog;
    await api.catalog({ category: "car" });
    expect(catalog).toHaveBeenCalledTimes(1);
    now += 1;
    expect(api.peek?.catalog({ category: "car" })).toBeUndefined();
    await api.catalog({ category: "car" });
    expect(catalog).toHaveBeenCalledTimes(2);
  });

  it("ошибка в кэше не остаётся: следующий вызов спрашивает заново", async () => {
    const listing = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(500, "internal_error"))
      .mockResolvedValue(LISTINGS[0]);
    const api = withCache({ ...createMockApi(), listing });
    await expect(api.listing("lola-zali")).rejects.toThrow("internal_error");
    await expect(api.listing("lola-zali")).resolves.toBe(LISTINGS[0]);
    expect(listing).toHaveBeenCalledTimes(2);
  });

  it("экран ушёл — его ожидание отменено, а общий запрос и ответ остальным — нет", async () => {
    const pending = deferred<{ items: [] }>();
    const catalogCategories = vi.fn(() => pending.promise);
    const api = withCache({ ...createMockApi(), catalogCategories });
    const gone = new AbortController();
    const first = api.catalogCategories(gone.signal);
    const second = api.catalogCategories();
    gone.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    pending.resolve({ items: [] });
    await expect(second).resolves.toEqual({ items: [] });
    expect(api.peek?.catalogCategories()).toEqual({ items: [] });
    expect(catalogCategories).toHaveBeenCalledTimes(1);
  });

  it("личное — мимо кэша; тексты согласий — из кэша, пока форма не скажет «текст сменился»", async () => {
    const { api: raw, calls } = counted();
    const api = withCache(raw);
    await api.myRequests();
    await api.myRequests();
    expect(calls.myRequests).toBe(2);
    await api.consentTexts("ru");
    await api.consentTexts("ru");
    expect(calls.consentTexts).toBe(1);
    expect(api.peek?.consentTexts("ru")?.items).toHaveLength(3);
    expect(api.peek?.consentTexts("uz")).toBeUndefined();
    api.peek?.forgetConsentTexts();
    expect(api.peek?.consentTexts("ru")).toBeUndefined();
    await api.consentTexts("ru");
    expect(calls.consentTexts).toBe(2);
  });

  it("ключ выдачи не зависит от порядка параметров и пустых значений", () => {
    expect(catalogKey({ category: "car", filters: { "a.decoration": "1" }, limit: 20 })).toBe(
      catalogKey({ limit: 20, date: undefined, filters: { "a.decoration": "1" }, category: "car" }),
    );
    expect(catalogKey({ category: "car" })).not.toBe(catalogKey({ category: "cake" }));
  });
});

describe("кэш на экранах", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.sessionStorage.setItem(LANG_KEY, "ru");
    window.scrollTo = () => {};
  });
  afterEach(cleanup);

  it("лендинг: категории, бот и способы входа — по одному запросу на всех", async () => {
    const { api, calls } = counted();
    await mount({ path: "/", identity: "guest", api: withCache(api) });
    await waitFor(() => document.querySelectorAll(".ln-cards .card").length === 4, "витрины");
    await settle();
    // Сетка разделов и витрины лендинга спрашивают категории; подвал и блок партнёров — бот и вход
    expect(calls.catalogCategories).toBe(1);
    expect(calls.bot).toBe(1);
    expect(calls.authMethods ?? 0).toBeLessThanOrEqual(1);
  });

  it("витрина → форма заявки: карточка витрины не запрашивается второй раз, заглушки нет", async () => {
    const { api, calls } = counted();
    const venue = LISTINGS[0];
    await mount({ path: `/venue/${venue?.slug}`, api: withCache(api) });
    await waitFor(() => document.querySelector("h1")?.textContent === venue?.name, "витрина");
    await click(document.querySelector(".venue-bar a.btn-primary"));
    await waitFor(() => document.querySelector("form.request"), "форма");
    expect(calls.listing).toBe(1);
  });

  it("тексты согласий — заранее с витрины; «текст сменился» на сервере — форма перечитывает их мимо кэша", async () => {
    let failed = false;
    const { api, calls } = counted(
      createMockApi({
        now: () => NOW,
        listings: LISTINGS,
        failWith: (method) => {
          if (method !== "createRequest" || failed) return null;
          failed = true;
          return new ApiError(409, "consent_text_not_current");
        },
      }),
    );
    const venue = LISTINGS[0];
    await mount({ path: `/venue/${venue?.slug}`, api: withCache(api) });
    await waitFor(() => document.querySelector(".venue-head h1"), "витрина");
    // Витрина просит их, когда уже на экране (через 300 мс) — не в ущерб своему первому кадру
    await new Promise((resolve) => setTimeout(resolve, 350));
    await waitFor(() => calls.consentTexts === 1, "тексты согласий заранее");
    await click(document.querySelector(".venue-bar a.btn-primary"));
    const transfer = () =>
      byText<HTMLLabelElement>("label.consent-check", /Разрешаю передать/)?.querySelector("input") ?? null;
    await waitFor(() => transfer(), "форма");
    expect(calls.consentTexts).toBe(1);
    await click(byText("label.ui-radio", "Свадьба"));
    await pickDate(field("Дата события"), "15 окт");
    await type(field("Гостей"), "100");
    await type(field("Как к вам обращаться"), "Азиза");
    await type(field("Телефон"), "00 123 45 67");
    await click(transfer());
    await click(byText("button", "Отправить заявку"));
    await waitFor(() => byText(".form-error", /Текст согласия обновился/), "текст ошибки");
    await waitFor(() => calls.consentTexts === 2, "тексты перечитаны мимо кэша");
  });

  it("каталог → витрина → «назад»: та же выдача сразу, без запроса и заглушки; прокрутка на месте", async () => {
    const { api, calls } = counted();
    const scrolls: [number, number][] = [];
    window.scrollTo = ((x: number, y: number) => {
      scrolls.push([x, y]);
    }) as unknown as typeof window.scrollTo;
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 5000 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 640 });
    try {
      await mount({ path: "/catalog?guests=50", api: withCache(api) });
      await waitFor(() => document.querySelectorAll(".cards .card").length > 0, "выдача");
      const names = [...document.querySelectorAll(".card-name")].map((n) => n.textContent);
      expect(calls.catalog).toBe(1);

      // Наведение на карточку — витрина грузится заранее: при открытии запроса уже нет
      const link = document.querySelector<HTMLAnchorElement>(".cards .card-link");
      link?.dispatchEvent(new Event("pointerover", { bubbles: true }));
      link?.dispatchEvent(new Event("pointerenter", { bubbles: false }));
      await settle();
      expect(calls.listing).toBe(1);
      await click(link);
      await waitFor(() => document.querySelector(".venue-head h1"), "витрина");
      expect(calls.listing).toBe(1);
      expect(scrolls.at(-1)).toEqual([0, 0]);

      window.history.back();
      await waitFor(() => document.querySelector(".catalog .cards"), "каталог после «назад»");
      // Сразу та же выдача: ни заглушки, ни второго запроса
      expect(document.querySelector(".state-cards")).toBeNull();
      expect([...document.querySelectorAll(".card-name")].map((n) => n.textContent)).toEqual(names);
      expect(calls.catalog).toBe(1);
      await waitFor(() => scrolls.some(([, y]) => y === 640), "прокрутка на месте");
    } finally {
      Reflect.deleteProperty(document.documentElement, "scrollHeight");
      Reflect.deleteProperty(window, "scrollY");
    }
  });
});

describe("scrollWhenReady", () => {
  afterEach(() => {
    Reflect.deleteProperty(document.documentElement, "scrollHeight");
    vi.useRealTimers();
  });

  it("страница ещё короткая — ждёт, пока дорастёт; не дождалась — прокручивает по сроку", async () => {
    vi.useFakeTimers();
    const scrolls: number[] = [];
    window.scrollTo = ((_x: number, y: number) => {
      scrolls.push(y);
    }) as unknown as typeof window.scrollTo;
    let height = 0;
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      get: () => height,
    });
    const root = document.createElement("div");
    document.body.append(root);
    scrollWhenReady(900, root, 3000);
    expect(scrolls).toEqual([]);
    height = 5000;
    root.append(document.createElement("p"));
    await vi.advanceTimersByTimeAsync(0);
    expect(scrolls).toEqual([900]);

    height = 0;
    scrollWhenReady(1200, root, 3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(scrolls).toEqual([900, 1200]);
    root.remove();
  });

  it("отмена — ни прокрутки, ни ожидания", async () => {
    vi.useFakeTimers();
    const scrolls: number[] = [];
    window.scrollTo = ((_x: number, y: number) => {
      scrolls.push(y);
    }) as unknown as typeof window.scrollTo;
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 0 });
    const stop = scrollWhenReady(700, document.body, 3000);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(scrolls).toEqual([]);
  });
});
