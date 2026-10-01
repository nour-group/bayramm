// @vitest-environment jsdom
import { dictionaries, LANGS } from "@bayramm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "./api/errors";
import { createMockApi } from "./api/mock";
import { LANG_KEY } from "./context";
import {
  allHumanText,
  byText,
  calendarDay,
  cleanup,
  click,
  field,
  LISTINGS,
  mount,
  NOW,
  pickDate,
  settle,
  text,
  type,
  waitFor,
} from "./test/harness";

/* Правила продукта из prototypes/client/smoke.js — на настоящем приложении.
   Упал тест — нарушено обещание клиенту, а не вёрстка. */

const VENUE = LISTINGS[0];
if (!VENUE) throw new Error("нет демо-площадки");
const VENUE_PATH = `/venue/${VENUE.slug}`;
const FORM_PATH = `${VENUE_PATH}/request`;
/** Через неделю после «сегодня»: каждая третья демо-площадка на эту дату занята */
const BUSY_DAY = "2026-10-08";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  // Язык браузера в jsdom — английский, приложение взяло бы узбекский; тексты проверяем по-русски
  window.sessionStorage.setItem(LANG_KEY, "ru");
  window.scrollTo = () => {};
});

afterEach(cleanup);

/** Заполнить форму заявки полностью, кроме согласия */
async function fillForm(comment = "Нужен детский стол") {
  await click(byText("label.ui-radio", "Свадьба"));
  await pickDate(field("Дата события"), "15 окт");
  await type(field("Гостей"), "100");
  await type(field("Как к вам обращаться"), "Азиза");
  await type(field("Телефон"), "00 123 45 67");
  await type(field("Комментарий"), comment);
}

const transferCheckbox = () =>
  byText<HTMLLabelElement>("label.consent-check", /Разрешаю передать/)?.querySelector("input") ?? null;

