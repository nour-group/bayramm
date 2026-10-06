import { describe, expect, it } from "vitest";
import { hasNonCanonicalApostrophe, normalizeUz } from "../i18n/uz-apostrophe";
import {
  AVAILABILITY_MODES,
  CATEGORIES,
  CATEGORY_CODES,
  type CategoryConfig,
  categoriesRu,
  categoriesUz,
  categoryConfig,
  categoryFilters,
  categoryPriceUnits,
  DAY_PARTS,
  DEFAULT_DAY_PARTS,
  dayPartOf,
  detailsSummary,
  guestsAllowed,
  hasDayParts,
  mergeAttributes,
  missingAttributes,
  normalizeVideoLink,
  PRICE_UNITS,
  parseAttributeFilters,
  readAttributes,
  requiredAttributeKeys,
  SERVICE_LIMITS,
  VIDEO_LINK_DB_RE,
  validateAttributePatch,
  validateRequestDetails,
  validateServiceInput,
  validateVideoLinks,
} from "./index";

const cfg = (code: string): CategoryConfig => {
  const category = categoryConfig(code);
  if (category === undefined) throw new Error(`нет категории ${code}`);
  return category;
};
const hall = cfg("hall");
const car = cfg("car");
const photo = cfg("photo");
const UUID = "0b7e2c55-8a3c-4c1e-9f5d-2a6b8c9d0e1f";
const UUID2 = "1c8f3d66-9b4d-4d2f-8a6e-3b7c9d0e1f20";

// ── словарь категорий ───────────────────────────────────────────────────────

describe("словарь категорий", () => {
  const ru = Object.entries(categoriesRu);
  const uz = Object.entries(categoriesUz);

  it("одинаковые ключи в одном порядке, тексты не пустые", () => {
    expect(Object.keys(categoriesUz)).toEqual(Object.keys(categoriesRu));
    for (const [key, text] of [...ru, ...uz]) expect(text.trim(), key).not.toBe("");
  });

  it("правила продукта: заявка, а не бронь; продвижения нет", () => {
    expect(ru.filter(([, t]) => /брон|продвижен/i.test(t))).toEqual([]);
    expect(uz.filter(([, t]) => /bron|band\s+qil/i.test(t))).toEqual([]);
  });

  it("узбекский: латиница, апострофы U+02BB и U+02BC", () => {
    expect(uz.filter(([, t]) => /[Ѐ-ӿ]/.test(t))).toEqual([]);
    expect(uz.filter(([, t]) => hasNonCanonicalApostrophe(t) || normalizeUz(t) !== t)).toEqual([]);
  });

  it("каждый ключ нужен конфигурации (мёртвых текстов нет)", () => {
    const used = new Set<string>();
    for (const c of CATEGORIES) {
      used.add(c.label);
      for (const s of c.services) {
        used.add(s.label);
        for (const o of s.options) used.add(o.label);
      }
      for (const a of c.attributes) {
        used.add(a.label);
        if (a.type === "enum" || a.type === "multi") for (const o of a.options) used.add(o.label);
        if (a.type === "list") {
          for (const f of a.fields) {
            used.add(f.label);
            if (f.type === "enum") for (const o of f.options) used.add(o.label);
          }
        }
      }
      for (const f of c.requestForm.fields) {
        used.add(f.label);
        if (f.type === "enum" || f.type === "multi") for (const o of f.options) used.add(o.label);
      }
    }
    for (const unit of PRICE_UNITS) used.add(`unit_${unit}`);
    expect(Object.keys(categoriesRu).filter((key) => !used.has(key))).toEqual([]);
  });
});

// ── конфигурация ────────────────────────────────────────────────────────────

