// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api/errors";
import { allDemoListings, createMockApi } from "./api/mock";
import { LANG_KEY } from "./context";
import { FAVORITES_KEY } from "./favorites";
import { byText, cleanup, click, LISTINGS, mount, NOW, text, waitFor } from "./test/harness";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.sessionStorage.setItem(LANG_KEY, "ru");
  window.scrollTo = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const [A, B, C] = LISTINGS;
if (!A || !B || !C) throw new Error("нет демо-площадок");

const heartOf = (name: string) =>
  document.querySelector<HTMLButtonElement>(`button.fav-btn[aria-label="Сохранить: ${name}"]`);
const stored = () => JSON.parse(window.localStorage.getItem(FAVORITES_KEY) ?? "[]") as string[];
const cardNames = () => [...document.querySelectorAll(".card .card-name")].map((el) => el.textContent);
const toast = () => document.querySelector(".ui-toasts")?.textContent ?? "";

describe("избранное гостя (без входа)", () => {
  it("сердечко на карточке: переключатель, список в браузере, уведомление — где искать список", async () => {
    await mount({ path: "/catalog", identity: "guest" });
    await waitFor(() => heartOf(A.name), "сердечко на карточке");
    const heart = heartOf(A.name);
    expect(heart?.getAttribute("aria-pressed")).toBe("false");
    // Кнопка — не внутри ссылки карточки
    expect(heart?.closest("a")).toBeNull();

    await click(heart);
    expect(heartOf(A.name)?.getAttribute("aria-pressed")).toBe("true");
    expect(stored()).toEqual([A.id]);
    // У гостя сайта вкладок нет: «Сохранённое» — раздел в шапке (на телефоне — в меню)
    expect(toast()).toContain(
      "Сохранили. Список — в разделе «Сохранённое» вверху страницы, входить не нужно.",
    );
    expect(toast()).not.toContain("вкладк");

    await click(heartOf(A.name));
    expect(heartOf(A.name)?.getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem(FAVORITES_KEY)).toBeNull();
  });

  it("раздел «Сохранённое» у гостя: в шапке рядом с каталогом, отмеченные карточки, снятое уходит сразу", async () => {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify([B.id, A.id]));
    await mount({ path: "/favorites", identity: "guest" });
    // Оболочка гостя: нижней панели нет, разделы — каталог и сохранённое (личного без входа нет)
    expect(document.querySelector("nav.tabs")).toBeNull();
    const sections = [...document.querySelectorAll("nav.site-nav a")].map((a) => a.textContent);
    expect(sections).toEqual(["Каталог", "Сохранённое"]);
    expect(document.querySelector('nav.site-nav a[aria-current="page"]')?.textContent).toBe("Сохранённое");
    expect(document.querySelector("h1")?.textContent).toBe("Сохранённое");
    await waitFor(() => cardNames().length === 2, "две карточки");
    expect(cardNames()).toEqual([B.name, A.name]);

    await click(heartOf(B.name));
    expect(cardNames()).toEqual([A.name]);
    expect(stored()).toEqual([A.id]);
  });

  it("пусто — объяснение из прототипа и ссылка в поиск", async () => {
    await mount({ path: "/favorites", identity: "guest" });
    await waitFor(() => document.querySelector(".state-empty"), "пустое состояние");
    expect(text()).toContain("Пока пусто");
    expect(text()).toContain("Нажимайте сердечко на карточках — список соберётся здесь. Входить не нужно.");
    expect(byText("a", "К поиску")?.getAttribute("href")).toBe("/catalog");
  });

  it("снятая с публикации площадка пропадает из списка без ошибки", async () => {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify([C.id, A.id]));
    await mount({ path: "/favorites", identity: "guest", mock: { hidden: [C.id] } });
    await waitFor(() => cardNames().length === 1, "одна карточка");
    expect(cardNames()).toEqual([A.name]);
    expect(document.querySelector('[role="alert"].state-error')).toBeNull();
  });

  it("битое значение в браузере — просто пустой список", async () => {
    window.localStorage.setItem(FAVORITES_KEY, "{not json");
    await mount({ path: "/favorites", identity: "guest" });
    await waitFor(() => document.querySelector(".state-empty"), "пустое состояние");
  });

  it("сотня уже есть — сто первую не добавить, уведомление", async () => {
    const hundred = Array.from(
      { length: 100 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(hundred));
    await mount({ path: "/catalog", identity: "guest" });
    await waitFor(() => heartOf(A.name), "сердечко");
    await click(heartOf(A.name));
    expect(heartOf(A.name)?.getAttribute("aria-pressed")).toBe("false");
    expect(toast()).toContain("уже 100 площадок");
    expect(stored()).toHaveLength(100);
  });
});

