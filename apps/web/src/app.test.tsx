// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "./api/errors";
import { createMockApi, demoRequests } from "./api/mock";
import { LANG_KEY } from "./context";
import {
  byText,
  cleanup,
  click,
  fakeWebApp,
  LISTINGS,
  mount,
  NOW,
  settle,
  text,
  type,
  waitFor,
} from "./test/harness";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  // Язык браузера в jsdom — английский, приложение взяло бы узбекский; тексты проверяем по-русски
  window.sessionStorage.setItem(LANG_KEY, "ru");
  window.scrollTo = () => {};
});

afterEach(cleanup);

const VENUE = LISTINGS[0];
if (!VENUE) throw new Error("нет демо-площадки");

describe("каталог", () => {
  it("фильтры живут в адресе и уходят в запрос", async () => {
    await mount({ path: "/?guests=200&district=chilonzor" });
    await waitFor(() => document.querySelectorAll(".card").length > 0, "карточки");
    const guests = document.querySelector<HTMLInputElement>('input[type="number"]');
    expect(guests?.value).toBe("200");
    const district = document.querySelector<HTMLSelectElement>("select");
    expect(district?.value).toBe("chilonzor");
    for (const card of document.querySelectorAll(".card")) expect(card.textContent).toContain("Чиланзар");

    await type(district, "");
    await waitFor(() => !window.location.search.includes("district"), "район снят");
    expect(window.location.search).toBe("?guests=200");
  });

  it("лента догружается по курсору, без повторов", async () => {
    await mount({ path: "/" });
    await waitFor(() => document.querySelectorAll(".card").length === 20, "первая страница");
    await click(byText("button", "Показать ещё"));
    await waitFor(() => document.querySelectorAll(".card").length === LISTINGS.length, "вторая страница");
    const names = [...document.querySelectorAll(".card-name")].map((n) => n.textContent);
    expect(new Set(names).size).toBe(names.length);
    expect(byText("button", "Показать ещё")).toBeNull();
  });

  it("ошибка загрузки — «Повторить», затем выдача", async () => {
    let fail = true;
    await mount({
      mock: { failWith: (method) => (fail && method === "catalog" ? new ApiError(0, "network") : null) },
    });
    await waitFor(() => byText("button", "Повторить"), "ошибка");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Не удалось загрузить");
    fail = false;
    await click(byText("button", "Повторить"));
    await waitFor(() => document.querySelectorAll(".card").length > 0, "карточки после повтора");
  });

  it("пусто — объяснение и сброс фильтров", async () => {
    await mount({ path: "/?guests=5000" });
    await waitFor(() => byText("h2", "Под эти условия никого"), "пустое состояние");
    await click(byText("button", "Сбросить фильтры"));
    await waitFor(() => document.querySelectorAll(".card").length > 0, "карточки после сброса");
    expect(window.location.search).toBe("");
  });

  it("площадок ещё нет — «скоро появятся», без сброса фильтров", async () => {
    await mount({ mock: { listings: [] } });
    await waitFor(() => byText("h2", "Залы скоро появятся"), "пустой каталог без фильтров");
    expect(document.body.textContent).not.toContain("Под эти условия никого");
    expect(document.body.textContent).not.toContain("Сбросить фильтры");
  });

  it("у выпадающих списков своя стрелка", async () => {
    await mount();
    await waitFor(() => document.querySelectorAll(".card").length > 0, "каталог");
    const selects = [...document.querySelectorAll("select")];
    expect(selects.length).toBeGreaterThanOrEqual(2);
    for (const select of selects) {
      expect(select.parentElement?.classList.contains("select")).toBe(true);
      expect(select.parentElement?.querySelector(".select-caret")).not.toBeNull();
    }
  });

  it("карточка ведёт на площадку и передаёт дату и гостей", async () => {
    await mount({ path: "/?date=2026-10-20&guests=100" });
    const link = await waitFor(() => document.querySelector<HTMLAnchorElement>(".card-link"), "карточка");
    expect(link.getAttribute("href")).toMatch(/^\/venue\/[a-z0-9-]+\?date=2026-10-20&guests=100$/);
  });
});