describe("правила продукта", () => {
  it("телефон и кнопка звонка видны до заявки, и гостю тоже", async () => {
    const { api } = await mount({ path: VENUE_PATH, identity: "guest" });
    await waitFor(() => document.querySelector("h1")?.textContent === VENUE.name, "карточка площадки");
    const calls = [...document.querySelectorAll<HTMLAnchorElement>(`a[href="tel:${VENUE.phone}"]`)];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(text()).toContain("+998 00 000 00 01");
    expect((api as ReturnType<typeof createMockApi>).created).toHaveLength(0);
  });

  it("«заявка, не бронь»: ни на одном экране обоих языков нет «брон»", async () => {
    const forbidden = /брон|bron|band\s+qil/i;
    for (const lang of LANGS) {
      window.sessionStorage.setItem(LANG_KEY, lang);
      for (const path of ["/", VENUE_PATH, FORM_PATH, "/requests", "/profile", "/nope"]) {
        await mount({ path, mock: { requests: [] } });
        await settle();
        expect(allHumanText(), `${lang} ${path}`).not.toMatch(forbidden);
        cleanup();
      }
    }
    // Словари целиком: и то, что экраны v0.1 ещё не показывают
    for (const lang of LANGS) expect(JSON.stringify(dictionaries[lang])).not.toMatch(forbidden);
  });

  it("рейтинга и числа отзывов нет — вместо них «Новый»", async () => {
    await mount({ path: "/catalog" });
    await waitFor(() => document.querySelectorAll(".card").length > 0, "карточки");
    const cards = [...document.querySelectorAll(".card")];
    // На глаз — «Новый», диктору — полный смысл «Новый на площадке»; подсказка мыши — не title
    for (const card of cards) {
      expect(card.querySelector('.badge-new [aria-hidden="true"]')?.textContent).toBe("Новый");
      expect(card.querySelector(".badge-new .sr-only")?.textContent).toBe("Новый на площадке");
      expect(card.querySelector(".badge-new")?.hasAttribute("title")).toBe(false);
    }
    expect(allHumanText()).not.toMatch(/★|рейтинг|reyting|отзыв|sharh/i);
    cleanup();

    await mount({ path: VENUE_PATH });
    await waitFor(() => document.querySelector("h1")?.textContent === VENUE.name, "карточка площадки");
    expect(document.querySelector('.venue-head .badge-new [aria-hidden="true"]')?.textContent).toBe("Новый");
    expect(allHumanText()).not.toMatch(/★|рейтинг|reyting|отзыв|sharh/i);
  });

  it("занятые на дату — в конце выдачи, не спрятаны и помечены", async () => {
    await mount({ path: `/catalog?date=${BUSY_DAY}` });
    await waitFor(() => document.querySelectorAll(".card").length > 0, "карточки");
    const cards = [...document.querySelectorAll(".card")];
    const busy = cards.map((card) => card.classList.contains("busy"));
    expect(busy.some(Boolean)).toBe(true);
    expect(busy.indexOf(true)).toBeGreaterThan(0);
    // После первого занятого свободных нет
    expect(busy.slice(busy.indexOf(true)).every(Boolean)).toBe(true);
    for (const card of cards.filter((c) => c.classList.contains("busy")))
      expect(card.querySelector(".chip-busy")?.textContent).toBe("8 окт — занято");
  });

  it("порядок по цене не меняет правило «занятые внизу»", async () => {
    await mount({ path: `/catalog?date=${BUSY_DAY}&sort=price_desc` });
    await waitFor(() => document.querySelectorAll(".card").length > 0, "карточки");
    const busy = [...document.querySelectorAll(".card")].map((card) => card.classList.contains("busy"));
    expect(busy.slice(busy.indexOf(true)).every(Boolean)).toBe(true);
  });

  it("согласия раздельные, не отмечены; отказ того же размера, что отправка", async () => {
    const { api } = await mount({ path: FORM_PATH });
    await waitFor(() => transferCheckbox(), "форма заявки");
    const boxes = [...document.querySelectorAll<HTMLInputElement>(".consents input[type=checkbox]")];
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => !box.checked && !box.defaultChecked)).toBe(true);
    expect(new Set(boxes.map((box) => box.id)).size).toBe(2);

    const bar = document.querySelector(".form-bar");
    const buttons = [...(bar?.querySelectorAll("button") ?? [])];
    expect(buttons.map((b) => b.textContent)).toEqual(["Не сейчас", "Отправить заявку"]);
    // Размер задаёт один класс .btn и сетка 1fr 1fr у .form-bar (styles.test.ts)
    expect(buttons.every((b) => b.classList.contains("btn"))).toBe(true);

    // Без галочки заявка не уходит
    await fillForm();
    await click(byText("button", "Отправить заявку"));
    expect((api as ReturnType<typeof createMockApi>).created).toHaveLength(0);
    expect(text()).toContain("Без этого согласия исполнитель не получит заявку");
  });

  it("полный текст согласия читается прямо в форме", async () => {
    await mount({ path: FORM_PATH });
    await waitFor(() => transferCheckbox(), "форма заявки");
    const toggle = byText<HTMLButtonElement>(".consent button", "Текст согласия");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(text()).toContain("Демо-текст согласия на передачу заявки исполнителю");
  });

  it("клиент не платит: в форме нет платёжных полей", async () => {
    await mount({ path: FORM_PATH });
    await waitFor(() => transferCheckbox(), "форма заявки");
    const inputs = [...document.querySelectorAll("input, select, textarea")];
    expect(inputs.filter((el) => /^cc-/.test(el.getAttribute("autocomplete") ?? ""))).toEqual([]);
    expect(allHumanText()).not.toMatch(/оплат|карты|to[ʻ']lov/i);
  });
});

