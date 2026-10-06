// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "./api/errors";
import { allDemoListings } from "./api/mock";
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
    expect(document.querySelector("h1")?.textContent).toBe(
      "Зал, кортеж, фото, торт — с ценой и телефоном сразу",
    );
    expect(document.title).toBe("Bayramm — всё для праздника в Ташкенте");
    // Залы — из выдачи каталога, в её порядке; названия — заголовки третьего уровня
    for (const name of cards()) expect(LISTINGS.map((l) => l.name)).toContain(name);
    expect(document.querySelectorAll(".ln-cards h3.card-name")).toHaveLength(4);
    expect(document.querySelectorAll(".ln-step")).toHaveLength(3);
    expect([...document.querySelectorAll(".ln-promise h3")].map((h) => h.textContent)).toEqual([
      "Бесплатно для вас",
      "Цена видна сразу",
      "Контакты без заявки",
      "Ответ за 12 часов",
    ]);
    // Вопросы — только о том, чего нет в шагах и обещаниях: цена и 12 часов там уже сказаны
    expect([...document.querySelectorAll(".ln-faq summary")].map((q) => q.textContent)).toEqual([
      "Заявка закрепляет дату?",
      "Как отправить заявку?",
      "Можно заказать несколько услуг сразу?",
      "Откуда цены и календарь?",
    ]);
    // Каталог в первом экране — не отдельной ссылкой: разделы — сеткой сразу под подбором
    expect(document.querySelector(".ln-hero a[href='/catalog']")).toBeNull();
    // Подвал сайта: каталог, документы, язык
    const footer = document.querySelector(".site-footer");
    expect(footer?.querySelector('a[href="/docs"]')?.textContent).toBe("Документы");
    expect(footer?.querySelector('a[href="/catalog"]')).not.toBeNull();
    // Оболочка гостя: без нижней панели; ни один раздел не текущий — лендинг не раздел
    expect(document.querySelector("nav.tabs")).toBeNull();
    expect(document.querySelector('nav.site-nav a[aria-current="page"]')).toBeNull();
  });

  it("витрин нет — блока витрин нет, заглушек под видом витрин тоже; категории — «скоро»", async () => {
    await mount({ path: "/", identity: "guest", mock: { listings: [] } });
    await waitFor(() => !document.querySelector(".ln-cards"), "блок витрин скрыт");
    expect(document.querySelector(".card-skeleton")).toBeNull();
    expect(document.body.textContent).not.toContain("Сейчас в каталоге");
    expect(document.querySelector("h1")?.textContent).toBe(
      "Зал, кортеж, фото, торт — с ценой и телефоном сразу",
    );
    // Чисел витрин нет нигде; пустые категории честно помечены
    await waitFor(() => document.querySelectorAll(".cat-soon").length === 12, "пометки «скоро»");
    expect(document.querySelector(".cat-soon")?.textContent).toBe("скоро");
  });

  it("сетка категорий: все включённые, значок и название; пустая — «скоро», с витринами — без пометки", async () => {
    const car = allDemoListings("2026-10-01").filter((l) => l.categoryCode === "car");
    await mount({ path: "/", identity: "guest", mock: { listings: [...LISTINGS, ...car] } });
    await waitFor(() => document.querySelectorAll(".cat-soon").length > 0, "категории из API");
    const tiles = [...document.querySelectorAll<HTMLAnchorElement>(".cat-tile")];
    // Названия — короткие, из глоссария клиента (без косых черт)
    // Путь пары: ЗАГС, тойхона, кортеж, фото и видео, студия, ресторан…
    expect(tiles.map((a) => a.querySelector(".cat-tile-name")?.textContent)).toEqual([
      "ЗАГС",
      "Тойханы",
      "Кортежи",
      "Фото и видео",
      "Студии",
      "Рестораны",
      "Цветы",
      "Свадебные наряды",
      "Подарки",
      "Кейтеринг",
      "Торты и сладости",
      "Декор и оформление",
    ]);
    expect(tiles.map((a) => a.getAttribute("href"))[2]).toBe("/catalog?category=car");
    // Залы — раздел, как остальные: каталог без раздела — «Все»
    expect(tiles[1]?.getAttribute("href")).toBe("/catalog?category=hall");
    // Что в разделе — строкой у плитки (видна с планшета)
    expect(tiles[0]?.querySelector(".cat-tile-desc")?.textContent).toBe(
      "Регистрация брака: запись на дату, документы, зал для торжественной церемонии",
    );
    const soon = tiles
      .filter((a) => a.querySelector(".cat-soon"))
      .map((a) => a.querySelector(".cat-tile-name")?.textContent);
    expect(soon).toEqual([
      "ЗАГС",
      "Фото и видео",
      "Студии",
      "Рестораны",
      "Цветы",
      "Свадебные наряды",
      "Подарки",
      "Кейтеринг",
      "Торты и сладости",
      "Декор и оформление",
    ]);
    expect(document.body.textContent).not.toMatch(/\d+\s+(витрин|вендор)/);
  });

  it("витрины — по одной из разных разделов, раздел подписан; второго списка разделов нет", async () => {
    const all = allDemoListings("2026-10-01");
    await mount({ path: "/", identity: "guest", mock: { listings: all } });
    await waitFor(() => cards().length === 4, "витрины");
    // Первые четыре раздела с витринами — по самой доступной в каждом (порядок каталога)
    const categories = [...document.querySelectorAll(".ln-cards .card")].map(
      (card) => card.querySelector(".card-meta")?.textContent?.split("\u00a0· ")[0],
    );
    expect(categories).toEqual(["ЗАГС", "Тойханы", "Кортежи", "Фото и видео"]);
    for (const name of cards()) expect(all.map((l) => l.name)).toContain(name);
    // Разделы на лендинге перечислены один раз — сеткой; у витрин ни переключателя, ни «весь раздел»
    expect(document.querySelectorAll(".ln-venues .cat-chip, .ln-venues .ln-head-link")).toHaveLength(0);
    for (const name of ["Кортежи", "Торты и сладости"])
      expect(
        [...document.querySelectorAll(".landing .cat-tile-name, .landing .cat-chip")].filter(
          (el) => el.textContent === name,
        ),
      ).toHaveLength(1);
    // Цены с единицей своего раздела: кортеж — «за час»
    expect(document.querySelector(".ln-cards")?.textContent).toMatch(/за час/);
  });

  it("витрины только в одном разделе — четыре из него", async () => {
    const cakes = allDemoListings("2026-10-01").filter((l) => l.categoryCode === "cake");
    await mount({ path: "/", identity: "guest", mock: { listings: [...LISTINGS, ...cakes] } });
    await waitFor(() => cards().length === 4, "витрины");
    // Два раздела: по две из каждого, по очереди
    const categories = [...document.querySelectorAll(".ln-cards .card-meta")].map(
      (meta) => meta.textContent?.split("\u00a0· ")[0],
    );
    expect(categories).toEqual(["Тойханы", "Торты и сладости", "Тойханы", "Торты и сладости"]);
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

  it("подбор: залы — с гостями, они уходят в каталог фильтром", async () => {
    await mount({ path: "/", identity: "guest" });
    await waitFor(() => document.querySelector("form.ln-search"), "подбор");
    const form = document.querySelector("form.ln-search") as HTMLFormElement;
    expect(form.querySelector('button[aria-haspopup="listbox"]')?.textContent).toContain("Тойханы");
    await type(form.querySelector("input"), "120");
    await click(byText("form.ln-search button", "Показать"));
    await waitFor(() => window.location.pathname === "/catalog", "каталог");
    expect(window.location.search).toBe("?category=hall&guests=120");
    await waitFor(() => document.querySelectorAll(".catalog .card").length > 0, "выдача");
    expect(field("Гости")?.value).toBe("120");
  });

  it("подбор: другая категория — без гостей (каталог по ним не отбирает), в каталог этой категории", async () => {
    await mount({ path: "/", identity: "guest", mock: { listings: allDemoListings("2026-10-01") } });
    await waitFor(() => document.querySelector("form.ln-search"), "подбор");
    const form = () => document.querySelector("form.ln-search") as HTMLFormElement;
    await click(form().querySelector('button[aria-haspopup="listbox"]'));
    await click(
      [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === "Фото и видео"),
    );
    expect(form().classList.contains("with-guests")).toBe(false);
    expect(form().querySelector('input[inputmode="numeric"]')).toBeNull();
    await click(byText("form.ln-search button", "Показать"));
    await waitFor(() => window.location.pathname === "/catalog", "каталог");
    expect(window.location.search).toBe("?category=photo");
    await waitFor(() => document.querySelectorAll(".catalog .card").length === 3, "фото и видео");
    expect(document.querySelector("h1")?.textContent).toBe("Фото и видео в Ташкенте");
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
