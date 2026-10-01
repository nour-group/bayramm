// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "./api/errors";
import { normalizeStartUrl } from "./bootstrap";
import { LANG_KEY } from "./context";
import { byText, cleanup, click, fakeWebApp, field, LISTINGS, mount, type, waitFor } from "./test/harness";

/* Лендинг сайта, корень в Telegram, подвал, документы и адрес первой загрузки */

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.sessionStorage.setItem(LANG_KEY, "ru");
  window.scrollTo = () => {};
});

afterEach(cleanup);

const cards = () => [...document.querySelectorAll(".ln-cards .card-name")].map((n) => n.textContent);

describe("лендинг (/ в браузере)", () => {
  it("первый экран, четыре настоящих зала из каталога, как это работает, обещания, вопросы", async () => {
    await mount({ path: "/", identity: "guest" });
    await waitFor(() => cards().length === 4, "залы на лендинге");
    expect(document.querySelector("h1")?.textContent).toBe("Зал на праздник — с ценой и свободной датой");
    expect(document.title).toBe("Bayramm — залы для праздников в Ташкенте");
    // Залы — из выдачи каталога, в её порядке; названия — заголовки третьего уровня
    for (const name of cards()) expect(LISTINGS.map((l) => l.name)).toContain(name);
    expect(document.querySelectorAll(".ln-cards h3.card-name")).toHaveLength(4);
    expect(document.querySelectorAll(".ln-step")).toHaveLength(3);
    expect([...document.querySelectorAll(".ln-promise h3")].map((h) => h.textContent)).toEqual([
      "Бесплатно для вас",
      "Цена видна сразу",
      "Телефон без заявки",
      "Ответ за 12 часов",
    ]);
    expect(document.querySelectorAll(".ln-faq details")).toHaveLength(5);
    // Подвал сайта: каталог, документы, язык
    const footer = document.querySelector(".site-footer");
    expect(footer?.querySelector('a[href="/docs"]')?.textContent).toBe("Документы");
    expect(footer?.querySelector('a[href="/catalog"]')).not.toBeNull();
    // Ни одна вкладка не текущая: лендинг — не раздел
    expect(document.querySelector('nav.tabs a[aria-current="page"]')).toBeNull();
  });

  it("площадок нет — блока залов нет, заглушек под видом залов тоже", async () => {
    await mount({ path: "/", identity: "guest", mock: { listings: [] } });
    await waitFor(() => !document.querySelector(".ln-cards"), "блок залов скрыт");
    expect(document.querySelector(".card-skeleton")).toBeNull();
    expect(document.body.textContent).not.toContain("Залы в каталоге");
    expect(document.querySelector("h1")?.textContent).toBe("Зал на праздник — с ценой и свободной датой");
  });

  it("выдача не загрузилась — блок залов просто не показываем", async () => {
    await mount({
      path: "/",
      identity: "guest",
      mock: { failWith: (method) => (method === "catalog" ? new ApiError(500, "internal_error") : null) },
    });
    await waitFor(() => !document.querySelector(".ln-cards"), "блок залов скрыт");
    expect(document.querySelector(".landing .state-error")).toBeNull();
  });

  it("подбор: дата, гости и район уходят в каталог фильтрами", async () => {
    await mount({ path: "/", identity: "guest" });
    await waitFor(() => document.querySelector("form.ln-search"), "подбор");
    const form = document.querySelector("form.ln-search") as HTMLFormElement;
    await type(form.querySelector("input"), "120");
    await click(form.querySelector('button[aria-haspopup="listbox"]'));
    await click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === "Чиланзар"));
    await click(byText("form.ln-search button", "Показать залы"));
    await waitFor(() => window.location.pathname === "/catalog", "каталог");
    expect(window.location.search).toBe("?guests=120&district=chilonzor");
    await waitFor(() => document.querySelectorAll(".catalog .card").length > 0, "выдача");
    expect(field("Гости")?.value).toBe("120");
  });

  it("гостю в шапке — «Войти» в хаб с возвратом на этот экран", async () => {
    await mount({ path: "/catalog?date=2026-10-20", identity: "guest" });
    expect(document.querySelector(".top-signin")?.getAttribute("href")).toBe(
      "/auth?return=%2Fcatalog%3Fdate%3D2026-10-20",
    );
  });
});

describe("корень в Telegram и документы", () => {
  it("в Telegram корень — каталог: ни лендинга, ни подвала сайта", async () => {
    const { webApp } = fakeWebApp();
    await mount({ path: "/", identity: "telegram", webApp });
    await waitFor(() => document.querySelectorAll(".catalog .card").length > 0, "каталог");
    expect(document.querySelector(".landing")).toBeNull();
    expect(document.querySelector(".site-footer")).toBeNull();
    expect(document.querySelector(".top-signin")).toBeNull();
    // Первая вкладка в Mini App — «Главная», и она текущая
    const first = document.querySelector("nav.tabs a");
    expect(first?.textContent).toBe("Главная");
    expect(first?.getAttribute("aria-current")).toBe("page");
  });

  it("/docs — тексты согласий и как работает заявка", async () => {
    await mount({ path: "/docs", identity: "guest" });
    await waitFor(() => document.querySelectorAll(".docs details.doc").length === 3, "документы");
    expect(document.querySelector("h1")?.textContent).toBe("Документы");
    expect(document.body.textContent).toContain("Как работает заявка");
  });
});

describe("адрес первой загрузки", () => {
  it("?lang=uz — выбор языка: запомнен и убран из адреса, хэш Telegram на месте", () => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/catalog?lang=uz&guests=10#tgWebAppData=x");
    normalizeStartUrl(false);
    expect(window.sessionStorage.getItem(LANG_KEY)).toBe("uz");
    expect(window.localStorage.getItem(LANG_KEY)).toBe("uz");
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      "/catalog?guests=10#tgWebAppData=x",
    );
  });

  it("неизвестный язык в адресе не сохраняется, но и не остаётся в адресе", () => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/?lang=en");
    normalizeStartUrl(false);
    expect(window.sessionStorage.getItem(LANG_KEY)).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("старая ссылка /?date=… в браузере — в /catalog; в Telegram корень остаётся каталогом", () => {
    window.history.replaceState(null, "", "/?date=2026-10-20&guests=200");
    normalizeStartUrl(false);
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/catalog?date=2026-10-20&guests=200",
    );

    window.history.replaceState(null, "", "/?date=2026-10-20&guests=200");
    normalizeStartUrl(true);
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?date=2026-10-20&guests=200");
  });
});
