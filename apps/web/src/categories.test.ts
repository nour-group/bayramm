import { dictionaries } from "@bayramm/shared";
import type { ListingDetail, PublicService } from "@bayramm/shared/api";
import { categoryConfig, categoryFilters } from "@bayramm/shared/categories";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api/errors";
import { allDemoListings, createMockApi, demoDayLoad, matchesAttributeFilter } from "./api/mock";
import { CLIENT_CATEGORIES, clientCategory, hasCalendar, hasCapacity, hasDistrict } from "./categories";
import { formatPrice, formatPriceFrom, formatQty, qtyQuestion, unitText } from "./format";
import {
  attrFilterCount,
  filterValue,
  parseFilterInt,
  readAttrFilters,
  withFilter,
} from "./screens/catalog-filters";
import {
  BUDGETS,
  BUDGETS_SMALL,
  budgetScale,
  type Draft,
  EMPTY_DRAFT,
  fieldOrder,
  firstDate,
  leadDaysOf,
  toCreateRequest,
  toDetails,
  validate,
} from "./screens/request-draft";
import { estimate, hasQty, lineTotal, suggestedQty } from "./screens/request-estimate";
import { attributeView, dayPartWindow, listingLeadDays, safeVideoLinks } from "./screens/venue-attributes";

/* Категории в клиенте без экранов: фильтры из описания категории, примерная сумма заявки,
   проверка и тело заявки по форме категории, поля витрины, единицы цены, демо-API */

const ru = dictionaries.ru;
/** Неразрывные пробелы денег — обычными: так их пишет тест */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value).replace(/\u00a0/g, " "));
const TODAY = "2026-10-01";
const ALL = allDemoListings(TODAY);
const by = (slug: string): ListingDetail => {
  const listing = ALL.find((l) => l.slug === slug);
  if (!listing) throw new Error(`нет демо-витрины ${slug}`);
  return listing;
};
const config = (code: string) => {
  const c = categoryConfig(code);
  if (!c) throw new Error(`нет категории ${code}`);
  return c;
};
const service = (listing: ListingDetail, type: string): PublicService => {
  const s = listing.services.find((x) => x.type === type);
  if (!s) throw new Error(`нет услуги ${type}`);
  return s;
};

describe("категории клиента", () => {
  it("в каталоге — включённые по порядку; неизвестная и выключенная — залы", () => {
    expect(CLIENT_CATEGORIES.map((c) => c.code)).toEqual([
      "hall",
      "car",
      "studio",
      "flowers",
      "photo",
      "cake",
      "gifts",
      "decor",
    ]);
    expect(clientCategory("food").code).toBe("hall");
    expect(clientCategory(null).code).toBe("hall");
    expect(clientCategory("cake").code).toBe("cake");
  });

  it("вместимость — у залов, район — у залов и студий, календаря нет у срока заказа", () => {
    expect(CLIENT_CATEGORIES.filter(hasCapacity).map((c) => c.code)).toEqual(["hall"]);
    expect(CLIENT_CATEGORIES.filter(hasDistrict).map((c) => c.code)).toEqual(["hall", "studio"]);
    expect(CLIENT_CATEGORIES.filter((c) => !hasCalendar(c)).map((c) => c.code)).toEqual([
      "flowers",
      "cake",
      "gifts",
    ]);
  });
});

describe("единицы цены", () => {
  it("цена «от» — с единицей категории; за мероприятие — без подписи", () => {
    expect(plain(formatPriceFrom(300_000, "per_hour", ru))).toEqual({
      amount: "от 300 000 сум",
      unit: "за час",
    });
    expect(formatPriceFrom(180_000, "per_kg", ru).unit).toBe("за кг");
    expect(formatPriceFrom(25_000, "per_item", ru).unit).toBe("за шт.");
    expect(formatPriceFrom(900_000, "per_set", ru).unit).toBe("за комплект");
    expect(formatPriceFrom(350_000, "per_table", ru).unit).toBe("за стол");
    expect(formatPriceFrom(150_000, "per_guest", ru).unit).toBe("за гостя");
    expect(formatPriceFrom(25_000_000, "per_event", ru).unit).toBeNull();
    expect(plain(formatPrice(350_000, "per_hour", ru))).toBe("350 000 сум за час");
    expect(plain(formatPrice(2_500_000, "per_event", ru))).toBe("2,5 млн сум");
    expect(plain(formatPriceFrom(300_000, "per_hour", dictionaries.uz))).toEqual({
      amount: "300 000 soʻmdan",
      unit: "soatiga",
    });
  });

  it("количество в единице цены и вопрос поля количества", () => {
    expect(formatQty("per_hour", 3, ru)).toBe("3 ч");
    expect(formatQty("per_kg", 5, ru)).toBe("5 кг");
    expect(formatQty("per_item", 50, ru)).toBe("50 шт.");
    expect(formatQty("per_table", 2, ru)).toBe("2 стола");
    expect(formatQty("per_guest", 100, ru)).toBe("100 гостей");
    expect(formatQty("per_event", 1, ru)).toBeNull();
    expect(qtyQuestion("per_hour", ru)).toBe("Сколько часов");
    expect(qtyQuestion("per_event", ru)).toBeNull();
    expect(unitText("per_set", ru)).toBe("за комплект");
  });
});