describe("заявка от начала до конца", () => {
  it("комментарий не теряется: переживает уход с формы и уходит в заявку", async () => {
    const { api } = await mount({ path: FORM_PATH });
    await waitFor(() => transferCheckbox(), "форма заявки");
    await fillForm("Нужен детский стол и сцена");

    // Ушли на площадку и вернулись — всё на месте
    await click(byText("button", "Не сейчас"));
    await waitFor(() => document.querySelector("h1")?.textContent === VENUE.name, "карточка площадки");
    await click(byText("a", "Оставить заявку"));
    await waitFor(() => transferCheckbox(), "форма заявки");
    expect(field("Комментарий")?.value).toBe("Нужен детский стол и сцена");
    // Согласие заново: в черновик оно не пишется
    expect(transferCheckbox()?.checked).toBe(false);

    await click(transferCheckbox());
    await click(byText("button", "Отправить заявку"));
    await waitFor(() => byText("h1", "Заявка отправлена"), "экран «отправлено»");

    const created = (api as ReturnType<typeof createMockApi>).created;
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      listingId: VENUE.id,
      occasionCode: "toy",
      eventDate: "2026-10-15",
      guests: 100,
      contactName: "Азиза",
      contactPhone: "+998001234567",
      comment: "Нужен детский стол и сцена",
      requestTransferConsentId: "demo-request_transfer-ru",
    });
    // Уведомления не отмечали — их согласия в заявке нет
    expect(created[0]).not.toHaveProperty("notifyConsentId");
    // После отправки звонок — первым делом, черновик стёрт
    expect(document.querySelector(`.sent a[href="tel:${VENUE.phone}"]`)).not.toBeNull();
    expect(window.sessionStorage.getItem(`bayramm.web.draft.${VENUE.slug}`)).toBeNull();
  });

  it("отказ сервера (лимит заявок) — понятный текст, форма и комментарий на месте", async () => {
    await mount({
      path: FORM_PATH,
      mock: {
        failWith: (method) => (method === "createRequest" ? new ApiError(429, "daily_request_limit") : null),
      },
    });
    await waitFor(() => transferCheckbox(), "форма заявки");
    await fillForm("Сцена и детский стол");
    await click(transferCheckbox());
    await click(byText("button", "Отправить заявку"));
    await waitFor(() => byText(".form-error", /слишком много заявок/), "текст ошибки");
    expect(field("Комментарий")?.value).toBe("Сцена и детский стол");
    expect(transferCheckbox()?.checked).toBe(true);
  });

  it("гости сверяются с вместимостью", async () => {
    const { api } = await mount({ path: FORM_PATH });
    await waitFor(() => transferCheckbox(), "форма заявки");
    await fillForm();
    await type(field("Гостей"), String((VENUE.capMax ?? 0) + 1));
    await click(transferCheckbox());
    await click(byText("button", "Отправить заявку"));
    expect(text()).toContain(`Зал вмещает до ${VENUE.capMax} гостей`);
    expect((api as ReturnType<typeof createMockApi>).created).toHaveLength(0);
  });

  it("заявка — с завтрашнего дня: сегодня выбрать нельзя", async () => {
    await mount({ path: `${FORM_PATH}?date=2026-10-01` });
    await waitFor(() => transferCheckbox(), "форма заявки");
    // Сегодняшняя дата из фильтра в форму не переносится
    const date = field("Дата события");
    expect(date?.textContent).toContain("Выберите дату");
    await click(date);
    expect(calendarDay("1 окт")?.getAttribute("aria-label")).toBe("1 окт");
    expect(calendarDay("1 окт")?.getAttribute("aria-disabled")).toBe("true");
    expect(calendarDay("2 окт")?.getAttribute("aria-label")).toBe("2 окт, свободно");
    expect(calendarDay("2 окт")?.hasAttribute("aria-disabled")).toBe(false);
  });

  it("занятую дату выбрать нельзя", async () => {
    await mount({ path: FORM_PATH });
    await waitFor(() => transferCheckbox(), "форма заявки");
    const date = field("Дата события");
    await click(date);
    const busyDay = calendarDay("8 окт");
    expect(busyDay?.getAttribute("aria-disabled")).toBe("true");
    expect(busyDay?.getAttribute("aria-label")).toBe("8 окт, занято");
    // Нажатие ничего не выбирает: календарь открыт, в поле — «Выберите дату»
    await click(busyDay);
    expect(calendarDay("8 окт")).not.toBeNull();
    expect(date?.textContent).toContain("Выберите дату");
  });

  it("повторная заявка на ту же дату (409) открывает уже отправленную", async () => {
    const api = createMockApi({ now: () => NOW, listings: LISTINGS });
    await mount({ path: FORM_PATH, api });
    await waitFor(() => transferCheckbox(), "форма заявки");
    await fillForm();
    await click(transferCheckbox());
    await click(byText("button", "Отправить заявку"));
    await waitFor(() => byText("h1", "Заявка отправлена"), "первая заявка");
    const first = api.requests[0];
    cleanup();

    await mount({ path: FORM_PATH, api });
    await waitFor(() => transferCheckbox(), "форма заявки");
    await fillForm();
    await click(transferCheckbox());
    await click(byText("button", "Отправить заявку"));
    await waitFor(() => window.location.pathname === "/requests", "переход в «Мои заявки»");
    expect(new URLSearchParams(window.location.search).get("open")).toBe(first?.id);
    await waitFor(() => document.querySelector(".req.highlighted"), "подсвеченная заявка");
    expect(text()).toContain("Заявка на эту дату уже отправлена");
    expect(api.created).toHaveLength(1);
  });

  it("вне Telegram — понятная ссылка в бота на эту площадку, телефон на месте", async () => {
    await mount({ path: FORM_PATH, identity: "guest" });
    const link = await waitFor(
      () => document.querySelector<HTMLAnchorElement>('a[href^="https://t.me/"]'),
      "ссылка в Telegram",
    );
    expect(link.getAttribute("href")).toBe(`https://t.me/bayramm_demo_bot?startapp=vendor_${VENUE.slug}`);
    expect(link.textContent).toContain("Открыть в Telegram");
    expect(document.querySelector("form")).toBeNull();
    await waitFor(() => document.querySelector(`a[href="tel:${VENUE.phone}"]`), "телефон площадки");
  });
});
