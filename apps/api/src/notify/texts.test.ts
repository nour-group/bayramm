import { BOT_GLOSSARY_FORBIDDEN, hasNonCanonicalApostrophe, LANGS, normalizeUz } from "@bayramm/shared";
import { describe, expect, it } from "vitest";
import { NOTICE_KINDS } from "./render";
import {
  ACCESS_TEXTS,
  CONTACT_TEXTS,
  deadlineText,
  deadReasonRu,
  formatDate,
  NOTICE_KIND_RU,
  NOTICE_TEXTS,
  OPS_BUTTON,
  opsListingSubmitted,
  opsOutboxDead,
  opsRevisionSubmitted,
  opsServicesSubmitted,
  opsSlaBreach,
  partsText,
  type RequestFacts,
  SERVICE_TEXTS,
  VITRINA_TEXTS,
} from "./texts";

const FACTS: RequestFacts = {
  no: "1001",
  listing: "Test Hall",
  category: "Тойхона",
  date: "12.10.2026",
  guests: 200,
  parts: "Вечер",
  occasion: "Свадьба",
  slaHours: 12,
  deadline: "21:40 (сегодня)",
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

// Все тексты клиенту и партнёру на языке получателя (срок ответа — тоже на его языке)
function rendered(lang: "ru" | "uz", base = FACTS): string[] {
  const t = NOTICE_TEXTS[lang];
  const facts = lang === "uz" ? { ...base, deadline: "bugun 21:40" } : base;
  const v = VITRINA_TEXTS[lang];
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
    ACCESS_TEXTS[lang].button,
    ACCESS_TEXTS[lang].granted({ vendor: "V", role: "owner" }),
    ACCESS_TEXTS[lang].granted({ vendor: "V", role: "member" }),
    CONTACT_TEXTS[lang].button,
    CONTACT_TEXTS[lang].decided({ listing: "L", outcome: "approved", reason: null }),
    CONTACT_TEXTS[lang].decided({ listing: "L", outcome: "declined", reason: "x" }),
    v.button,
    ...(["published", "rejected", "returned", "suspended"] as const).flatMap((decision) => [
      v.listing({ listing: "L", decision, reason: null }),
      v.listing({ listing: "L", decision, reason: "Нужны фото зала" }),
    ]),
    v.revision({ listing: "L", outcome: "approved", reason: null, live: true }),
    v.revision({ listing: "L", outcome: "approved", reason: null, live: false }),
    v.revision({ listing: "L", outcome: "declined", reason: "x", live: true }),
    v.revision({ listing: "L", outcome: "declined", reason: "x", live: false }),
    v.photos({ listing: "L", approved: 3, declined: 0 }),
    v.photos({ listing: "L", approved: 2, declined: 1 }),
    v.photos({ listing: "L", approved: 0, declined: 2 }),
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

  it("новая заявка: номер, площадка, дата, гости, повод и срок ответа — часы и день", () => {
    const ru = NOTICE_TEXTS.ru.requestNew(FACTS);
    for (const part of [
      "№1001",
      "Test Hall",
      "12.10.2026",
      "200 гостей",
      "Свадьба",
      "12 часов",
      "Ответьте до 21:40 (сегодня)",
    ]) {
      expect(ru).toContain(part);
    }
    const uz = NOTICE_TEXTS.uz.requestNew({ ...FACTS, deadline: "ertaga 09:00" });
    expect(uz).toContain("200 mehmon");
    expect(uz).toContain("Ertaga 09:00 gacha javob bering");
  });

  it("напоминание: срок — часы и день, и сколько осталось", () => {
    expect(NOTICE_TEXTS.ru.slaReminder({ ...FACTS, deadline: "09:00 (завтра)" }, 3)).toContain(
      "Ответьте до 09:00 (завтра): осталось 3 часа.",
    );
    expect(NOTICE_TEXTS.uz.slaReminder({ ...FACTS, deadline: "bugun 21:40" }, 3)).toContain(
      "Bugun 21:40 gacha javob bering: 3 soat qoldi.",
    );
  });

  it("срок ответа по Ташкенту: сегодня, завтра, дальше — дата", () => {
    // 14:00 в Ташкенте (09:00 UTC)
    const now = new Date("2026-10-01T09:00:00Z");
    expect(deadlineText("ru", new Date("2026-10-01T16:40:00Z"), now)).toBe("21:40 (сегодня)");
    expect(deadlineText("uz", new Date("2026-10-01T16:40:00Z"), now)).toBe("bugun 21:40");
    // 19:30 UTC — уже 00:30 следующего дня по Ташкенту
    expect(deadlineText("ru", new Date("2026-10-01T19:30:00Z"), now)).toBe("00:30 (завтра)");
    expect(deadlineText("uz", new Date("2026-10-02T04:00:00Z"), now)).toBe("ertaga 09:00");
    expect(deadlineText("ru", new Date("2026-10-03T04:00:00Z"), now)).toBe("09:00 (03.10)");
    // Поздно вечером по Ташкенту (23:30) «завтра» — следующий ташкентский день
    expect(deadlineText("ru", new Date("2026-10-02T06:30:00Z"), new Date("2026-10-01T18:30:00Z"))).toBe(
      "11:30 (завтра)",
    );
  });

  it("глоссарий: клиенту — исполнитель / hamkor; ни «вендора», ни «подрядчика», ни «maydon»", () => {
    for (const lang of LANGS) {
      const hits = rendered(lang).filter((text) => BOT_GLOSSARY_FORBIDDEN[lang].some((re) => re.test(text)));
      expect(hits, lang).toEqual([]);
    }
    // «Площадка» по-русски — только Bayramm: исполнителя так не называем
    expect(NOTICE_TEXTS.ru.contactedByTeam(FACTS)).not.toMatch(/площадк/i);
    expect(ACCESS_TEXTS.ru.granted({ vendor: "V", role: "member" })).toContain("Вы — сотрудник:");
    expect(ACCESS_TEXTS.uz.granted({ vendor: "V", role: "member" })).toContain("Siz xodimsiz:");
  });

  it("решения по витрине — владельцу кабинета: опубликована, отклонена, вернули, приостановлена — с причиной", () => {
    const ru = VITRINA_TEXTS.ru;
    expect(ru.listing({ listing: "Lola", decision: "published", reason: null })).toBe(
      "Витрина «Lola» опубликована — клиенты видят её в каталоге Bayramm.",
    );
    expect(ru.listing({ listing: "Lola", decision: "rejected", reason: "Нет договора" })).toContain(
      "отклонила витрину «Lola»: Нет договора\nИсправьте и отправьте на проверку снова",
    );
    expect(ru.listing({ listing: "Lola", decision: "returned", reason: null })).toContain(
      "вернули на доработку.\n",
    );
    expect(ru.listing({ listing: "Lola", decision: "suspended", reason: "Ремонт" })).toContain(
      "приостановлена: Ремонт\nКлиенты её сейчас не видят",
    );
    expect(VITRINA_TEXTS.uz.listing({ listing: "Lola", decision: "published", reason: null })).toContain(
      "eʼlon qilindi",
    );
    expect(ru.revision({ listing: "Lola", outcome: "declined", reason: "Не то фото", live: true })).toContain(
      "не приняла изменения витрины «Lola»: Не то фото\nКлиенты видят прежнюю версию",
    );
    // Витрина не на сайте (на проверке, приостановлена) — про то, что видят клиенты, ни слова
    const notLive = ru.revision({ listing: "Lola", outcome: "declined", reason: "Не то фото", live: false });
    expect(notLive).not.toContain("Клиенты");
    expect(notLive).toContain("Исправьте и отправьте снова");
    expect(ru.revision({ listing: "Lola", outcome: "approved", reason: null, live: false })).toBe(
      "Изменения витрины «Lola» одобрены.",
    );
    expect(ru.button).toBe("Открыть витрину");
    expect(VITRINA_TEXTS.uz.button).toBe("Vitrinani ochish");
  });

  it("решения по фото — одним сообщением: сколько одобрено и отклонено, где причина", () => {
    const ru = VITRINA_TEXTS.ru;
    expect(ru.photos({ listing: "Lola", approved: 3, declined: 0 })).toBe(
      "Одобрено фото витрины «Lola»: 3. Клиенты их видят.",
    );
    const mixed = ru.photos({ listing: "Lola", approved: 2, declined: 1 });
    expect(mixed).toContain("одобрено — 2, отклонено — 1");
    expect(mixed).toContain("Причина — у каждого отклонённого фото в кабинете");
    expect(ru.photos({ listing: "Lola", approved: 0, declined: 2 })).toContain(
      "отклонила фото витрины «Lola»: 2.",
    );
    expect(VITRINA_TEXTS.uz.photos({ listing: "Lola", approved: 0, declined: 2 })).toContain(
      "2 ta suratini rad etdi",
    );
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
    const live = opsServicesSubmitted({
      listing: "Шарк",
      vendorCode: "V101",
      category: "Кортеж",
      status: "active",
      pending: 2,
    });
    expect(live).toContain("Ждут решения: 2");
    expect(live).not.toContain("не на сайте");
    // Черновик: решить можно и до публикации — сказано, что витрины ещё нет на сайте
    expect(
      opsServicesSubmitted({
        listing: "Шарк",
        vendorCode: "V101",
        category: "Кортеж",
        status: "draft",
        pending: 1,
      }),
    ).toContain("Витрина ещё не на сайте (черновик)");
  });

  it("витрина на проверке — тем, кто публикует: витрина, категория, код вендора, где решать", () => {
    const text = opsListingSubmitted({ listing: "Шарк", vendorCode: "V101", category: "Кортеж" });
    for (const part of ["Витрина отправлена на проверку", "Шарк", "Кортеж", "V101", "«Модерация»"])
      expect(text).toContain(part);
    expect(OPS_BUTTON).toBe("Открыть в панели");
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

  it("команде: код вендора, номер заявки; недоставленное — вид, получатель и причина словами", () => {
    expect(opsSlaBreach({ ...FACTS, vendorCode: "V101" })).toContain("V101");
    const dead = opsOutboxDead({
      kind: "vendor.request_new",
      requestNo: "1001",
      recipientKind: "vendor_user",
      recipientRef: "aaaaaaaa",
      attempts: 1,
      error: "api 403: Forbidden: bot was blocked by the user",
    });
    for (const part of [
      "вендору — новая заявка",
      "№1001",
      "пользователь кабинета aaaaaaaa",
      "получатель остановил бота (Telegram 403)",
    ])
      expect(dead).toContain(part);
    expect(dead).not.toContain("vendor.request_new");
    expect(dead).not.toContain("Forbidden");
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

  it("предложение изменений витрины — команде: витрина, код вендора, поля словами", () => {
    const text = opsRevisionSubmitted({
      listing: "Test Hall",
      vendorCode: "V101",
      fields: ["name", "attributes", "video_links", "unknown_key"],
    });
    for (const part of [
      "Предложение изменений витрины на проверке",
      "Test Hall",
      "V101",
      "название, поля витрины, ссылки на видео, unknown_key",
      "«Модерация»",
    ])
      expect(text).toContain(part);
  });

  it("вместимость в правке — одно слово на два ключа; район и адрес — словами", () => {
    const text = opsRevisionSubmitted({
      listing: "Test Hall",
      vendorCode: "V101",
      fields: ["cap_min", "cap_max", "district_code", "address_ru"],
    });
    expect(text).toContain("Меняет: вместимость, район, адрес (рус.).");
  });

  it("части дня: названия, с окнами витрины — и время; пусто — весь день", () => {
    const windows = {
      morning: { from: "06:00", to: "10:00" },
      day: { from: "12:00", to: "17:00" },
      evening: { from: "18:00", to: "24:00" },
    };
    expect(partsText("ru", ["morning", "evening"])).toBe("Утро, вечер");
    expect(partsText("ru", ["morning", "evening"], windows)).toBe("Утро 06:00–10:00, вечер 18:00–24:00");
    expect(partsText("uz", ["evening"], windows)).toBe("Kechqurun 18:00–24:00");
    expect(partsText("ru", [], windows)).toBe("Весь день");
  });

  it("недоставленное: каждый вид уведомления — словами; причины — словами", () => {
    expect(NOTICE_KINDS.filter((kind) => NOTICE_KIND_RU[kind] === undefined)).toEqual([]);
    expect(deadReasonRu("skipped: vendor_user_unlinked")).toBe(
      "пользователь кабинета отключён или не привязал Telegram",
    );
    expect(deadReasonRu("skipped: client_not_notifiable")).toContain("клиент не разрешил уведомления");
    expect(deadReasonRu("api 400: Bad Request: chat not found")).toBe("чат с ботом не найден (Telegram 400)");
    expect(deadReasonRu("api 502: Bad Gateway")).toBe("Telegram не принял сообщение (Telegram 502)");
    expect(deadReasonRu("TypeError: fetch failed")).toBe("сбой отправки");
  });

  it("статус витрины «не заполнена» — как в панели, не «лид»", () => {
    expect(
      opsServicesSubmitted({
        listing: "Шарк",
        vendorCode: "V101",
        category: "Кортеж",
        status: "lead",
        pending: 1,
      }),
    ).toContain("Витрина ещё не на сайте (не заполнена)");
  });

  it("дата события — ДД.ММ.ГГГГ", () => {
    expect(formatDate("2026-10-12")).toBe("12.10.2026");
    expect(formatDate("not a date")).toBe("not a date");
  });
});