describe("фильтры по полям витрины", () => {
  const car = config("car");
  const photo = config("photo");

  it("из адреса — только фильтры категории и только верные значения", () => {
    const query = new URLSearchParams(
      "a.fleet.class=premium,suv&a.decoration=1&a.fleet.seats=6&a.fleet.year=2020&a.parking_spaces=10&a.service_area=mars",
    );
    expect(readAttrFilters(car, query)).toEqual({
      "a.fleet.class": "premium,suv",
      "a.decoration": "1",
      "a.fleet.seats": "6",
    });
    // «нет» у галочки — не фильтр
    expect(readAttrFilters(car, new URLSearchParams("a.decoration=0"))).toEqual({});
  });

  it("значение для контрола и новое значение — в порядке вариантов, пустое убирает параметр", () => {
    const [fleetClass] = categoryFilters(car).filter((s) => s.param === "a.fleet.class");
    if (!fleetClass) throw new Error("нет фильтра класса");
    const attrs = withFilter({}, fleetClass, { kind: "codes", codes: ["suv", "premium"] });
    expect(attrs).toEqual({ "a.fleet.class": "premium,suv" });
    expect(filterValue(fleetClass, attrs)).toEqual({ kind: "codes", codes: ["premium", "suv"] });
    expect(withFilter(attrs, fleetClass, { kind: "codes", codes: [] })).toEqual({});
    expect(attrFilterCount({ ...attrs, "a.decoration": "1" })).toBe(2);

    const [days] = categoryFilters(photo).filter((s) => s.param === "a.delivery_days");
    if (!days) throw new Error("нет фильтра срока");
    expect(parseFilterInt(days, "30")).toBe(30);
    expect(parseFilterInt(days, "0")).toBeNull();
    expect(parseFilterInt(days, "999")).toBeNull();
    expect(withFilter({}, days, { kind: "int", value: 30 })).toEqual({ "a.delivery_days": "30" });
    expect(withFilter({ "a.delivery_days": "30" }, days, { kind: "int", value: null })).toEqual({});
  });

  it("демо-API отбирает по полям витрины так же, как SQL каталога", () => {
    const oq = by("oq-kortej");
    expect(
      matchesAttributeFilter(oq.attributes, {
        kind: "any",
        path: ["fleet", "class"],
        values: ["premium"],
        multi: false,
      }),
    ).toBe(true);
    expect(matchesAttributeFilter(oq.attributes, { kind: "min", path: ["fleet", "seats"], value: 5 })).toBe(
      false,
    );
    expect(matchesAttributeFilter(oq.attributes, { kind: "eq", path: ["decoration"] })).toBe(true);
    const kadr = by("kadr-media");
    expect(
      matchesAttributeFilter(kadr.attributes, {
        kind: "all",
        path: ["team"],
        values: ["photographer", "drone_operator"],
      }),
    ).toBe(true);
    expect(matchesAttributeFilter(kadr.attributes, { kind: "max", path: ["delivery_days"], value: 14 })).toBe(
      false,
    );
  });
});