describe("конфигурация категорий", () => {
  it("все коды, без повторов; порядок показа уникален", () => {
    expect(CATEGORIES.map((c) => c.code)).toEqual([...CATEGORY_CODES]);
    expect(new Set(CATEGORIES.map((c) => c.sort)).size).toBe(CATEGORIES.length);
  });

  it("включены залы и приоритетные категории; остальные — заготовки только с «другой услугой»", () => {
    expect(CATEGORIES.filter((c) => c.enabled).map((c) => c.code)).toEqual([
      "hall",
      "car",
      "studio",
      "flowers",
      "photo",
      "cake",
      "gifts",
      "decor",
      "food",
      "restaurant",
      "attire",
      "zags",
    ]);
    for (const c of CATEGORIES.filter((x) => !x.enabled))
      expect(c.services.map((s) => s.code)).toEqual(["other"]);
  });

  it("порядок показа — путь пары: ЗАГС, тойхона, кортеж, фото и видео, студия, ресторан, цветы…", () => {
    const shown = CATEGORIES.filter((c) => c.enabled)
      .sort((a, b) => a.sort - b.sort)
      .map((c) => c.code);
    expect(shown).toEqual([
      "zags",
      "hall",
      "car",
      "photo",
      "studio",
      "restaurant",
      "flowers",
      "attire",
      "gifts",
      "food",
      "cake",
      "decor",
    ]);
  });

  it("режим занятости по категориям; части дня — только у parts", () => {
    const modes = Object.fromEntries(
      CATEGORIES.filter((c) => c.enabled).map((c) => [c.code, c.availability]),
    );
    expect(modes).toEqual({
      hall: "day",
      car: "parts",
      studio: "slot",
      flowers: "lead",
      photo: "parts",
      cake: "lead",
      gifts: "lead",
      decor: "parts",
      food: "parts",
      restaurant: "parts",
      attire: "lead",
      zags: "slot",
    });
    for (const c of CATEGORIES) {
      expect(AVAILABILITY_MODES).toContain(c.availability);
      if (c.dayParts !== undefined) expect(c.availability).toBe("parts");
      expect(hasDayParts(c)).toBe(c.availability === "parts");
    }
  });

  it("фото: минимум не меньше трёх; люди — только в портфолио; видео — только у портфолио", () => {
    for (const c of CATEGORIES) {
      expect(c.minPhotos, c.code).toBeGreaterThanOrEqual(3);
      expect(c.recommendedPhotos, c.code).toBeGreaterThanOrEqual(c.minPhotos);
      expect(c.maxVideoLinks, c.code).toBeLessThanOrEqual(3);
      if (c.maxVideoLinks > 0) expect(c.photoPolicy, c.code).toBe("portfolio");
    }
    expect(photo.photoPolicy).toBe("portfolio");
    expect(hall.photoPolicy).toBe("no_people");
  });

  it("услуги: коды без повторов, единицы из списка, опции — с единицей; «другая» — у каждой категории", () => {
    for (const c of CATEGORIES) {
      const codes = c.services.map((s) => s.code);
      expect(new Set(codes).size, c.code).toBe(codes.length);
      expect(codes, c.code).toContain("other");
      for (const s of c.services) {
        expect(s.code, `${c.code}.${s.code}`).toMatch(/^[a-z][a-z0-9_]{1,39}$/);
        expect(s.units.length, `${c.code}.${s.code}`).toBeGreaterThan(0);
        expect(new Set(s.units).size).toBe(s.units.length);
        for (const unit of s.units) expect(PRICE_UNITS).toContain(unit);
        expect(s.freeName, `${c.code}.${s.code}`).toBe(s.code === "other");
        if (s.freeName) expect(s.inPriceFrom).toBe(false);
        const options = s.options.map((o) => o.code);
        expect(new Set(options).size, `${c.code}.${s.code}`).toBe(options.length);
        expect(options.length).toBeLessThanOrEqual(SERVICE_LIMITS.maxOptions);
      }
      for (const code of c.requiredServices) expect(codes, c.code).toContain(code);
      if (c.enabled)
        expect(
          c.services.some((s) => s.inPriceFrom),
          c.code,
        ).toBe(true);
    }
    expect(hall.requiredServices).toEqual(["banquet_weekday", "banquet_weekend"]);
    expect(categoryPriceUnits(hall)).toEqual(["per_guest", "per_event"]);
  });

  it("поля витрины и формы заявки: ключи без повторов, у списка — вложенные, варианты — без повторов", () => {
    for (const c of CATEGORIES) {
      const keys = c.attributes.map((a) => a.key);
      expect(new Set(keys).size, c.code).toBe(keys.length);
      for (const a of c.attributes) {
        expect(a.key).toMatch(/^[a-z][a-z0-9_]{1,39}$/);
        if (a.type === "enum" || a.type === "multi") {
          expect(new Set(a.options.map((o) => o.code)).size).toBe(a.options.length);
        }
        if (a.type === "int") expect(a.min).toBeLessThanOrEqual(a.max);
        if (a.type === "list") {
          expect(new Set(a.fields.map((f) => f.key)).size).toBe(a.fields.length);
          expect(a.fields.some((f) => f.required)).toBe(true);
        }
      }
      const fields = c.requestForm.fields.map((f) => f.key);
      expect(new Set(fields).size, c.code).toBe(fields.length);
      // У модели parts время начала обязательно: по нему выбирается часть дня
      if (c.availability === "parts") {
        expect(c.requestForm.fields.find((f) => f.key === "start_time")).toMatchObject({
          type: "time",
          required: true,
        });
      }
      // Выбор услуг в форме — у каждой включённой категории
      if (c.enabled)
        expect(
          c.requestForm.fields.some((f) => f.type === "services"),
          c.code,
        ).toBe(true);
    }
    expect(hall.listingFields).toEqual(["guest_capacity", "district"]);
    expect(hall.requestForm.guests).toBe("required");
    expect(car.requestForm.guests).toBe("hidden");
  });
});

