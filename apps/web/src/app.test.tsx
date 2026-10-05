// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api/errors";
import { allDemoListings, createMockApi, demoRequests } from "./api/mock";
import { LANG_KEY } from "./context";
import { browser } from "./hub";
import {
  byText,
  calendarDay,
  choose,
  cleanup,
  click,
  fakeWebApp,
  field,
  LISTINGS,
  mount,
  NOW,
  settle,
  TODAY,
  text,
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
    await mount({ path: "/catalog?category=hall&guests=200&district=chilonzor" });
    await waitFor(() => document.querySelectorAll(".card").length > 0, "карточки");
    const guests = field("Гости");
    expect(guests?.value).toBe("200");
    expect(guests?.inputMode).toBe("numeric");
    const district = field("Район");
    expect(district?.textContent).toBe("Чиланзар");
    for (const card of document.querySelectorAll(".card")) expect(card.textContent).toContain("Чиланзар");

    await choose(district, "все районы");
    await waitFor(() => !window.location.search.includes("district"), "район снят");
    expect(window.location.search).toBe("?category=hall&guests=200");
  });

  it("«Все» — раздел по умолчанию: первый в переключателе, карточки подписаны разделом", async () => {
    await mount({ path: "/catalog", mock: { listings: allDemoListings(TODAY) } });
    await waitFor(() => document.querySelectorAll(".card").length > 0, "карточки");
    expect(document.querySelector("h1")?.textContent).toBe("Каталог: всё для праздника");
    const chips = [...document.querySelectorAll<HTMLAnchorElement>(".cat-switch a")];
    expect(chips[0]?.textContent).toBe("Все");
    expect(chips[0]?.getAttribute("aria-current")).toBe("page");
    expect(chips.find((c) => c.textContent === "Залы и тойханы")?.getAttribute("href")).toBe(
      "/catalog?category=hall",
    );
    // Разделы вперемешку: у карточки — раздел; фильтров раздела (гости, район) нет
    expect(document.querySelector(".card-meta")?.textContent).toMatch(
      /Залы|Кортежи|Фото|Торты|Цветы|Подарки|Декор/,
    );
    expect(field("Гости")).toBeNull();
    expect(field("Район")).toBeNull();
  });

  it("лента догружается по курсору, без повторов", async () => {
    await mount({ path: "/catalog" });
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
    await mount({ path: "/catalog?category=hall&guests=5000&district=chilonzor" });
    await waitFor(() => byText("h2", "Для 5000 гостей никого не нашли"), "пустое состояние");
    // Сброс — один, в пустом состоянии: в колонке фильтров второго нет
    expect(document.querySelectorAll(".filters-reset")).toHaveLength(0);
    await click(byText(".state-empty button", "Сбросить фильтры"));
    await waitFor(() => document.querySelectorAll(".card").length > 0, "карточки после сброса");
    // Сброс — внутри раздела: раздел остаётся
    expect(window.location.search).toBe("?category=hall");
  });

  it("пусто — названо, что мешает; этот фильтр убирается один, остальные остаются", async () => {
    await mount({ path: "/catalog?category=hall&guests=5000&date=2026-10-15" });
    await waitFor(() => byText("h2", "Для 5000 гостей никого не нашли"), "пустое состояние");
    // Дата не отсекает (занятые лишь уходят в конец) — её в списке нет
    const chips = [...document.querySelectorAll<HTMLButtonElement>(".state-empty .cut-chip")];
    expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual(["Убрать фильтр: Гости: 5000"]);
    await click(chips[0]);
    await waitFor(() => document.querySelectorAll(".card").length > 0, "карточки без фильтра гостей");
    expect(window.location.search).toBe("?category=hall&date=2026-10-15");
  });

  it("исполнителей ещё нет — «скоро», как у любого раздела, без сброса фильтров", async () => {
    await mount({ path: "/catalog?category=hall", mock: { listings: [] } });
    await waitFor(() => byText("h2", "«Залы и тойханы» — скоро в каталоге"), "пустой каталог без фильтров");
    expect(document.body.textContent).not.toContain("Никого не нашли");
    expect(document.body.textContent).not.toContain("Сбросить фильтры");
  });

  it("выпадающие списки — свои: кнопка со списком и стрелкой, системных select нет", async () => {
    await mount({ path: "/catalog?category=hall" });
    await waitFor(() => document.querySelectorAll(".card").length > 0, "каталог");
    expect(document.querySelector("select")).toBeNull();
    const lists = [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"]')];
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const list of lists) expect(list.querySelector(".ui-select-caret")).not.toBeNull();
    // Порядок: выбор в списке уходит в адрес
    await choose(document.querySelector(".sort button"), "Сначала вместительнее");
    await waitFor(() => window.location.search === "?category=hall&sort=capacity_desc", "порядок в адресе");
  });

  it("дата — из своего календаря: день уходит в адрес, «Без даты» сбрасывает", async () => {
    await mount();
    await waitFor(() => document.querySelectorAll(".card").length > 0, "каталог");
    expect(document.querySelector('input[type="date"]')).toBeNull();
    const date = field("Дата");
    expect(date?.getAttribute("aria-haspopup")).toBe("dialog");
    await click(date);
    await click(calendarDay("20 окт"));
    await waitFor(() => window.location.search === "?date=2026-10-20", "дата в адресе");
    expect(date?.textContent).toContain("20 окт");
    await click(date);
    await click(byText(".ui-date-actions button", "Без даты"));
    await waitFor(() => window.location.search === "", "дата сброшена");
  });

  it("цены за гостя и за мероприятие: с гостями — примерная сумма на них и подсказка", async () => {
    await mount({ path: "/catalog?category=hall&guests=200" });
    await waitFor(() => document.querySelectorAll(".card").length > 0, "карточки");
    const cards = [...document.querySelectorAll(".card")];
    const perGuest = cards.find((c) => c.textContent?.includes("за гостя"));
    expect(perGuest?.querySelector(".card-estimate")?.textContent).toMatch(/^около .+ на 200 гостей$/);
    const perEvent = cards.find((c) => !c.textContent?.includes("за гостя"));
    expect(perEvent?.querySelector(".card-estimate")).toBeNull();
    expect(document.querySelector(".sort-hint")?.textContent).toBe(
      "Сравниваем примерную сумму на 200 гостей.",
    );
    cleanup();

    await mount({ path: "/catalog?category=hall" });
    await waitFor(() => document.querySelectorAll(".card").length > 0, "карточки");
    expect(document.querySelector(".card-estimate")).toBeNull();
    expect(document.querySelector(".sort-hint")?.textContent).toContain("делим на вместимость");
    cleanup();

    await mount({ path: "/catalog?category=hall&sort=capacity_desc" });
    await waitFor(() => document.querySelectorAll(".card").length > 0, "карточки");
    expect(document.querySelector(".sort-hint")).toBeNull();
  });

  it("карточка ведёт на площадку и передаёт дату и гостей", async () => {
    await mount({ path: "/catalog?category=hall&date=2026-10-20&guests=100" });
    const link = await waitFor(() => document.querySelector<HTMLAnchorElement>(".card-link"), "карточка");
    expect(link.getAttribute("href")).toMatch(/^\/venue\/[a-z0-9-]+\?date=2026-10-20&guests=100$/);
  });
});