describe("примерная сумма заявки", () => {
  const oq = by("oq-kortej");
  const bride = service(oq, "bride_car");
  const shirin = by("shirin-cake");

  it("за час — × количество; опция той же единицы — × количество, «дополнительный час» — один", () => {
    const flowers = bride.options.find((o) => o.code === "flower_decor");
    const extra = bride.options.find((o) => o.code === "extra_hour");
    if (!flowers || !extra) throw new Error("нет опций");
    expect(lineTotal(bride, { qty: 5, options: [] }, null)).toBe(5 * 350_000);
    expect(lineTotal(bride, { qty: 5, options: [flowers.id, extra.id] }, null)).toBe(
      5 * 350_000 + 400_000 + 350_000,
    );
    // Без количества — минимальное у вендора
    expect(lineTotal(bride, { qty: null, options: [] }, null)).toBe(3 * 350_000);
  });

  it("за гостя — × гостей; гостей нет — посчитать нельзя, об этом говорит итог", () => {
    const candy = service(shirin, "candy_bar");
    const cake = service(shirin, "wedding_cake");
    expect(lineTotal(candy, { qty: null, options: [] }, 120)).toBe(120 * 60_000);
    expect(lineTotal(candy, { qty: null, options: [] }, null)).toBeNull();
    const total = estimate(
      shirin.services,
      [
        { id: cake.id, qty: 6, options: [] },
        { id: candy.id, qty: null, options: [] },
      ],
      null,
    );
    expect(total).toEqual({ total: 6 * 180_000, counted: 1, needsGuests: true });
  });

  it("опция штучной единицы у штучной услуги — на каждую штуку (имя на бонбоньерке)", () => {
    const bon = service(by("sovga-uyi"), "bonbonniere");
    const print = bon.options[0];
    if (!print) throw new Error("нет опции");
    expect(lineTotal(bon, { qty: 100, options: [print.id] }, null)).toBe(100 * 25_000 + 100 * 5_000);
  });

  it("количество, которое предлагает форма: из поля той же единицы, не меньше минимального", () => {
    expect(hasQty("per_hour")).toBe(true);
    expect(hasQty("per_event")).toBe(false);
    expect(hasQty("per_guest")).toBe(false);
    expect(suggestedQty(bride, { hours: "6" })).toBe("6");
    expect(suggestedQty(bride, { hours: "1" })).toBe("3");
    expect(suggestedQty(bride, {})).toBe("3");
    expect(suggestedQty(service(shirin, "wedding_cake"), { weight_kg: "8" })).toBe("8");
    expect(suggestedQty(service(by("kadr-media"), "videography"), {})).toBe("");
  });
});

describe("форма заявки по категории", () => {
  const consents = {
    transfer: { id: "t1", purpose: "request_transfer", version: 1, locale: "ru", body: "" },
    notify: null,
  } as const;
  const base: Draft = {
    ...EMPTY_DRAFT,
    occasion: "toy",
    date: "2026-10-20",
    name: "Азиза",
    phone: "90 123 45 67",
  };
  const context = (listing: ListingDetail) => ({
    listing,
    category: config(listing.categoryCode),
    busy: new Set(listing.busyDates),
    today: TODAY,
    transferChecked: true,
  });

  it("кортеж: время, часы и машины обязательны; гостей не спрашивают и не передают", () => {
    const oq = by("oq-kortej");
    const errors = validate(base, context(oq), ru);
    expect(errors).toEqual({
      "d.start_time": ru.errTime,
      "d.hours": ru.errRequired,
      "d.cars_count": ru.errRequired,
    });
    const filled: Draft = { ...base, values: { start_time: "17:30", hours: "5", cars_count: "2" } };
    expect(validate(filled, context(oq), ru)).toEqual({});
    const body = toCreateRequest(filled, oq, config("car"), consents);
    expect(body).not.toHaveProperty("guests");
    expect(body.details).toEqual({ start_time: "17:30", hours: 5, cars_count: 2 });
    expect(fieldOrder(config("car"), filled)).not.toContain("guests");
  });

  it("часть дня: время начала в занятой части — ошибка у поля времени", () => {
    const oq = by("oq-kortej");
    // 8 октября у «Oq Kortej» занят вечер
    const draft: Draft = {
      ...base,
      date: "2026-10-08",
      values: { start_time: "18:00", hours: "4", cars_count: "1" },
    };
    expect(validate(draft, context(oq), ru)["d.start_time"]).toBe(ru.errPartBusy("вечер"));
    expect(validate({ ...draft, values: { ...draft.values, start_time: "09:00" } }, context(oq), ru)).toEqual(
      {},
    );
  });

  it("услуги: количество не меньше минимального, опции — только этой услуги; уходят снимком id", () => {
    const oq = by("oq-kortej");
    const bride = service(oq, "bride_car");
    const draft: Draft = {
      ...base,
      values: { start_time: "10:00", hours: "4", cars_count: "1" },
      services: [{ id: bride.id, qty: "2", options: [bride.options[0]?.id ?? ""] }],
    };
    expect(validate(draft, context(oq), ru)[`svc.${bride.id}`]).toBe(ru.errMinQty("3 ч"));
    const ok: Draft = { ...draft, services: [{ ...draft.services[0], id: bride.id, qty: "4", options: [] }] };
    expect(validate(ok, context(oq), ru)).toEqual({});
    expect(toDetails(config("car"), oq, ok).services).toEqual([{ id: bride.id, qty: 4, options: [] }]);
  });

  it("цветы: хотя бы одна услуга обязательна; район доставки — только при доставке", () => {
    const gulzor = by("gulzor-flowers");
    const draft: Draft = { ...base, values: { fulfillment: "pickup", delivery_district: "chilonzor" } };
    expect(validate(draft, context(gulzor), ru)).toEqual({ services: ru.errServices });
    expect(toDetails(config("flowers"), gulzor, draft)).toEqual({ fulfillment: "pickup" });
  });

  it("торт: срок заказа — с витрины и услуг; раньше — ошибка у даты с первой возможной датой", () => {
    const milliy = by("milliy-shirinlik");
    const cake = service(milliy, "wedding_cake");
    expect(listingLeadDays(milliy)).toBe(3);
    expect(leadDaysOf(milliy, [])).toBe(3);
    expect(leadDaysOf(milliy, [cake.id])).toBe(7);
    expect(firstDate(TODAY, 7)).toBe("2026-10-08");
    const draft: Draft = {
      ...base,
      date: "2026-10-05",
      values: { fulfillment: "pickup" },
      services: [{ id: cake.id, qty: "5", options: [] }],
    };
    expect(validate(draft, context(milliy), ru).date).toBe(ru.errLead(7, "8 окт"));
    expect(validate({ ...draft, date: "2026-10-08" }, context(milliy), ru)).toEqual({});
  });

  it("гости: у зала обязательны и не больше вместимости, у торта — по желанию", () => {
    const hall = ALL[0] as ListingDetail;
    expect(validate(base, context(hall), ru).guests).toBe(ru.errGuests);
    const tooMany = { ...base, guests: String((hall.capMax ?? 0) + 1) };
    expect(validate(tooMany, context(hall), ru).guests).toBe(ru.errGuestsMax(hall.capMax ?? 0));
    const shirin = by("shirin-cake");
    const cake: Draft = { ...base, date: "2026-10-10", values: { fulfillment: "pickup" } };
    expect(validate(cake, context(shirin), ru)).toEqual({});
    expect(toCreateRequest(cake, shirin, config("cake"), consents)).not.toHaveProperty("guests");
    expect(toCreateRequest({ ...cake, guests: "80" }, shirin, config("cake"), consents).guests).toBe(80);
  });

  it("бюджет: у залов — десятки миллионов, у остальных — шкала поменьше", () => {
    expect(budgetScale(config("hall"))).toBe(BUDGETS);
    expect(budgetScale(config("cake"))).toBe(BUDGETS_SMALL);
    const shirin = by("shirin-cake");
    const body = toCreateRequest(
      { ...base, budget: 1, values: { fulfillment: "pickup" } },
      shirin,
      config("cake"),
      consents,
    );
    expect(body).toMatchObject({ budgetMinUzs: 3_000_000, budgetMaxUzs: 7_000_000 });
  });
});

