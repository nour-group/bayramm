// @vitest-environment jsdom
import type { ListingDetail } from "@bayramm/shared/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "./api/errors";
import { allDemoListings, createMockApi, demoRequests, type MockApi } from "./api/mock";
import { CLIENT_CATEGORIES } from "./categories";
import { LANG_KEY } from "./context";
import {
  byText,
  choose,
  cleanup,
  click,
  field,
  mount,
  NOW,
  pickDate,
  settle,
  text,
  type,
  waitFor,
} from "./test/harness";

/* Категории на экранах: каталог категории с её фильтрами, витрина (услуги, поля, видео,
   занятость по модели категории), форма заявки по форме категории, «Мои заявки» */

const ALL = allDemoListings("2026-10-01");
const by = (slug: string): ListingDetail => {
  const listing = ALL.find((l) => l.slug === slug);
  if (!listing) throw new Error(`нет демо-витрины ${slug}`);
  return listing;
};

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.sessionStorage.setItem(LANG_KEY, "ru");
  window.scrollTo = () => {};
});

afterEach(cleanup);

/** Неразрывные пробелы денег — обычными */
const norm = (value: string | null | undefined) => (value ?? "").replace(/\u00a0/g, " ");
const cardNames = () => [...document.querySelectorAll(".cards .card-name")].map((n) => n.textContent);
const side = () => document.querySelector(".filters-side") as HTMLElement;
const checkboxIn = (root: ParentNode, label: string) =>
  [...root.querySelectorAll<HTMLLabelElement>("label.ui-check")]
    .find((l) => l.textContent?.trim() === label)
    ?.querySelector("input") ?? null;
const transferCheckbox = () =>
  byText<HTMLLabelElement>("label.consent-check", /Разрешаю передать/)?.querySelector("input") ?? null;