// ── части дня ───────────────────────────────────────────────────────────────

describe("части дня", () => {
  it("окна по умолчанию идут подряд и покрывают сутки с 05:00", () => {
    expect(DAY_PARTS.map((p) => DEFAULT_DAY_PARTS[p])).toEqual([
      { from: "05:00", to: "11:00" },
      { from: "11:00", to: "17:00" },
      { from: "17:00", to: "24:00" },
    ]);
  });

  it.each([
    ["00:30", "morning"],
    ["04:59", "morning"],
    ["05:00", "morning"],
    ["10:59", "morning"],
    ["11:00", "day"],
    ["16:59", "day"],
    ["17:00", "evening"],
    ["23:59", "evening"],
  ] as const)("%s → %s", (time, part) => {
    expect(dayPartOf(car, time)).toBe(part);
  });
});

// ── поля витрины ────────────────────────────────────────────────────────────

describe("validateAttributePatch", () => {
  it("значения по типам; список — с вложенными полями; порядок кодов — как в конфигурации", () => {
    const result = validateAttributePatch(car, {
      fleet: [{ model: "  Chevrolet Malibu ", class: "sedan", seats: 4 }],
      decoration: false,
      service_area: "tashkent",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        fleet: [{ model: "Chevrolet Malibu", class: "sedan", seats: 4 }],
        decoration: false,
        service_area: "tashkent",
      },
    });
    expect(validateAttributePatch(photo, { team: ["videographer", "photographer"] })).toEqual({
      ok: true,
      value: { team: ["photographer", "videographer"] },
    });
  });

  it("ошибки — пути полей; неизвестное поле — ошибка; null — убрать", () => {
    expect(
      validateAttributePatch(car, {
        fleet: [{ class: "tank", seats: 0, extra: 1 }, "x"],
        decoration: "yes",
        kitchen: "own",
        min_order_hours: null,
      }),
    ).toEqual({
      ok: false,
      errors: [
        "attributes.fleet.0.extra",
        "attributes.fleet.0.model",
        "attributes.fleet.0.class",
        "attributes.fleet.0.seats",
        "attributes.fleet.1",
        "attributes.decoration",
        "attributes.kitchen",
      ],
    });
    expect(validateAttributePatch(car, { service_area: null, fleet: [] })).toEqual({
      ok: true,
      value: { service_area: null, fleet: null },
    });
    expect(validateAttributePatch(car, [])).toEqual({ ok: false, errors: ["attributes"] });
  });

  it("строки без управляющих символов и не длиннее предела", () => {
    expect(validateAttributePatch(car, { fleet: [{ model: "a\u0000b", class: "sedan" }] })).toMatchObject({
      ok: false,
      errors: ["attributes.fleet.0.model"],
    });
    expect(validateAttributePatch(car, { fleet: [{ model: "x".repeat(61), class: "sedan" }] })).toMatchObject(
      {
        ok: false,
      },
    );
  });

  it("mergeAttributes, readAttributes, missingAttributes", () => {
    const merged = mergeAttributes(
      { decoration: true, service_area: "tashkent" },
      { service_area: null, decoration: false },
    );
    expect(merged).toEqual({ decoration: false });
    // Из базы — только известные поля с верными значениями
    expect(readAttributes(car, { decoration: true, kitchen: "own", service_area: "mars" })).toEqual({
      decoration: true,
    });
    expect(missingAttributes(car, merged)).toEqual(requiredAttributeKeys(car));
    expect(requiredAttributeKeys(car)).toEqual(["fleet", "service_area"]);
    expect(missingAttributes(hall, {})).toEqual([]);
  });
});

