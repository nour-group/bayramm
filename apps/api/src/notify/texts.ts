// Тексты уведомлений из outbox. Собираются при отправке из данных базы, а не из
// payload (в нём только id). Правила словарей @bayramm/shared: «заявка», а не
// «бронь»; узбекский — латиница с ʻ (U+02BB) после o/g и ʼ (U+02BC).
//
// Вендору — номер заявки, категория и витрина, дата, части дня, гости и повод, поля заявки
// категории (часы, машины, выбранные услуги — без ПДн); имени, телефона и комментария
// клиента в уведомлении нет: их вендор видит в кабинете, пока действует согласие.
// Без parse_mode: название площадки пишет человек, разметка из него не исполняется.

import { type Lang, ruPlural } from "@bayramm/shared";
import type { DayPart, ListingStatus } from "@bayramm/shared/api/staff";

/** Заявка глазами уведомления: только то, что можно показать получателю */
export interface RequestFacts {
  /** Номер заявки (public_no) */
  readonly no: string;
  /** Название площадки (витрины) */
  readonly listing: string;
  /** Категория витрины на языке получателя */
  readonly category: string;
  /** Дата события, «ДД.ММ.ГГГГ» */
  readonly date: string;
  /** Число гостей; null — категория его не спрашивает или клиент не указал */
  readonly guests: number | null;
  /** Части дня словами («Утро, вечер», «Весь день»); null — у категории нет календаря */
  readonly parts: string | null;
  /** Повод на языке получателя */
  readonly occasion: string;
  /** Часов на ответ (из sla_due_at − created_at) */
  readonly slaHours: number;
  /** Поля заявки категории строками (detailsSummary): без ПДн */
  readonly details: readonly string[];
}

export interface Buttons {
  /** Вендору: заявка в кабинете */
  readonly openRequest: string;
  /** Клиенту: его заявка в «Моих заявках» */
  readonly myRequest: string;
  /** Клиенту: каталог похожих на дату и число гостей заявки */
  readonly similar: string;
}

const PART_NAMES: Readonly<Record<Lang, Readonly<Record<DayPart, string>> & { readonly whole: string }>> = {
  ru: { morning: "Утро", day: "День", evening: "Вечер", whole: "Весь день" },
  uz: { morning: "Ertalab", day: "Kunduzi", evening: "Kechqurun", whole: "Kun boʻyi" },
};

/** Части дня заявки словами: «Утро, вечер»; пусто — «Весь день» (через запятую — со строчной) */
export function partsText(lang: Lang, parts: readonly DayPart[]): string {
  const names = PART_NAMES[lang];
  if (parts.length === 0) return names.whole;
  return parts.map((part, i) => (i === 0 ? names[part] : names[part].toLowerCase())).join(", ");
}

const hoursRu = (n: number) => `${n} ${ruPlural(n, "час", "часа", "часов")}`;
const guestsRu = (n: number) => `${n} ${ruPlural(n, "гость", "гостя", "гостей")}`;

// Части дня — рядом с поводом: «Утро · Нахорги ош»
const summaryRu = (f: RequestFacts) =>
  [f.listing, f.date, f.guests === null ? null : guestsRu(f.guests), f.parts, f.occasion]
    .filter((x) => x !== null)
    .join(" · ");
const summaryUz = (f: RequestFacts) =>
  [f.listing, f.date, f.guests === null ? null : `${f.guests} mehmon`, f.parts, f.occasion]
    .filter((x) => x !== null)
    .join(" · ");
/** Поля заявки категории — строками под сводкой */
const detailsBlock = (f: RequestFacts) => (f.details.length > 0 ? `\n${f.details.join("\n")}` : "");

export interface NoticeTexts {
  readonly buttons: Buttons;
  /** vendor.request_new */
  requestNew(f: RequestFacts): string;
  /** vendor.sla_reminder; left — сколько целых часов осталось (0 — меньше часа) */
  slaReminder(f: RequestFacts, left: number): string;
  /** vendor.ops_reminder: напоминает сотрудник — срок мог уже пройти, часы не считаем */
  opsReminder(f: RequestFacts): string;
  /** client.request_status */
  contacted(f: RequestFacts): string;
  /**
   * client.request_status, «связались» отметил сотрудник (first_response_by = staff): не
   * «площадка ответила», а команда Bayramm связалась с ней за клиента
   */
  contactedByTeam(f: RequestFacts): string;
  deal(f: RequestFacts): string;
  declined(f: RequestFacts): string;
  /** client.sla_breach: предложение, а не действие — заявка остаётся в силе */
  slaBreach(f: RequestFacts): string;
}