describe("каталог категории", () => {
  it("переключатель категорий, заголовок, только свои фильтры и цены с единицей", async () => {
    await mount({ path: "/catalog?category=car", mock: { listings: ALL } });
    await waitFor(() => cardNames().length === 3, "кортежи");
    // Название раздела — из глоссария клиента: одно и то же в заголовке и в переключателе
    expect(document.querySelector("h1")?.textContent).toBe("Кортежи в Ташкенте");
    expect(document.title).toBe("Кортежи в Ташкенте · Bayramm");
    const current = document.querySelector('.cat-switch a[aria-current="page"]');
    expect(current?.textContent).toBe("Кортежи");
    expect(current?.getAttribute("href")).toBe("/catalog?category=car");
    // Гостей и района у кортежа нет: каталог по ним не отбирает
    expect(field("Гости")).toBeNull();
    expect(field("Район")).toBeNull();
    for (const price of document.querySelectorAll(".cards .card-price"))
      expect(norm(price.textContent)).toContain("за час");
    // «Сначала вместительнее» — только у залов
    await click(document.querySelector(".sort button"));
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
      "Сначала дешевле",
      "Сначала дороже",
    ]);
  });

  it("порядок экрана: заголовок, разделы, фильтры одним блоком «Фильтры», выдача; сброс — в блоке", async () => {
    await mount({ path: "/catalog?category=car&date=2026-10-08", mock: { listings: ALL } });
    await waitFor(() => cardNames().length === 3, "кортежи");
    const screen = document.querySelector(".catalog") as HTMLElement;
    const order = [".catalog-head h1", ".cat-switch", ".filters-panel", ".catalog-list"].map((selector) =>
      [...screen.querySelectorAll("*")].indexOf(screen.querySelector(selector) as Element),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Один блок фильтров с заголовком для диктора: дата и поля витрины — внутри него
    const panel = document.querySelector(".filters-panel") as HTMLElement;
    expect(panel.getAttribute("aria-labelledby")).toBe(panel.querySelector("h2")?.id);
    expect(panel.querySelector("h2")?.textContent).toBe("Фильтры");
    expect(panel.querySelector(".filters button[aria-haspopup=dialog]")).not.toBeNull();
    expect(panel.querySelector(".filters-side .attr-filters")).not.toBeNull();
    // Есть фильтр — «Сбросить фильтры» в блоке; он снимает всё, кроме раздела
    await click(byText(".filters-panel .filters-reset", "Сбросить фильтры"));
    await waitFor(() => window.location.search === "?category=car", "фильтры сняты");
    expect(document.querySelector(".filters-reset")).toBeNull();
  });

  it("смена категории сохраняет дату; отметки — свободно, частично занято, занято", async () => {
    await mount({ path: "/catalog?date=2026-10-08", mock: { listings: ALL } });
    await waitFor(() => cardNames().length > 0, "залы");
    await click(byText(".cat-switch a", "Кортежи"));
    await waitFor(() => window.location.search === "?category=car&date=2026-10-08", "адрес категории");
    await waitFor(() => cardNames().length === 3, "кортежи");
    expect(cardNames()).toEqual(["Oq Kortej", "Retro Avto", "Limuzin Lux"]);
    expect([...document.querySelectorAll(".cards .chip")].map((c) => c.textContent)).toEqual([
      "8 окт — частично занято",
      "8 окт — свободно",
      "8 окт — занято",
    ]);
  });

  it("у категории без календаря дата не отсекает и отметок нет; объясняем, куда она уйдёт", async () => {
    await mount({ path: "/catalog?category=cake&date=2026-10-08", mock: { listings: ALL } });
    await waitFor(() => cardNames().length === 3, "торты");
    expect(document.querySelectorAll(".cards .chip")).toHaveLength(0);
    expect(text()).toContain("календаря занятости нет");
  });

  it("фильтры по полям витрины: колонка — в адрес и в выдачу; сброс", async () => {
    await mount({ path: "/catalog?category=car", mock: { listings: ALL } });
    await waitFor(() => cardNames().length === 3, "кортежи");
    // Подписи — из описания категории, у полей автопарка — с его названием
    expect(text(side())).toContain("Автопарк: Класс");
    await click(checkboxIn(side(), "Лимузин"));
    await waitFor(() => window.location.search.includes("a.fleet.class=limousine"), "фильтр в адресе");
    await waitFor(() => cardNames().length === 1, "лимузин");
    expect(cardNames()).toEqual(["Limuzin Lux"]);
    expect(document.querySelector(".filters-open")?.textContent).toBe("Фильтры · 1");
    await click(checkboxIn(side(), "Ретро"));
    await waitFor(() => cardNames().length === 2, "лимузин и ретро");
    expect(window.location.search).toContain("a.fleet.class=limousine%2Cretro");
    await click(checkboxIn(side(), "Украшение машины"));
    await waitFor(() => window.location.search.includes("a.decoration=1"), "второй фильтр");
    await waitFor(() => cardNames().length === 1, "только с украшением");
    // Ретро без украшения: под фильтры не подходит — сброс одним нажатием
    await click(checkboxIn(side(), "Лимузин"));
    await waitFor(() => byText("button", "Сбросить фильтры"), "пусто");
    await click(byText("button", "Сбросить фильтры"));
    await waitFor(() => window.location.search === "?category=car", "фильтры сняты");
  });

  it("на телефоне — шторка «Фильтры»: те же поля, «Показать» закрывает", async () => {
    await mount({ path: "/catalog?category=photo", mock: { listings: ALL } });
    await waitFor(() => cardNames().length === 3, "фото и видео");
    await click(document.querySelector(".filters-open"));
    const sheet = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(sheet).not.toBeNull();
    expect(text(sheet)).toContain("Покажем тех, у кого есть всё отмеченное");
    await click(checkboxIn(sheet, "Оператор дрона"));
    await waitFor(() => window.location.search.includes("a.team=drone_operator"), "фильтр в адресе");
    await waitFor(() => cardNames().length === 1, "с дроном");
    // На кнопке — сколько нашлось: видно до закрытия шторки
    await click(byText('[role="dialog"] button', "Показать 1 вариант"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(cardNames()).toEqual(["Kadr Media"]);
  });

  it("категория без витрин — честно «скоро», а не «под эти условия никого»", async () => {
    await mount({
      path: "/catalog?category=gifts",
      mock: { listings: ALL.filter((l) => l.categoryCode !== "gifts") },
    });
    await waitFor(() => byText("h2", "«Подарки» — скоро в каталоге"), "пусто");
    expect(byText("button", "Сбросить фильтры")).toBeNull();
    // В переключателе пустой категории нет, кроме открытой
    expect(byText(".cat-switch a", "Подарки")?.getAttribute("aria-current")).toBe("page");
  });
});

describe("витрина категории", () => {
  it("кортеж: услуги с единицами, минимумом и опциями; автопарк; части дня в календаре", async () => {
    await mount({ path: "/venue/oq-kortej?date=2026-10-08", mock: { listings: ALL } });
    await waitFor(() => document.querySelector("h1")?.textContent === "Oq Kortej", "витрина");
    const services = [...document.querySelectorAll(".svc")];
    expect(services.map((s) => s.querySelector(".svc-name")?.textContent)).toEqual([
      "Машина для молодожёнов",
      "Кортеж из нескольких машин",
      "Украшение машины",
    ]);
    expect(norm(services[0]?.textContent)).toContain("350 000 сум за час");
    expect(services[0]?.textContent).toContain("минимум 3 ч");
    expect(services[0]?.textContent).toContain("Что входит: Водитель, топливо");
    expect(services[0]?.textContent).toContain("Украшение живыми цветами");
    expect(text(document.querySelector(".attr-list") as HTMLElement)).toContain(
      "Mercedes-Benz E-Class · Премиум",
    );
    expect(document.querySelector(".venue-meta")?.textContent).toBe("Кортежи");
    // Дата из каталога: частично занята — что именно
    expect(document.querySelector(".venue-head .chip")?.textContent).toBe("8 окт — частично занято");
    expect([...document.querySelectorAll(".parts .part")].map((p) => p.textContent)).toEqual([
      "утро 05:00–11:00свободно",
      "день 11:00–17:00свободно",
      "вечер 17:00–24:00занято",
    ]);
    // Календарь: частично занятые дни помечены и названы для диктора; день можно выбрать —
    // он уйдёт в заявку
    const partial = [...document.querySelectorAll(".ui-cal-day.is-partial")].map((d) =>
      d.getAttribute("aria-label"),
    );
    expect(partial).toEqual(["8 окт, частично занято: вечер", "10 окт, частично занято: утро, день"]);
    expect(document.querySelector(".ui-cal-day.is-busy")?.getAttribute("aria-label")).toBe("13 окт, занято");
    expect(text(document.querySelector(".ui-cal-legend") as HTMLElement)).toContain("частично занято");
  });

  it("услуга «в заявку»: отметка на витрине, счётчик в карточке, в форме — уже выбрана", async () => {
    const oq = by("oq-kortej");
    await mount({ path: "/venue/oq-kortej", mock: { listings: ALL } });
    await waitFor(() => document.querySelector(".svc-pick"), "услуги");
    const pick = document.querySelector<HTMLButtonElement>(".svc-pick");
    expect(pick?.getAttribute("aria-label")).toBe("Добавить в заявку: Машина для молодожёнов");
    await click(pick);
    expect(document.querySelector(".svc-pick")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".bar-chosen")?.textContent).toBe("Выбрано услуг: 1");
    await click(byText(".venue-bar a", "Оставить заявку"));
    await waitFor(() => transferCheckbox(), "форма");
    const first = document.querySelector<HTMLInputElement>(".svc-choice input[type=checkbox]");
    expect(first?.checked).toBe(true);
    // Количество — минимальное у вендора
    expect(document.querySelector<HTMLInputElement>(".svc-qty input")?.value).toBe(
      String(oq.services[0]?.minQty),
    );
  });

  it("фото и видео: видео — ссылками наружу, без встраивания", async () => {
    await mount({ path: "/venue/kadr-media", mock: { listings: ALL } });
    await waitFor(() => document.querySelector(".videos"), "видео");
    const links = [...document.querySelectorAll<HTMLAnchorElement>(".videos a")];
    expect(links.map((a) => a.href)).toEqual([
      "https://www.youtube.com/watch?v=demoKadr001",
      "https://www.instagram.com/reel/demoKadrReel/",
    ]);
    for (const a of links) {
      expect(a.target).toBe("_blank");
      expect(a.rel).toContain("noopener");
      expect(a.textContent).toContain("(откроется в новой вкладке)");
    }
    expect(document.querySelector("iframe")).toBeNull();
    expect(text(document.querySelector(".features") ?? document.body)).not.toContain("undefined");
  });

  it("торт: календаря нет — срок заказа; у услуги со своим сроком он подписан", async () => {
    await mount({ path: "/venue/milliy-shirinlik", mock: { listings: ALL } });
    await waitFor(() => document.querySelector(".lead-note"), "срок");
    expect(document.querySelector(".ui-cal")).toBeNull();
    expect(document.querySelector(".lead-note")?.textContent).toBe(
      "Заказывают минимум за 3 дня до праздника.",
    );
    expect(text(document.querySelector(".svcs") as HTMLElement)).toContain("заказ за 7 дней");
  });

  it("контакты у витрины каждой категории — до заявки и гостю: «Связаться» открывает телефон", async () => {
    for (const category of CLIENT_CATEGORIES) {
      const listing = ALL.find((l) => l.categoryCode === category.code);
      if (!listing) throw new Error(category.code);
      const { unmount } = await mount({
        path: `/venue/${listing.slug}`,
        identity: "guest",
        mock: { listings: ALL },
      });
      await waitFor(() => document.querySelector("h1")?.textContent === listing.name, listing.slug);
      // В карточке номера нет — он в окне «Связаться»
      expect(document.querySelector(`a[href="tel:${listing.phone}"]`), category.code).toBeNull();
      await click(document.querySelector(".contact button"));
      await waitFor(
        () => document.querySelector(`[role="dialog"] a[href="tel:${listing.phone}"]`),
        category.code,
      );
      expect(document.querySelector("form.request")).toBeNull();
      unmount();
    }
  });
});