describe("площадка", () => {
  it("несуществующая — «не найдена» со ссылкой в каталог", async () => {
    await mount({ path: "/venue/net-takoy" });
    await waitFor(() => byText("h1", "Площадка не найдена"), "404");
    expect(byText<HTMLAnchorElement>("a", "В каталог")?.getAttribute("href")).toBe("/");
  });

  it("фото — варианты с воркера media, первое без ленивой загрузки", async () => {
    await mount({ path: `/venue/${VENUE.slug}` });
    const images = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLImageElement>(".gallery img")];
      return found.length ? found : null;
    }, "галерея");
    expect(images).toHaveLength(VENUE.photos.length);
    expect(images[0]?.getAttribute("srcset")).toContain("https://media.bayramm.uz/320/listings/");
    expect(images[0]?.getAttribute("loading")).toBe("eager");
    expect(images[1]?.getAttribute("loading")).toBe("lazy");
    expect(images[0]?.getAttribute("alt")).toBe(`${VENUE.name}, фото 1 из ${VENUE.photos.length}`);
  });
});

describe("Telegram", () => {
  it("start_param vendor_<slug> открывает площадку; «назад» ведёт в каталог", async () => {
    const { webApp, calls, press } = fakeWebApp({
      initDataUnsafe: { start_param: `vendor_${VENUE.slug}`, user: { id: 1, first_name: "A" } },
    });
    await mount({ path: "/", identity: "telegram", webApp });
    await waitFor(() => document.querySelector("h1")?.textContent === VENUE.name, "площадка из ссылки");
    expect(window.location.pathname).toBe(`/venue/${VENUE.slug}`);
    expect(calls).toContain("BackButton.show");
    // Своя «назад» не нужна, когда есть кнопка Telegram
    expect(document.querySelector("button.back")).toBeNull();
    // Главная кнопка Telegram — «Оставить заявку», своя на странице не рисуется
    expect(calls).toContain("MainButton.setText:Оставить заявку");
    expect(calls).toContain("MainButton.show");
    expect(byText(".venue-bar a", "Оставить заявку")).toBeNull();

    await click(document.body);
    press("MainButton");
    await settle();
    await waitFor(() => window.location.pathname === `/venue/${VENUE.slug}/request`, "форма заявки");
    // С карточки ушли — главная кнопка спрятана и отписана
    expect(calls).toContain("MainButton.offClick");
    expect(calls.lastIndexOf("MainButton.hide")).toBeGreaterThan(calls.lastIndexOf("MainButton.show"));
    // Имя подставлено из Telegram
    await waitFor(
      () => document.querySelector<HTMLInputElement>('input[autocomplete="name"]')?.value === "A",
      "имя",
    );
  });

  it("галочка уведомлений спрашивает у Telegram разрешение писать; отказ её снимает", async () => {
    const asked: string[] = [];
    let answer = true;
    const { webApp } = fakeWebApp({
      requestWriteAccess: (callback) => {
        asked.push("requestWriteAccess");
        callback?.(answer);
      },
    });
    await mount({ path: `/venue/${VENUE.slug}/request`, identity: "telegram", webApp });
    const notify = await waitFor(
      () => byText<HTMLLabelElement>("label.consent-check", /Присылать ответ/)?.querySelector("input"),
      "галочка уведомлений",
    );
    await click(notify);
    expect(asked).toEqual(["requestWriteAccess"]);
    expect(notify.checked).toBe(true);

    await click(notify);
    answer = false;
    await click(notify);
    expect(asked).toHaveLength(2);
    expect(notify.checked).toBe(false);
  });

  it("старый клиент без методов не ломает приложение", async () => {
    const webApp = { initData: "x=1", initDataUnsafe: {} };
    await mount({ path: `/venue/${VENUE.slug}`, identity: "telegram", webApp });
    await waitFor(() => document.querySelector("h1")?.textContent === VENUE.name, "площадка");
    // Нет BackButton и MainButton — свои кнопки на странице
    expect(document.querySelector("button.back")).not.toBeNull();
    expect(byText(".venue-bar a", "Оставить заявку")).not.toBeNull();
  });
});