export const NOTICE_TEXTS: Readonly<Record<Lang, NoticeTexts>> = {
  ru: {
    buttons: {
      openRequest: "Открыть в кабинете",
      myRequest: "Открыть заявку",
      similar: "Посмотреть похожие",
    },
    requestNew: (f) =>
      `Новая заявка №${f.no} · ${f.category}\n${summaryRu(f)}${detailsBlock(f)}\n\n` +
      `Контакты клиента и детали — в кабинете. Ответьте за ${hoursRu(f.slaHours)}: если ответа не будет, ` +
      "клиенту покажем похожие предложения.",
    slaReminder: (f, left) =>
      `Напоминание: заявка №${f.no} ждёт ответа.\n${summaryRu(f)}\n\n` +
      `Срок ответа — ${hoursRu(f.slaHours)}, осталось ${left > 0 ? hoursRu(left) : "меньше часа"}.`,
    opsReminder: (f) =>
      `Команда Bayramm напоминает: заявка №${f.no} ждёт вашего ответа.\n${summaryRu(f)}\n\n` +
      "Клиент ждёт — ответьте в кабинете или позвоните ему.",
    contacted: (f) =>
      `«${f.listing}» ответил на заявку №${f.no} (${f.date}). Подробности — в «Моих заявках».`,
    contactedByTeam: (f) =>
      `Команда Bayramm связалась с «${f.listing}» по вашей заявке №${f.no} (${f.date}). ` +
      "Площадка знает о заявке и свяжется с вами сама. Статус — в «Моих заявках».",
    deal: (f) => `Вы договорились с «${f.listing}» по заявке №${f.no} (${f.date}). Хорошего праздника!`,
    declined: (f) =>
      `«${f.listing}» не сможет принять заявку №${f.no} на ${f.date}. Посмотрите похожие предложения — ` +
      "может, подойдёт другое.",
    slaBreach: (f) =>
      `«${f.listing}» пока не ответил на заявку №${f.no} (${f.date}) за ${hoursRu(f.slaHours)}. ` +
      `Заявка в силе — «${f.listing}» ещё может ответить. А пока можно посмотреть похожие предложения.`,
  },
  uz: {
    buttons: {
      openRequest: "Kabinetda ochish",
      myRequest: "Soʻrovni ochish",
      similar: "Oʻxshashlarini koʻrish",
    },
    requestNew: (f) =>
      `Yangi soʻrov №${f.no} · ${f.category}\n${summaryUz(f)}${detailsBlock(f)}\n\n` +
      `Mijoz kontaktlari va tafsilotlar — kabinetda. ${f.slaHours} soat ichida javob bering: javob ` +
      "boʻlmasa, mijozga oʻxshash takliflarni koʻrsatamiz.",
    slaReminder: (f, left) =>
      `Eslatma: №${f.no} soʻrov javob kutmoqda.\n${summaryUz(f)}\n\n` +
      `Javob muddati — ${f.slaHours} soat, ${left > 0 ? `${left} soat` : "bir soatdan kam vaqt"} qoldi.`,
    opsReminder: (f) =>
      `Bayramm jamoasi eslatadi: №${f.no} soʻrov javobingizni kutmoqda.\n${summaryUz(f)}\n\n` +
      "Mijoz kutmoqda — kabinetda javob bering yoki unga qoʻngʻiroq qiling.",
    contacted: (f) =>
      `«${f.listing}» №${f.no} soʻrovga javob berdi (${f.date}). Batafsil — «Mening soʻrovlarim»da.`,
    contactedByTeam: (f) =>
      `Bayramm jamoasi №${f.no} soʻrovingiz (${f.date}) boʻyicha «${f.listing}» bilan bogʻlandi. ` +
      "Maydon soʻrovdan xabardor va siz bilan oʻzi bogʻlanadi. Holati — «Mening soʻrovlarim»da.",
    deal: (f) =>
      `«${f.listing}» bilan №${f.no} soʻrov boʻyicha kelishdingiz (${f.date}). Bayramingiz muborak boʻlsin!`,
    declined: (f) =>
      `«${f.listing}» ${f.date} sanasiga №${f.no} soʻrovni qabul qila olmaydi. Oʻxshash takliflarni koʻring — ` +
      "boshqasi mos kelishi mumkin.",
    slaBreach: (f) =>
      `«${f.listing}» №${f.no} soʻrovga (${f.date}) ${f.slaHours} soat ichida javob bermadi. Soʻrov kuchda — ` +
      `«${f.listing}» hali javob berishi mumkin. Hozircha oʻxshash takliflarni koʻrib chiqishingiz mumkin.`,
  },
};