describe("избранное вошедшего", () => {
  it("сердечко на странице площадки — в аккаунт; вкладка показывает список с сервера", async () => {
    const api = createMockApi({ now: () => NOW, listings: LISTINGS });
    await mount({ path: `/venue/${A.slug}`, api });
    await waitFor(() => heartOf(A.name), "сердечко у названия");
    await click(heartOf(A.name));
    await waitFor(() => api.favoriteIds().includes(A.id), "отметка в аккаунте");
    expect(window.localStorage.getItem(FAVORITES_KEY)).toBeNull();
    expect(heartOf(A.name)?.getAttribute("aria-pressed")).toBe("true");
    // После входа — оболочка приложения: список во вкладке
    await waitFor(() => toast().includes("во вкладке «Сохранённое»"), "уведомление про вкладку");
  });

  it("в «Сохранённом» у карточек разных категорий подписана категория", async () => {
    const car = allDemoListings("2026-10-01").find((l) => l.categoryCode === "car");
    if (!car) throw new Error("нет демо-кортежа");
    const api = createMockApi({ now: () => NOW, listings: [...LISTINGS, car], favorites: [car.id, A.id] });
    await mount({ path: "/favorites", api });
    await waitFor(() => cardNames().length === 2, "две карточки");
    const metas = [...document.querySelectorAll(".card .card-meta")].map((el) => el.textContent);
    expect(metas[0]).toBe("Кортеж");
    expect(metas[1]).toContain("Площадка / Тойхона");
    // Цена кортежа — с единицей: за час
    expect(document.querySelector(".card .card-price")?.textContent).toContain("за час");
  });

  it("при входе гостевой список сливается с аккаунтом и из браузера стирается", async () => {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify([C.id]));
    const api = createMockApi({ now: () => NOW, listings: LISTINGS, favorites: [A.id] });
    await mount({ path: "/favorites", api });
    await waitFor(() => cardNames().length === 2, "обе карточки");
    expect(api.favoriteIds()).toEqual([A.id, C.id]);
    expect(window.localStorage.getItem(FAVORITES_KEY)).toBeNull();
  });

  it("отметка до ответа загрузки: поздний ответ её не затирает", async () => {
    // Две площадки с первой страницы каталога (дешевле всех)
    const [first, second] = [...LISTINGS].sort((x, y) => x.priceFromUzs - y.priceFromUzs);
    if (!first || !second) throw new Error("нет площадок");
    const api = createMockApi({ now: () => NOW, listings: LISTINGS, favorites: [second.id] });
    const real = api.favorites;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.favorites = async (signal) => {
      await gate;
      return real(signal);
    };
    await mount({ path: "/catalog", api });
    await waitFor(() => heartOf(first.name), "сердечко");
    await click(heartOf(first.name));
    release();
    await waitFor(() => heartOf(second.name)?.getAttribute("aria-pressed") === "true", "список с сервера");
    expect(heartOf(first.name)?.getAttribute("aria-pressed")).toBe("true");
    expect(api.favoriteIds()).toEqual([first.id, second.id]);
  });

  it("не сохранилось на сервере — отметка возвращается, уведомление об ошибке", async () => {
    const api = createMockApi({
      now: () => NOW,
      listings: LISTINGS,
      failWith: (method) => (method === "addFavorite" ? new ApiError(409, "favorites_full") : null),
    });
    await mount({ path: "/catalog", api });
    await waitFor(() => heartOf(A.name), "сердечко");
    await click(heartOf(A.name));
    await waitFor(() => heartOf(A.name)?.getAttribute("aria-pressed") === "false", "отметка вернулась");
    expect(toast()).toContain("уже 100 площадок");
  });

  it("удаление аккаунта: в выгрузке было избранное, после — его нет", async () => {
    const api = createMockApi({ now: () => NOW, listings: LISTINGS, favorites: [A.id] });
    expect((await api.exportMyData()).favorites.map((f) => f.listing.id)).toEqual([A.id]);
    await api.deleteAccount();
    expect(api.favoriteIds()).toEqual([]);
  });
});
