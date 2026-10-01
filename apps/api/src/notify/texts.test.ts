import { hasNonCanonicalApostrophe, LANGS, normalizeUz } from "@bayramm/shared";
import { describe, expect, it } from "vitest";
import {
  formatDate,
  NOTICE_TEXTS,
  opsOutboxDead,
  opsRevisionSubmitted,
  opsServicesSubmitted,
  opsSlaBreach,
  type RequestFacts,
  SERVICE_TEXTS,
} from "./texts";

const FACTS: RequestFacts = {
  no: "1001",
  listing: "Test Hall",
  category: "Площадка / Тойхона",
  date: "12.10.2026",
  guests: 200,
  occasion: "Свадьба",
  slaHours: 12,
  details: [],
};

/** Кортеж: без гостей, с полями заявки категории */
const CAR: RequestFacts = {
  ...FACTS,
  listing: "Test Cars",
  category: "Кортеж",
  guests: null,
  details: ["Начало: 14:00", "Сколько часов: 3", "Сколько машин: 2"],
};

// Все тексты языка на наборе фактов
function rendered(lang: "ru" | "uz", facts = FACTS): string[] {
  const t = NOTICE_TEXTS[lang];
  return [
    t.requestNew(facts),
    t.slaReminder(facts, 4),
    t.slaReminder(facts, 0),
    t.opsReminder(facts),
    t.contacted(facts),
    t.contactedByTeam(facts),
    t.deal(facts),
    t.declined(facts),
    t.slaBreach(facts),
    ...Object.values(t.buttons),
    SERVICE_TEXTS[lang].button,
    SERVICE_TEXTS[lang].decided({
      service: "S",
      listing: "L",
      outcome: "approved",
      proposal: false,
      reason: null,
    }),
    SERVICE_TEXTS[lang].decided({
      service: "S",
      listing: "L",
      outcome: "declined",
      proposal: true,
      reason: "x",
    }),
    SERVICE_TEXTS[lang].decided({
      service: "S",
      listing: "L",
      outcome: "declined",
      proposal: false,
      reason: null,
    }),
  ];
}

describe("тексты уведомлений", () => {
  it("правила продукта: заявка, не бронь", () => {
    for (const lang of LANGS) for (const text of rendered(lang)) expect(text).not.toMatch(/брон|bron/i);
  });

  it("узбекский: только ʻ и ʼ, в нормальной форме", () => {
    for (const text of rendered("uz")) {
      expect(hasNonCanonicalApostrophe(text), text).toBe(false);
      expect(normalizeUz(text)).toBe(text);
    }
  });

  it("новая заявка: номер, площадка, дата, гости, повод и срок ответа", () => {
    const ru = NOTICE_TEXTS.ru.requestNew(FACTS);
    for (const part of ["№1001", "Test Hall", "12.10.2026", "200 гостей", "Свадьба", "12 часов"]) {
      expect(ru).toContain(part);
    }
    expect(NOTICE_TEXTS.uz.requestNew(FACTS)).toContain("200 mehmon");
  });

  it("новая заявка другой категории: категория, без гостей, поля заявки строками — без ПДн", () => {
    const ru = NOTICE_TEXTS.ru.requestNew(CAR);
    for (const part of ["№1001 · Кортеж", "Test Cars", "Начало: 14:00", "Сколько машин: 2"])
      expect(ru).toContain(part);
    expect(ru).not.toContain("гост");
    expect(ru).not.toContain("зал");
    expect(NOTICE_TEXTS.uz.requestNew({ ...CAR, category: "Kortej" })).not.toContain("mehmon");
    for (const lang of LANGS)
      for (const text of rendered(lang, CAR)) expect(text).not.toMatch(/undefined|null|NaN/);
  });

  it("решение по услуге: одобрено, отклонено, правка не принята — с причиной", () => {
    const t = SERVICE_TEXTS.ru;
    expect(
      t.decided({ service: "Лимузин", listing: "Шарк", outcome: "approved", proposal: false, reason: null }),
    ).toContain("одобрена");
    expect(
      t.decided({
        service: "Лимузин",
        listing: "Шарк",
        outcome: "declined",
        proposal: true,
        reason: "Нет фото",
      }),
    ).toContain("Изменения услуги «Лимузин» на витрине «Шарк» команда Bayramm не приняла: Нет фото");
    expect(
      opsServicesSubmitted({ listing: "Шарк", vendorCode: "V101", category: "Кортеж", pending: 2 }),
    ).toContain("Ждут решения: 2");
  });

  it("склонение часов и гостей", () => {
    expect(NOTICE_TEXTS.ru.slaReminder({ ...FACTS, guests: 1 }, 1)).toContain("осталось 1 час.");
    expect(NOTICE_TEXTS.ru.slaReminder({ ...FACTS, guests: 1 }, 1)).toContain("1 гость");
    expect(NOTICE_TEXTS.ru.slaReminder(FACTS, 4)).toContain("осталось 4 часа.");
    expect(NOTICE_TEXTS.ru.slaReminder(FACTS, 0)).toContain("осталось меньше часа.");
    expect(NOTICE_TEXTS.uz.slaReminder(FACTS, 0)).toContain("bir soatdan kam vaqt qoldi");
  });

  it("просрочка — предложение посмотреть похожие, заявка остаётся в силе", () => {
    expect(NOTICE_TEXTS.ru.slaBreach(FACTS)).toContain("Заявка в силе");
    expect(NOTICE_TEXTS.ru.buttons.similar).toBe("Посмотреть похожие");
  });

  it("команде: код вендора, номер заявки; недоставленное — вид, получатель и причина", () => {
    expect(opsSlaBreach({ ...FACTS, vendorCode: "V101" })).toContain("V101");
    const dead = opsOutboxDead({
      kind: "vendor.request_new",
      requestNo: "1001",
      recipientKind: "vendor_user",
      recipientRef: "aaaaaaaa",
      attempts: 1,
      error: "api 403: Forbidden: bot was blocked by the user",
    });
    for (const part of ["vendor.request_new", "№1001", "vendor_user aaaaaaaa", "403"])
      expect(dead).toContain(part);
    expect(
      opsOutboxDead({
        kind: "x.y",
        requestNo: null,
        recipientKind: "staff",
        recipientRef: "b",
        attempts: 8,
        error: "e",
      }),
    ).not.toContain("№");
  });

  it("«связались» от команды: не «площадка ответила», а команда связалась с ней за клиента", () => {
    const ru = NOTICE_TEXTS.ru.contactedByTeam(FACTS);
    for (const part of ["Команда Bayramm", "Test Hall", "№1001", "12.10.2026", "свяжется с вами"])
      expect(ru).toContain(part);
    expect(ru).not.toContain("ответил");
    const uz = NOTICE_TEXTS.uz.contactedByTeam(FACTS);
    for (const part of ["Bayramm jamoasi", "Test Hall", "№1001", "12.10.2026"]) expect(uz).toContain(part);
    expect(uz).not.toContain("javob berdi");
  });

  it("правка карточки — команде: площадка, код вендора, поля словами", () => {
    const text = opsRevisionSubmitted({
      listing: "Test Hall",
      vendorCode: "V101",
      fields: ["name", "attributes", "video_links", "unknown_key"],
    });
    for (const part of [
      "Test Hall",
      "V101",
      "название, поля витрины, ссылки на видео, unknown_key",
      "«Модерация»",
    ])
      expect(text).toContain(part);
  });

  it("дата события — ДД.ММ.ГГГГ", () => {
    expect(formatDate("2026-10-12")).toBe("12.10.2026");
    expect(formatDate("not a date")).toBe("not a date");
  });
});