// ── команде: только по-русски, панель оператора русская ─────────────────────

/** Кнопка оповещения команды: экран панели, где по нему решают */
export const OPS_BUTTON = "Открыть в панели";

/** Статус витрины словами — как в панели */
const LISTING_STATUS_RU: Readonly<Record<ListingStatus, string>> = {
  lead: "лид",
  draft: "черновик",
  review: "на проверке",
  active: "опубликована",
  suspended: "приостановлена",
  rejected: "отклонена",
};

/**
 * Витрина ещё не на сайте (черновик, на проверке): решить по ней можно уже сейчас, а что не
 * решили — одобрит публикация. У опубликованной — пусто
 */
const notLiveNote = (status: ListingStatus) =>
  status === "active" || status === "suspended"
    ? ""
    : `\nВитрина ещё не на сайте (${LISTING_STATUS_RU[status]}): решить можно сейчас, остальное одобрит публикация.`;

export interface OpsSlaFacts extends RequestFacts {
  /** Публичный код вендора (V101) */
  readonly vendorCode: string;
}

export function opsSlaBreach(f: OpsSlaFacts): string {
  const guests = f.guests === null ? "" : ` · ${guestsRu(f.guests)}`;
  const parts = f.parts === null ? "" : ` · ${f.parts}`;
  return (
    `SLA: заявка №${f.no} без ответа ${hoursRu(f.slaHours)}.\n` +
    `Вендор ${f.vendorCode} · ${f.category} · ${f.listing} · ${f.date}${parts}${guests}.\n` +
    "Клиенту предложены похожие; позвоните вендору."
  );
}

// ── услуги витрины ─────────────────────────────────────────────────────────

/** Решение команды по услуге — владельцу кабинета */
export interface ServiceDecisionFacts {
  /** Название услуги на языке получателя */
  readonly service: string;
  /** Название витрины */
  readonly listing: string;
  /** approved — услуга на витрине; declined — нет (новая — отклонена, правка — не принята) */
  readonly outcome: "approved" | "declined";
  /** Отклонили предложение правки, а не саму услугу: на витрине — прежняя версия */
  readonly proposal: boolean;
  /** Причина отказа — пишет сотрудник для партнёра */
  readonly reason: string | null;
}

export const SERVICE_TEXTS: Readonly<
  Record<Lang, { readonly button: string; readonly decided: (f: ServiceDecisionFacts) => string }>
> = {
  ru: {
    button: "Открыть услуги",
    decided: (f) => {
      if (f.outcome === "approved")
        return `Услуга «${f.service}» на витрине «${f.listing}» одобрена — клиенты видят её.`;
      const what = f.proposal ? `Изменения услуги «${f.service}»` : `Услугу «${f.service}»`;
      return (
        `${what} на витрине «${f.listing}» команда Bayramm не приняла` +
        `${f.reason ? `: ${f.reason}` : "."}\n` +
        (f.proposal
          ? "Клиенты видят прежнюю версию. Исправьте и отправьте снова в кабинете."
          : "Исправьте и отправьте снова в кабинете.")
      );
    },
  },
  uz: {
    button: "Xizmatlarni ochish",
    decided: (f) => {
      if (f.outcome === "approved") {
        return `«${f.listing}» vitrinasidagi «${f.service}» xizmati tasdiqlandi — mijozlar uni koʻradi.`;
      }
      const what = f.proposal ? `«${f.service}» xizmatidagi oʻzgarishlarni` : `«${f.service}» xizmatini`;
      return (
        `Bayramm jamoasi «${f.listing}» vitrinasidagi ${what} qabul qilmadi` +
        `${f.reason ? `: ${f.reason}` : "."}\n` +
        (f.proposal
          ? "Mijozlar oldingi variantni koʻradi. Tuzatib, kabinetdan qayta yuboring."
          : "Tuzatib, kabinetdan qayta yuboring.")
      );
    },
  },
};