describe("площадка", () => {
  it("несуществующая — «не найдена» со ссылкой в каталог", async () => {
    await mount({ path: "/venue/net-takoy" });
    await waitFor(() => byText("h1", "Страница исполнителя не найдена"), "404");
    expect(byText<HTMLAnchorElement>("a", "В каталог")?.getAttribute("href")).toBe("/catalog");
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
    // Просрочка — одной строкой, без второго «ждём дольше 12 ч» рядом
    expect(items[1]?.querySelector(".req-breached")?.textContent).toBe(
      "Исполнитель не ответил за 12 часов — посмотрите других, кто свободен в эту дату.Показать похожие",
    );
    const similar = items[1]?.querySelector<HTMLAnchorElement>(".req-breached a");
    const listing = LISTINGS[1];
    expect(similar?.getAttribute("href")).toBe(
      `/catalog?category=hall&date=${requests[1]?.eventDate}&guests=${requests[1]?.guests}&district=${listing?.districtCode}`,
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

  it("ссылка из бота ?open=<id> раскрывает заявку — без пометки о повторе", async () => {
    const target = requests[2];
    await mount({ path: `/requests?open=${target?.id}`, mock: { requests } });
    const item = await waitFor(() => document.querySelector(".req.highlighted"), "раскрытая заявка");
    expect(item.textContent).toContain(target?.listing.name);
    await waitFor(() => document.activeElement === item, "фокус на заявке");
    expect(text()).not.toContain("уже отправлена");
  });

  it("пусто — подсказка следующего шага", async () => {
    await mount({ path: "/requests", mock: { requests: [] } });
    await waitFor(() => byText("a", "В каталог"), "пустое состояние");
    expect(text()).toContain("Заявок пока нет. Выберите исполнителя в каталоге и отправьте первую.");
  });

  it("гостю — вход в хабе с возвратом сюда (браузер уводит туда целиком)", async () => {
    const replace = vi.spyOn(browser, "replace").mockImplementation(() => {});
    try {
      await mount({ path: "/requests", identity: "guest" });
      expect(replace).toHaveBeenCalledWith("/auth?return=%2Frequests");
      expect(document.querySelector(".reqs, .tg-cta")).toBeNull();
    } finally {
      replace.mockRestore();
    }
  });
});

describe("язык и оболочка", () => {
  it("RU/UZ: тексты, lang документа; выбор — во вкладке и между визитами (только язык)", async () => {
    await mount({ path: "/profile" });
    expect(document.documentElement.lang).toBe("ru");
    await click(document.querySelector('.top button[lang="uz"]'));
    expect(document.documentElement.lang).toBe("uz");
    expect(document.querySelector("h1")?.textContent).toBe("Profil");
    expect(window.sessionStorage.getItem(LANG_KEY)).toBe("uz");
    expect(window.localStorage.getItem(LANG_KEY)).toBe("uz");
    expect(window.localStorage.length).toBe(1);
    expect(document.querySelector("nav")?.getAttribute("aria-label")).toBe("Boʻlimlar");
  });

  it("гость: язык из прошлого визита (localStorage), даже в новой вкладке", async () => {
    window.sessionStorage.clear();
    window.localStorage.setItem(LANG_KEY, "uz");
    await mount({ path: "/docs", identity: "guest" });
    expect(document.documentElement.lang).toBe("uz");
    expect(document.querySelector("h1")?.textContent).toBe("Hujjatlar");
  });

  it("хранилище недоступно (приватный режим) — язык живёт до перезагрузки, без ошибок", async () => {
    window.sessionStorage.clear();
    const blocked = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    try {
      await mount({ path: "/docs", identity: "guest" });
      await click(document.querySelector('.top button[lang="uz"]'));
      expect(document.documentElement.lang).toBe("uz");
    } finally {
      blocked.mockRestore();
    }
  });

  it("язык сохраняется в профиле: по нему пишет бот", async () => {
    const api = createMockApi({ now: () => NOW, listings: LISTINGS, me: { locale: "ru" } });
    await mount({ path: "/profile", api });
    await click(document.querySelector('.top button[lang="uz"]'));
    await waitFor(() => api.profile().locale === "uz", "язык в профиле");
  });

  it("не выбран в этой вкладке — язык из профиля, а не из Telegram и не из прошлого визита", async () => {
    window.sessionStorage.clear();
    window.localStorage.setItem(LANG_KEY, "uz");
    const { webApp } = fakeWebApp({
      initDataUnsafe: { user: { id: 1, first_name: "A", language_code: "uz" } },
    });
    await mount({ path: "/profile", identity: "telegram", webApp, mock: { me: { locale: "ru" } } });
    await waitFor(() => document.documentElement.lang === "ru", "язык из профиля");
    expect(document.querySelector("h1")?.textContent).toBe("Профиль");
  });

  it("гостю профиль не запрашивается и язык в него не пишется", async () => {
    const asked: string[] = [];
    await mount({
      path: "/catalog",
      identity: "guest",
      mock: {
        failWith: (method) => {
          if (method === "me" || method === "updateMe") asked.push(method);
          return null;
        },
      },
    });
    await click(document.querySelector('.top button[lang="uz"]'));
    expect(document.documentElement.lang).toBe("uz");
    expect(asked).toEqual([]);
    expect(text()).not.toContain("Mening maʼlumotlarim");
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
    expect(byText("nav.tabs a", "Заявки")?.getAttribute("aria-current")).toBe("page");
    // На сайте первая вкладка — «Каталог» (главная сайта — лендинг), в Telegram — «Главная»
    await click(byText("nav.tabs a", "Каталог"));
    expect(window.location.pathname).toBe("/catalog");
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
    expect(text()).toContain("Передача заявки исполнителю");
    expect(text()).toContain("версия 1");
  });

  it("демо-режим помечен", async () => {
    await mount({ path: "/catalog" });
    expect(document.querySelector(".demo-ribbon")?.textContent).toBe("Демо-данные: сервер не подключён");
    cleanup();
    const live = { ...createMockApi({ now: () => NOW, listings: LISTINGS }), mode: "live" as const };
    await mount({ path: "/catalog", api: live });
    expect(document.querySelector(".demo-ribbon")).toBeNull();
  });
});

describe("мои данные", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("выгрузка — файл JSON и те же данные на экране", async () => {
    const created = vi.fn((_blob: Blob | MediaSource) => "blob:bayramm-test");
    vi.spyOn(URL, "createObjectURL").mockImplementation(created);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await mount({ path: "/profile" });
    await click(await waitFor(() => byText("button", "Скачать мои данные"), "кнопка выгрузки"));
    await waitFor(() => text().includes("bayramm-my-data-2026-10-01.json"), "файл готов");
    expect(created).toHaveBeenCalledTimes(1);
    const blob = created.mock.calls[0]?.[0] as Blob | undefined;
    expect(blob?.type).toBe("application/json");
    expect(document.querySelector(".data-dump")?.textContent).toContain('"version": 1');
  });

  it("уведомления: отключить — и объяснение, как включить снова", async () => {
    const api = createMockApi({ now: () => NOW, listings: LISTINGS, me: { notifications: true } });
    await mount({ path: "/profile", api });
    await waitFor(
      () => text().includes("Ответы исполнителей приходят в Telegram-бот"),
      "уведомления включены",
    );
    await click(byText("button", "Отключить уведомления"));
    await waitFor(() => text().includes("Уведомления в боте выключены"), "выключены");
    expect(api.profile().notifications).toBe(false);
    expect(byText("button", "Отключить уведомления")).toBeNull();
  });

  it("удаление: подтверждение с объяснением, кнопки одного размера; после — без входа", async () => {
    window.sessionStorage.setItem("bayramm.web.draft.lola-zali", JSON.stringify({ phone: "901234567" }));
    const api = createMockApi({ now: () => NOW, listings: LISTINGS, requests: demoRequests(LISTINGS, NOW) });
    await mount({ path: "/profile", api });
    await click(await waitFor(() => byText("button", "Удалить аккаунт"), "удалить"));
    const confirm = document.querySelector(".confirm");
    expect(confirm?.querySelector("legend")?.textContent).toBe("Удалить аккаунт?");
    expect(confirm?.textContent).toContain("останутся у исполнителей обезличенными");
    const buttons = [...(confirm?.querySelectorAll("button") ?? [])];
    expect(buttons.map((b) => [b.textContent, b.className])).toEqual([
      ["Удалить", "btn btn-secondary"],
      ["Оставить", "btn btn-secondary"],
    ]);

    await click(buttons[0]);
    await waitFor(() => text().includes("Аккаунт удалён"), "удалён");
    expect(api.deleted()).toBe(true);
    expect(window.sessionStorage.getItem("bayramm.web.draft.lola-zali")).toBeNull();
    expect(byText("button", "Скачать мои данные")).toBeNull();
    // Дальше — сайт без входа: оболочка гостя, сообщение об удалении остаётся на экране
    expect(document.querySelector("nav.tabs")).toBeNull();
    expect(document.querySelector(".top-signin")).not.toBeNull();

    await click(byText("a.row-link", /Мои заявки/));
    await waitFor(() => byText("h2", "Аккаунт удалён"), "в «Моих заявках» — тоже");
    expect(document.querySelectorAll(".req")).toHaveLength(0);
  });

  it("«Оставить» закрывает подтверждение, аккаунт на месте", async () => {
    const api = createMockApi({ now: () => NOW, listings: LISTINGS });
    await mount({ path: "/profile", api });
    await click(await waitFor(() => byText("button", "Удалить аккаунт"), "удалить"));
    await click(byText(".confirm button", "Оставить"));
    expect(document.querySelector(".confirm")).toBeNull();
    expect(api.deleted()).toBe(false);
  });
});