describe("заявка по форме категории", () => {
  it("черновик: только комментарий — тоже черновик, переживает уход с формы; услуга с витрины его не стирает", async () => {
    await mount({ path: "/venue/oq-kortej/request", mock: { listings: ALL } });
    await waitFor(() => transferCheckbox(), "форма");
    await type(field("Комментарий"), "Маршрут: ЗАГС → парк → зал");
    await click(byText("button", "Не сейчас"));
    await waitFor(() => document.querySelector(".svc-pick"), "витрина");
    await click(document.querySelector(".svc-pick"));
    await click(byText(".venue-bar a", "Оставить заявку"));
    await waitFor(() => transferCheckbox(), "форма снова");
    expect(field("Комментарий")?.value).toBe("Маршрут: ЗАГС → парк → зал");
    expect(document.querySelector<HTMLInputElement>(".svc-choice input[type=checkbox]")?.checked).toBe(true);
  });

  it("кортеж: время → часть дня, часы, машины, услуга с опцией и примерной суммой; гостей нет", async () => {
    const oq = by("oq-kortej");
    const bride = oq.services[0];
    const flowers = bride?.options[0];
    if (!bride || !flowers) throw new Error("нет услуги");
    const { api } = await mount({ path: "/venue/oq-kortej/request", mock: { listings: ALL } });
    await waitFor(() => transferCheckbox(), "форма");
    expect(field("Гостей")).toBeNull();
    await click(byText("label.ui-radio", "Свадьба"));
    await pickDate(field("Дата события"), "20 окт");
    await choose(field("Начало"), "17:30");
    expect(text()).toContain("Это вечер: 17:00–24:00");
    await type(field("Сколько часов"), "5");
    await type(field("Сколько машин"), "2");
    await click(document.querySelector(".svc-choice input[type=checkbox]"));
    // Количество часов услуги — из поля «Сколько часов»
    expect(document.querySelector<HTMLInputElement>(".svc-qty input")?.value).toBe("5");
    await click(byText(".svc-choice-options label", /Украшение живыми цветами/)?.querySelector("input"));
    // Примерная сумма: 5 ч × 350 000 + 400 000 — подписана как предварительная
    await waitFor(() => document.querySelector(".estimate-sum b")?.textContent?.includes("2,2"), "сумма");
    expect(text(document.querySelector(".estimate") as HTMLElement)).toContain(
      "Точную сумму назовёт исполнитель",
    );
    await type(field("Как к вам обращаться"), "Азиза");
    await type(field("Телефон"), "00 123 45 67");
    await click(transferCheckbox());
    await click(byText("button", "Отправить заявку"));
    await waitFor(() => byText("h1", "Заявка отправлена"), "отправлено");
    // Искать дальше — в том же разделе, а не в залах
    expect(byText<HTMLAnchorElement>(".sent a", "К поиску")?.getAttribute("href")).toBe(
      "/catalog?category=car",
    );

    const created = (api as MockApi).created[0];
    expect(created).not.toHaveProperty("guests");
    expect(created?.details).toEqual({
      start_time: "17:30",
      hours: 5,
      cars_count: 2,
      services: [{ id: bride.id, qty: 5, options: [flowers.id] }],
    });
    expect((api as MockApi).requests[0]?.dayPart).toBe("evening");
  });

  it("фото: что снимать — обязательно, гости — по желанию; без отметки — ошибка у поля", async () => {
    const { api } = await mount({ path: "/venue/lahza-foto/request", mock: { listings: ALL } });
    await waitFor(() => transferCheckbox(), "форма");
    const guests = document.querySelector(`label[for="${field("Гостей")?.id}"]`);
    expect(guests?.textContent).toContain("по желанию");
    await click(byText("label.ui-radio", "Свадьба"));
    await pickDate(field("Дата события"), "20 окт");
    await choose(field("Начало"), "10:00");
    await type(field("Как к вам обращаться"), "Азиза");
    await type(field("Телефон"), "00 123 45 67");
    await click(transferCheckbox());
    await click(byText("button", "Отправить заявку"));
    expect(text()).toContain("Отметьте хотя бы один вариант");
    expect((api as MockApi).created).toHaveLength(0);
    await click(byText("fieldset label.ui-check", "Фото")?.querySelector("input"));
    await click(byText("fieldset label.ui-check", "Love story")?.querySelector("input"));
    await click(byText("button", "Отправить заявку"));
    await waitFor(() => byText("h1", "Заявка отправлена"), "отправлено");
    expect((api as MockApi).created[0]?.details).toEqual({
      start_time: "10:00",
      coverage: ["photo", "love_story"],
    });
    expect((api as MockApi).requests[0]?.dayPart).toBe("morning");
  });

  it("торт: дата раньше срока заказа не предлагается; сервер всё же отказал — понятно почему", async () => {
    const api = createMockApi({
      now: () => NOW,
      listings: ALL,
      failWith: (method) =>
        method === "createRequest"
          ? new ApiError(422, "lead_time_too_short", undefined, undefined, ["eventDate"])
          : null,
    });
    // Дата из каталога раньше срока (3 дня) в форму не переносится
    await mount({ path: "/venue/milliy-shirinlik/request?date=2026-10-03", api });
    await waitFor(() => transferCheckbox(), "форма");
    expect(field("Дата события")?.textContent).toContain("Выберите дату");
    // Срок — с ближайшей датой, на которую можно заказать
    expect(text()).toContain("Заказывают минимум за 3 дня: ближайшая дата — 4 окт.");
    await click(field("Дата события"));
    expect(
      document.querySelector('button.ui-cal-day[aria-label^="3 окт"]')?.getAttribute("aria-disabled"),
    ).toBe("true");
    await click(document.querySelector('button.ui-cal-day[aria-label^="10 окт"]'));
    await click(byText("label.ui-radio", "Свадьба"));
    await click(byText("label.ui-radio", "Самовывоз"));
    // Самовывоз — района доставки нет; доставка — есть
    expect(field("Район доставки")).toBeNull();
    await click(byText("label.ui-radio", "Доставка"));
    expect(field("Район доставки")).not.toBeNull();
    await type(field("Как к вам обращаться"), "Азиза");
    await type(field("Телефон"), "00 123 45 67");
    await click(transferCheckbox());
    await click(byText("button", "Отправить заявку"));
    await waitFor(() => document.querySelector(".form-error"), "ошибка");
    expect(text()).toContain("исполнителю нужно больше времени на подготовку");
    expect(document.querySelector(`#${CSS.escape(field("Дата события")?.id ?? "x")}-error`)).not.toBeNull();
  });

  it("студия: время, часы и сколько человек обязательны; гостей не спрашивают", async () => {
    const { api } = await mount({ path: "/venue/oydin-studio/request", mock: { listings: ALL } });
    await waitFor(() => transferCheckbox(), "форма");
    expect(field("Гостей")).toBeNull();
    await click(byText("label.ui-radio", "Свадьба"));
    await pickDate(field("Дата события"), "20 окт");
    await type(field("Как к вам обращаться"), "Азиза");
    await type(field("Телефон"), "00 123 45 67");
    await click(transferCheckbox());
    await click(byText("button", "Отправить заявку"));
    expect([...document.querySelectorAll(".fld-error")].map((e) => e.textContent)).toEqual([
      "Укажите время",
      "Заполните это поле",
      "Заполните это поле",
    ]);
    await choose(field("Начало"), "15:00");
    await type(field("Сколько часов"), "2");
    await type(field("Сколько человек"), "4");
    await click(byText("button", "Отправить заявку"));
    await waitFor(() => byText("h1", "Заявка отправлена"), "отправлено");
    expect((api as MockApi).created[0]).toMatchObject({
      details: { start_time: "15:00", hours: 2, people: 4 },
    });
    // У студии частей дня нет
    expect((api as MockApi).requests[0]?.dayPart).toBeNull();
  });
});