/** Новые услуги и предложения правок витрины (любой, кроме отклонённой) — команде */
export interface OpsServicesFacts {
  readonly listing: string;
  readonly vendorCode: string;
  readonly category: string;
  /** Статус витрины: у черновика — пометка, что её ещё нет на сайте */
  readonly status: ListingStatus;
  /** Сколько услуг и предложений ждёт решения */
  readonly pending: number;
}

export function opsServicesSubmitted(f: OpsServicesFacts): string {
  return (
    `Услуги на проверке: ${f.listing} (${f.category}, вендор ${f.vendorCode}).\n` +
    `Ждут решения: ${f.pending}. Клиенты видят только одобренное.${notLiveNote(f.status)}\n` +
    "Решение — в панели, раздел «Модерация»."
  );
}

/** Витрину отправили на проверку (партнёр или менеджер) — тем, кто публикует */
export interface OpsListingFacts {
  readonly listing: string;
  readonly vendorCode: string;
  readonly category: string;
}

export function opsListingSubmitted(f: OpsListingFacts): string {
  return (
    `Витрина отправлена на проверку: ${f.listing} (${f.category}, вендор ${f.vendorCode}).\n` +
    "Опубликовать или вернуть на доработку — в панели, раздел «Модерация»."
  );
}

/**
 * Партнёр просит сменить публичные контакты витрины, которая на проверке или на сайте, — команде.
 * Ни номера, ни Telegram в тексте нет (ПДн): только что меняется; значения — в панели, «Показать»
 */
export interface OpsContactChangeFacts {
  readonly listing: string;
  readonly vendorCode: string;
  readonly status: ListingStatus;
  readonly phoneChanged: boolean;
  readonly telegramChanged: boolean;
}

export function opsContactChangeSubmitted(f: OpsContactChangeFacts): string {
  const what = [f.phoneChanged ? "телефон" : null, f.telegramChanged ? "Telegram" : null]
    .filter((item): item is string => item !== null)
    .join(" и ");
  return (
    `Партнёр просит сменить контакты витрины: ${f.listing} (вендор ${f.vendorCode}).\n` +
    `Меняет: ${what || "—"}. Клиенты видят прежние, пока запрос не решён.${notLiveNote(f.status)}\n` +
    "Решение — в панели, на странице витрины."
  );
}

/** Решение команды по смене контактов — владельцам кабинета: одобрено или отклонено с причиной */
export interface ContactDecisionFacts {
  readonly listing: string;
  readonly outcome: "approved" | "declined";
  readonly reason: string | null;
}

export const CONTACT_TEXTS: Readonly<
  Record<Lang, { readonly button: string; readonly decided: (f: ContactDecisionFacts) => string }>
> = {
  ru: {
    button: "Открыть витрину",
    decided: (f) =>
      f.outcome === "approved"
        ? `Новые контакты витрины «${f.listing}» одобрены — клиенты видят их по кнопке «Связаться».`
        : `Команда Bayramm не приняла новые контакты витрины «${f.listing}»${f.reason ? `: ${f.reason}` : "."}\n` +
          "Клиенты видят прежние контакты. Исправьте и отправьте снова в кабинете.",
  },
  uz: {
    button: "Vitrinani ochish",
    decided: (f) =>
      f.outcome === "approved"
        ? `«${f.listing}» vitrinasining yangi kontaktlari tasdiqlandi — mijozlar ularni «Bogʻlanish» tugmasi orqali koʻradi.`
        : `Bayramm jamoasi «${f.listing}» vitrinasining yangi kontaktlarini qabul qilmadi${f.reason ? `: ${f.reason}` : "."}\n` +
          "Mijozlar oldingi kontaktlarni koʻradi. Tuzatib, kabinetdan qayta yuboring.",
  },
};