describe("поля витрины на странице", () => {
  it("кортеж: автопарк списком, особенности — только «да», срок заказа — не здесь", () => {
    const view = attributeView(config("car"), by("oq-kortej").attributes, "ru");
    expect(view.lists).toEqual([
      {
        label: "Автопарк",
        items: [
          "Chevrolet Malibu · Седан · Белый · Мест: 4 · Год выпуска: 2022",
          "Mercedes-Benz E-Class · Премиум · Чёрный · Мест: 4 · Год выпуска: 2020",
        ],
      },
    ]);
    expect(view.features).toEqual(["Украшение машины"]);
    expect(view.facts).toEqual([
      { label: "Где работает", value: "Ташкент" },
      { label: "Минимальный заказ, часов", value: "3" },
    ]);
    const cake = attributeView(config("cake"), by("shirin-cake").attributes, "ru");
    expect(cake.facts.map((f) => f.label)).not.toContain("Заказ не позже чем за, дней");
  });

  it("студия: текст на двух языках, числа", () => {
    const uz = attributeView(config("studio"), by("oydin-studio").attributes, "uz");
    expect(uz.facts).toContainEqual({
      label: "Studiya zonalari",
      value: "Oq zal, polgacha deraza, klassik interyer, loft",
    });
    expect(uz.facts).toContainEqual({ label: "Maydoni, m²", value: "180" });
  });

  it("видео — только канонические ссылки YouTube и Instagram; чужой адрес не показываем", () => {
    expect(
      safeVideoLinks([
        "https://www.youtube.com/watch?v=demoKadr001",
        "https://www.instagram.com/reel/demoKadrReel/",
        "javascript:alert(1)",
        "https://evil.example/video",
      ]),
    ).toEqual([
      { href: "https://www.youtube.com/watch?v=demoKadr001", host: "YouTube" },
      { href: "https://www.instagram.com/reel/demoKadrReel/", host: "Instagram" },
    ]);
  });

  it("окна частей дня категории", () => {
    expect(dayPartWindow(config("photo"), "morning")).toBe("05:00–11:00");
    expect(dayPartWindow(config("car"), "evening")).toBe("17:00–24:00");
  });
});