describe("мои заявки: категория, часть дня и детали", () => {
  it("кортеж — категория, «вечер», детали строками; похожие — в ту же категорию на ту же дату", async () => {
    const requests = demoRequests(ALL, NOW);
    await mount({ path: "/requests", mock: { listings: ALL, requests } });
    await waitFor(() => document.querySelectorAll(".req").length === requests.length, "заявки");
    const car = [...document.querySelectorAll(".req")].find((r) => r.textContent?.includes("Oq Kortej"));
    // Факты — через точку; перенос только после неё, число с подписью не разрывается
    expect(car?.querySelector(".req-main .muted")?.textContent).toBe(
      "Кортежи\u00a0· Свадьба\u00a0· 6\u00a0дек\u00a0· вечер\u00a0· Заявка №\u00a01044",
    );
    expect(car?.querySelector(".req-main .muted")?.textContent).toContain("вечер");
    const details = [...(car?.querySelectorAll(".req-details li") ?? [])].map((li) => li.textContent);
    expect(details).toEqual([
      "Начало: 17:30",
      "Сколько часов: 5",
      "Сколько машин: 2",
      "Класс машины: Премиум",
      "Какие услуги нужны: Машина для молодожёнов × 5 (+Украшение живыми цветами)",
    ]);
    await settle();
  });
});