/** Правка карточки от партнёра — команде: площадка, код вендора, какие поля */
export interface OpsRevisionFacts {
  /** Название площадки */
  readonly listing: string;
  /** Публичный код вендора (V101) */
  readonly vendorCode: string;
  /** Ключи payload правки (как столбцы базы) */
  readonly fields: readonly string[];
}

const REVISION_FIELDS_RU: Readonly<Record<string, string>> = {
  name: "название",
  description_ru: "описание (рус.)",
  description_uz: "описание (узб.)",
  attributes: "поля витрины",
  video_links: "ссылки на видео",
  cap_min: "вместимость",
  cap_max: "вместимость",
  district_code: "район",
  address_ru: "адрес (рус.)",
  address_uz: "адрес (узб.)",
};

export function opsRevisionSubmitted(f: OpsRevisionFacts): string {
  // Вместимость — два ключа, одно слово
  const fields = [...new Set(f.fields.map((key) => REVISION_FIELDS_RU[key] ?? key))].join(", ");
  return (
    `Правка карточки на проверке: ${f.listing} (вендор ${f.vendorCode}).\n` +
    `Меняет: ${fields || "—"}.\n` +
    "Решение — в панели, раздел «Модерация»."
  );
}

/** Новые фото карточки — команде: площадка, код вендора, сколько ждёт решения */
export interface OpsPhotosFacts {
  readonly listing: string;
  readonly vendorCode: string;
  /** Статус витрины: у черновика — пометка, что её ещё нет на сайте */
  readonly status: ListingStatus;
  readonly pending: number;
}

export function opsPhotosSubmitted(f: OpsPhotosFacts): string {
  return (
    `Новые фото на проверке: ${f.listing} (вендор ${f.vendorCode}).\n` +
    `Ждут решения: ${f.pending}. Клиенты их не видят, пока фото не одобрят.${notLiveNote(f.status)}\n` +
    "Решение — в панели, раздел «Модерация»."
  );
}

export interface OpsDeadFacts {
  readonly kind: string;
  readonly requestNo: string | null;
  readonly recipientKind: string;
  /** Первые 8 символов id получателя — чтобы найти в панели, не раскрывая лишнего */
  readonly recipientRef: string;
  readonly attempts: number;
  readonly error: string;
}

export function opsOutboxDead(f: OpsDeadFacts): string {
  const request = f.requestNo === null ? "" : `, заявка №${f.requestNo}`;
  return (
    `Уведомление не доставлено: ${f.kind}${request}.\n` +
    `Получатель: ${f.recipientKind} ${f.recipientRef}…, попыток: ${f.attempts}.\n` +
    `Причина: ${f.error}`
  );
}

/** «2026-10-12» → «12.10.2026» */
export function formatDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : isoDate;
}

// ── доступ в кабинет ───────────────────────────────────────────────────────

/** Партнёра добавили в кабинет вендора: приглашение принято (vendor.access_granted) */
export interface AccessGrantedFacts {
  /** Название вендора; нет — его код (V101) */
  readonly vendor: string;
  /** Роль в кабинете — что в нём можно делать (apps/api/src/vendor/access.ts) */
  readonly role: "owner" | "member";
}

export const ACCESS_TEXTS: Readonly<
  Record<Lang, { readonly button: string; readonly granted: (f: AccessGrantedFacts) => string }>
> = {
  ru: {
    button: "Открыть кабинет",
    granted: (f) =>
      `Вас добавили в кабинет партнёра «${f.vendor}» на Bayramm.\n` +
      (f.role === "owner"
        ? "Вы — владелец кабинета: отвечаете на заявки, ведёте календарь, меняете витрину, фото и услуги."
        : "Вы — сотрудник площадки: отвечаете на заявки и ведёте календарь.") +
      "\nНовые заявки будут приходить сюда.",
  },
  uz: {
    button: "Kabinetni ochish",
    granted: (f) =>
      `Bayramm: sizni «${f.vendor}» hamkor kabinetiga qoʻshishdi.\n` +
      (f.role === "owner"
        ? "Siz kabinet egasisiz: soʻrovlarga javob berasiz, taqvimni yuritasiz, vitrina, suratlar va xizmatlarni oʻzgartirasiz."
        : "Siz maydon xodimisiz: soʻrovlarga javob berasiz va taqvimni yuritasiz.") +
      "\nYangi soʻrovlar shu yerga keladi.",
  },
};