describe("демо-API по контракту категорий", () => {
  const now = () => Date.parse("2026-10-01T07:00:00Z");

  it("категории с числом витрин; без category — залы; фильтр неизвестный — 400", async () => {
    const api = createMockApi({ now, listings: ALL });
    const categories = await api.catalogCategories();
    expect(categories.items.map((c) => [c.code, c.listings])).toEqual([
      ["hall", 24],
      ["car", 3],
      ["studio", 3],
      ["flowers", 3],
      ["photo", 3],
      ["cake", 3],
      ["gifts", 3],
      ["decor", 3],
    ]);
    expect((await api.catalog({ limit: 50 })).items.every((c) => c.categoryCode === "hall")).toBe(true);
    const cars = await api.catalog({ category: "car", filters: { "a.fleet.class": "limousine" } });
    expect(cars.items.map((c) => c.slug)).toEqual(["limuzin-lux"]);
    await expect(
      api.catalog({ category: "car", filters: { "a.parking_spaces": "5" } }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
      details: ["a.parking_spaces"],
    });
  });

  it("загрузка на дату: свободно, частично занято, занято; у срока заказа календаря нет", async () => {
    expect(demoDayLoad(by("oq-kortej"), "2026-10-08")).toBe("partial");
    expect(demoDayLoad(by("limuzin-lux"), "2026-10-08")).toBe("busy");
    expect(demoDayLoad(by("retro-avto"), "2026-10-08")).toBe("free");
    expect(demoDayLoad(by("shirin-cake"), "2026-10-08")).toBe("free");
    const api = createMockApi({ now, listings: ALL });
    const page = await api.catalog({ category: "car", date: "2026-10-08" });
    // Занятые целиком — в конце, частично занятые — среди свободных
    expect(page.items.map((c) => [c.slug, c.dateLoad])).toEqual([
      ["oq-kortej", "partial"],
      ["retro-avto", "free"],
      ["limuzin-lux", "busy"],
    ]);
  });

  it("заявка по форме категории: гости, поля, услуги, срок заказа; часть дня и снимок услуг", async () => {
    const api = createMockApi({ now, listings: ALL });
    const oq = by("oq-kortej");
    const bride = service(oq, "bride_car");
    const send = (body: Record<string, unknown>) =>
      api.createRequest({
        listingId: oq.id,
        occasionCode: "toy",
        eventDate: "2026-10-20",
        contactName: "Азиза",
        contactPhone: "+998901234567",
        requestTransferConsentId: "t1",
        ...body,
      });
    await expect(
      send({ guests: 100, details: { start_time: "10:00", hours: 3, cars_count: 1 } }),
    ).rejects.toMatchObject({ code: "invalid_request", details: ["guests"] });
    await expect(send({ details: { start_time: "10:00" } })).rejects.toMatchObject({
      details: ["details.hours", "details.cars_count"],
    });
    await expect(
      send({
        details: { start_time: "10:00", hours: 3, cars_count: 1, services: [{ id: bride.id, qty: 1 }] },
      }),
    ).rejects.toMatchObject({ details: ["details.services.0.qty"] });
    await send({
      details: {
        start_time: "18:30",
        hours: 5,
        cars_count: 2,
        services: [{ id: bride.id, qty: 5, options: [bride.options[0]?.id] }],
      },
    });
    const [request] = (await api.myRequests()).items;
    expect(request?.dayPart).toBe("evening");
    expect(request?.guests).toBeNull();
    expect(request?.details.services).toEqual([
      expect.objectContaining({
        id: bride.id,
        qty: 5,
        priceUzs: 350_000,
        options: [expect.objectContaining({ priceUzs: 400_000 })],
      }),
    ]);

    const milliy = by("milliy-shirinlik");
    const cake = service(milliy, "wedding_cake");
    const early = api.createRequest({
      listingId: milliy.id,
      occasionCode: "toy",
      eventDate: "2026-10-05",
      details: { fulfillment: "pickup", services: [{ id: cake.id, qty: 5 }] },
      contactName: "Азиза",
      contactPhone: "+998901234567",
      requestTransferConsentId: "t1",
    });
    await expect(early).rejects.toBeInstanceOf(ApiError);
    await expect(early).rejects.toMatchObject({ status: 422, code: "lead_time_too_short" });
  });
});