// ── ссылки на видео ─────────────────────────────────────────────────────────

describe("ссылки на видео", () => {
  it.each([
    ["https://www.youtube.com/watch?v=abcdefghijk", "https://www.youtube.com/watch?v=abcdefghijk"],
    ["https://m.youtube.com/watch?v=abcdefghijk", "https://www.youtube.com/watch?v=abcdefghijk"],
    [" https://youtu.be/abcdefghijk ", "https://www.youtube.com/watch?v=abcdefghijk"],
    ["https://youtube.com/shorts/abcdefghijk", "https://www.youtube.com/shorts/abcdefghijk"],
    ["https://instagram.com/reel/Cx1_ab-Z9", "https://www.instagram.com/reel/Cx1_ab-Z9/"],
    ["https://www.instagram.com/p/Cx1_ab-Z9/", "https://www.instagram.com/p/Cx1_ab-Z9/"],
  ])("%s → канонический вид", (raw, canonical) => {
    const link = normalizeVideoLink(raw);
    expect(link).toBe(canonical);
    expect(new RegExp(VIDEO_LINK_DB_RE).test(canonical)).toBe(true);
  });

  it.each([
    "http://www.youtube.com/watch?v=abcdefghijk",
    "https://www.youtube.com/watch?v=abcdefghijk&list=x",
    "https://www.youtube.com/watch?v=short",
    "https://youtu.be.evil.com/abcdefghijk",
    "https://vimeo.com/123456",
    "https://www.instagram.com/someone/",
    "javascript:alert(1)",
    42,
  ])("%s — нет", (raw) => {
    expect(normalizeVideoLink(raw)).toBeNull();
  });

  it("не больше предела категории, без повторов", () => {
    expect(validateVideoLinks(photo, ["https://youtu.be/abcdefghijk"])).toEqual({
      ok: true,
      value: ["https://www.youtube.com/watch?v=abcdefghijk"],
    });
    expect(
      validateVideoLinks(photo, [
        "https://youtu.be/abcdefghijk",
        "https://www.youtube.com/watch?v=abcdefghijk",
      ]),
    ).toEqual({ ok: false, errors: ["videoLinks.1"] });
    expect(validateVideoLinks(photo, Array(4).fill("https://youtu.be/abcdefghijk"))).toEqual({
      ok: false,
      errors: ["videoLinks"],
    });
    expect(validateVideoLinks(hall, ["https://youtu.be/abcdefghijk"])).toEqual({
      ok: false,
      errors: ["videoLinks"],
    });
    expect(validateVideoLinks(hall, [])).toEqual({ ok: true, value: [] });
  });
});

// ── услуги ──────────────────────────────────────────────────────────────────