describe("мои заявки", () => {
  const requests = demoRequests(LISTINGS, NOW);

  it("статусы, срок ответа, просрочка с похожими, причина отказа", async () => {
    await mount({ path: "/requests", mock: { requests } });
    await waitFor(() => document.querySelectorAll(".req").length === requests.length, "заявки");
    const items = [...document.querySelectorAll(".req")];
    expect(items[0]?.textContent).toContain("ждём ответа");
    expect(items[0]?.textContent).toMatch(/ответ до 1 окт, 21:00 · осталось 9 ч/);
    expect(items[1]?.textContent).toContain("ждём дольше 12 ч");
    const similar = items[1]?.querySelector<HTMLAnchorElement>(".req-breached a");
    const listing = LISTINGS[1];
    expect(similar?.getAttribute("href")).toBe(
      `/?date=${requests[1]?.eventDate}&guests=${requests[1]?.guests}&district=${listing?.districtCode}`,
    );
    expect(items[2]?.textContent).toContain("ответили за 2 ч 15 мин");
    expect(items[3]?.textContent).toContain("Причина: дата занята");
  });

  it("отозвать — с подтверждением, кнопки одного размера", async () => {
    await mount({ path: "/requests", mock: { requests } });
    await waitFor(() => document.querySelectorAll(".req").length > 0, "заявки");
    const first = document.querySelector(".req");
    await click(byText(".req:first-child button", "Отозвать"));
    const confirm = first?.querySelector(".confirm");
    expect(confirm?.textContent).toContain("Отозвать заявку?");
    const buttons = [...(confirm?.querySelectorAll("button") ?? [])];
    expect(buttons.map((b) => b.className)).toEqual(["btn btn-secondary", "btn btn-secondary"]);
    await click(buttons[0]);
    await waitFor(() => first?.querySelector(".status")?.textContent === "отозвана", "статус «отозвана»");
    expect(first?.querySelector(".confirm")).toBeNull();
  });

  it("пусто — подсказка следующего шага", async () => {
    await mount({ path: "/requests", mock: { requests: [] } });
    await waitFor(() => byText("a", "В каталог"), "пустое состояние");
    expect(text()).toContain("Заявок пока нет. Найдите подрядчика и отправьте первую.");
  });

  it("гостю — вход через Telegram", async () => {
    await mount({ path: "/requests", identity: "guest" });
    const link = await waitFor(
      () => document.querySelector<HTMLAnchorElement>('a[href^="https://t.me/"]'),
      "ссылка",
    );
    expect(link.getAttribute("href")).toBe("https://t.me/bayramm_demo_bot?startapp");
  });
});

describe("язык и оболочка", () => {
  it("RU/UZ: тексты, lang документа; выбор — в sessionStorage, не в localStorage", async () => {
    await mount({ path: "/profile" });
    expect(document.documentElement.lang).toBe("ru");
    await click(document.querySelector('.top button[lang="uz"]'));
    expect(document.documentElement.lang).toBe("uz");
    expect(document.querySelector("h1")?.textContent).toBe("Profil");
    expect(window.sessionStorage.getItem(LANG_KEY)).toBe("uz");
    expect(window.localStorage.length).toBe(0);
    expect(document.querySelector("nav")?.getAttribute("aria-label")).toBe("Boʻlimlar");
  });

  it("язык по умолчанию — из Telegram", async () => {
    window.sessionStorage.clear();
    const { webApp } = fakeWebApp({
      initDataUnsafe: { user: { id: 1, first_name: "A", language_code: "uz" } },
    });
    await mount({ path: "/profile", identity: "telegram", webApp });
    expect(document.documentElement.lang).toBe("uz");
  });

  it("вкладки: текущая помечена; на внутренних экранах панели нет", async () => {
    await mount({ path: "/requests", mock: { requests: [] } });
    expect(byText("nav a", "Заявки")?.getAttribute("aria-current")).toBe("page");
    await click(byText("nav a", "Главная"));
    expect(window.location.pathname).toBe("/");
    const card = await waitFor(() => document.querySelector<HTMLAnchorElement>(".card-link"), "карточка");
    await click(card);
    await waitFor(() => window.location.pathname.startsWith("/venue/"), "площадка");
    expect(document.querySelector("nav.tabs")).toBeNull();
    // Переход переводит фокус на заголовок нового экрана
    await waitFor(() => document.activeElement === document.querySelector("h1"), "фокус на заголовке");
  });

  it("неизвестный адрес — «страница не найдена»", async () => {
    await mount({ path: "/nope" });
    expect(document.querySelector("h1")?.textContent).toBe("Страница не найдена");
  });

  it("профиль: тексты согласий из API раскрываются", async () => {
    await mount({ path: "/profile" });
    await waitFor(() => document.querySelectorAll("details.doc").length === 3, "документы");
    expect(text()).toContain("Передача заявки вендору");
    expect(text()).toContain("версия 1");
  });

  it("демо-режим помечен", async () => {
    await mount({ path: "/" });
    expect(document.querySelector(".demo-ribbon")?.textContent).toBe("Демо-данные: сервер не подключён");
    cleanup();
    const live = { ...createMockApi({ now: () => NOW, listings: LISTINGS }), mode: "live" as const };
    await mount({ path: "/", api: live });
    expect(document.querySelector(".demo-ribbon")).toBeNull();
  });
});