describe("validateServiceInput", () => {
  it("новая: тип из каталога категории; единица по умолчанию — первая; опции — с шаблоном", () => {
    expect(
      validateServiceInput(
        car,
        {
          type: "bride_car",
          priceUzs: 300_000,
          minQty: 3,
          includes: { ru: " Водитель ", uz: "" },
          options: [
            {
              code: "extra_hour",
              name: { ru: "Ещё час", uz: "Yana soat" },
              priceUzs: 250_000,
              priceUnit: "per_hour",
            },
          ],
        },
        { create: true },
      ),
    ).toEqual({
      ok: true,
      value: {
        type: "bride_car",
        priceUzs: 300_000,
        priceUnit: "per_hour",
        minQty: 3,
        includes: { ru: "Водитель" },
        options: [
          {
            code: "extra_hour",
            name: { ru: "Ещё час", uz: "Yana soat" },
            priceUzs: 250_000,
            priceUnit: "per_hour",
          },
        ],
      },
    });
  });

  it("чужой тип, чужая единица, неизвестное поле, цена вне пределов", () => {
    expect(validateServiceInput(car, { type: "wedding_cake", priceUzs: 1 }, { create: true })).toEqual({
      ok: false,
      errors: ["type"],
    });
    expect(
      validateServiceInput(
        car,
        { type: "bride_car", priceUzs: 0, priceUnit: "per_kg", color: "red" },
        { create: true },
      ),
    ).toEqual({ ok: false, errors: ["color", "priceUzs", "priceUnit"] });
    expect(
      validateServiceInput(
        car,
        { type: "bride_car", priceUzs: SERVICE_LIMITS.maxPrice + 1 },
        { create: true },
      ),
    ).toEqual({ ok: false, errors: ["priceUzs"] });
  });

  it("«другая услуга» — только со своим названием на двух языках; у остальных названия нет", () => {
    expect(
      validateServiceInput(car, { type: "other", priceUzs: 1000, priceUnit: "per_event" }, { create: true }),
    ).toEqual({
      ok: false,
      errors: ["name"],
    });
    expect(
      validateServiceInput(
        car,
        { type: "other", name: { ru: "Шары", uz: "Sharlar" }, priceUzs: 1000, priceUnit: "per_event" },
        { create: true },
      ),
    ).toMatchObject({ ok: true, value: { type: "other", name: { ru: "Шары", uz: "Sharlar" } } });
    expect(
      validateServiceInput(
        car,
        { type: "bride_car", name: { ru: "Моё", uz: "Meniki" }, priceUzs: 1 },
        { create: true },
      ),
    ).toEqual({ ok: false, errors: ["name"] });
  });

  it("правка: только переданные поля, тип не меняется, null очищает", () => {
    expect(
      validateServiceInput(
        car,
        { priceUzs: 280_000, minQty: null },
        { create: false, typeCode: "bride_car" },
      ),
    ).toEqual({ ok: true, value: { priceUzs: 280_000, minQty: null } });
    expect(
      validateServiceInput(car, { type: "limousine" }, { create: false, typeCode: "bride_car" }),
    ).toEqual({
      ok: false,
      errors: ["type"],
    });
  });

  it("опции: шаблон своего типа, id — UUID без повторов, не больше предела", () => {
    const option = { name: { ru: "Опция", uz: "Opsiya" }, priceUzs: 1000, priceUnit: "per_event" };
    expect(
      validateServiceInput(
        car,
        {
          options: [
            { ...option, code: "photo_stops" },
            { ...option, id: "x" },
          ],
        },
        { create: false, typeCode: "bride_car" },
      ),
    ).toEqual({ ok: false, errors: ["options.0.code", "options.1.id"] });
    expect(
      validateServiceInput(
        car,
        {
          options: [
            { ...option, id: UUID },
            { ...option, id: UUID },
          ],
        },
        { create: false, typeCode: "bride_car" },
      ),
    ).toEqual({ ok: false, errors: ["options"] });
    expect(
      validateServiceInput(
        car,
        { options: Array(11).fill(option) },
        { create: false, typeCode: "bride_car" },
      ),
    ).toEqual({ ok: false, errors: ["options"] });
  });
});

// ── форма заявки ────────────────────────────────────────────────────────────

describe("validateRequestDetails", () => {
  it("значения по типам полей формы; выбор услуг — отдельно", () => {
    expect(
      validateRequestDetails(car, {
        start_time: "18:30",
        hours: 4,
        cars_count: 2,
        car_class: "premium",
        services: [{ id: UUID.toUpperCase(), qty: 4, options: [UUID2] }],
      }),
    ).toEqual({
      ok: true,
      value: {
        values: { start_time: "18:30", hours: 4, cars_count: 2, car_class: "premium" },
        services: [{ id: UUID, qty: 4, options: [UUID2] }],
      },
    });
  });

  it("обязательные, неизвестные и неверные поля — ошибки с путями", () => {
    expect(validateRequestDetails(car, { start_time: "24:00", hours: 0, guests: 10 })).toEqual({
      ok: false,
      errors: ["details.guests", "details.start_time", "details.hours", "details.cars_count"],
    });
    expect(
      validateRequestDetails(car, {
        start_time: "10:00",
        hours: 2,
        cars_count: 1,
        services: [
          { id: UUID, qty: 0, note: "x" },
          { id: UUID2, options: [UUID, UUID] },
        ],
      }),
    ).toEqual({
      ok: false,
      errors: ["details.services.0.note", "details.services.0.qty", "details.services.1.options"],
    });
    // Одна услуга дважды — ошибка списка
    expect(
      validateRequestDetails(car, {
        start_time: "10:00",
        hours: 2,
        cars_count: 1,
        services: [{ id: UUID }, { id: UUID }],
      }),
    ).toEqual({ ok: false, errors: ["details.services"] });
    expect(validateRequestDetails(car, "x")).toEqual({ ok: false, errors: ["details"] });
    // Без полей у зала — только обязательный выбор услуг, если он есть в форме
    expect(validateRequestDetails(hall, undefined).ok).toBe(true);
  });

  it("число гостей — по правилу формы категории", () => {
    expect(guestsAllowed(hall, null)).toBe(false);
    expect(guestsAllowed(hall, 100)).toBe(true);
    expect(guestsAllowed(car, 100)).toBe(false);
    expect(guestsAllowed(car, null)).toBe(true);
    expect(guestsAllowed(photo, null)).toBe(true);
    expect(guestsAllowed(photo, 100)).toBe(true);
  });
});

// ── фильтры каталога ────────────────────────────────────────────────────────

describe("фильтры каталога", () => {
  it("параметры категории: a.<поле> и a.<список>.<поле записи>", () => {
    expect(categoryFilters(car).map((f) => f.param)).toEqual([
      "a.fleet.class",
      "a.fleet.color",
      "a.fleet.seats",
      "a.decoration",
      "a.service_area",
    ]);
  });

  it("разбор: да/нет, одно из, число; чужие параметры пропускаются", () => {
    expect(
      parseAttributeFilters(car, {
        "a.fleet.class": ["premium,limousine,premium"],
        "a.fleet.seats": ["7"],
        "a.decoration": ["1"],
        "a.service_area": [""],
        district: ["yunusobod"],
      }),
    ).toEqual({
      ok: true,
      value: [
        { kind: "any", path: ["fleet", "class"], values: ["premium", "limousine"], multi: false },
        { kind: "min", path: ["fleet", "seats"], value: 7 },
        { kind: "eq", path: ["decoration"] },
      ],
    });
    expect(parseAttributeFilters(photo, { "a.team": ["photographer,videographer"] })).toEqual({
      ok: true,
      value: [{ kind: "all", path: ["team"], values: ["photographer", "videographer"] }],
    });
  });

  it("неизвестный фильтр, повтор, неверное значение — ошибка с именем параметра", () => {
    expect(
      parseAttributeFilters(car, {
        "a.kitchen": ["own"],
        "a.fleet.class": ["premium", "sedan"],
        "a.fleet.seats": ["1e3"],
        "a.decoration": ["maybe"],
        "a.service_area": ["tashkent'; drop table app.listings; --"],
        "a.fleet.year": ["2020"],
      }),
    ).toEqual({
      ok: false,
      errors: [
        "a.kitchen",
        "a.fleet.class",
        "a.fleet.seats",
        "a.decoration",
        "a.service_area",
        "a.fleet.year",
      ],
    });
  });
});

// ── краткая запись заявки ───────────────────────────────────────────────────

describe("detailsSummary", () => {
  it("подписи и значения в порядке формы, услуги — с количеством и опциями", () => {
    const details = {
      cars_count: 2,
      start_time: "18:30",
      car_class: "premium",
      services: [
        {
          id: UUID,
          type: "bride_car",
          name: { ru: "Машина для молодожёнов", uz: "Kelin-kuyov mashinasi" },
          priceUzs: 300_000,
          priceUnit: "per_hour" as const,
          qty: 4,
          options: [
            {
              id: UUID2,
              name: { ru: "Ещё час", uz: "Yana soat" },
              priceUzs: 250_000,
              priceUnit: "per_hour" as const,
            },
          ],
        },
      ],
    };
    expect(detailsSummary("ru", car, details)).toEqual([
      "Начало: 18:30",
      "Сколько машин: 2",
      "Класс машины: Премиум",
      "Какие услуги нужны: Машина для молодожёнов × 4 (+Ещё час)",
    ]);
    expect(detailsSummary("uz", car, details)[3]).toBe(
      "Qaysi xizmatlar kerak: Kelin-kuyov mashinasi × 4 (+Yana soat)",
    );
    expect(detailsSummary("ru", hall, {})).toEqual([]);
  });
});
