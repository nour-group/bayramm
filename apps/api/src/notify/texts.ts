// Тексты уведомлений из outbox. Собираются при отправке из данных базы, а не из
// payload (в нём только id). Правила словарей @bayramm/shared: «заявка», а не
// «бронь»; узбекский — латиница с ʻ (U+02BB) после o/g и ʼ (U+02BC).
//
// Вендору — номер заявки, площадка, дата, гости и повод; имени и телефона
// клиента в уведомлении нет: их вендор видит в кабинете, пока действует согласие.
// Без parse_mode: название площадки пишет человек, разметка из него не исполняется.

import { type Lang, ruPlural } from "@bayramm/shared";

/** Заявка глазами уведомления: только то, что можно показать получателю */
export interface RequestFacts {
  /** Номер заявки (public_no) */
  readonly no: string;
  /** Название площадки */
  readonly listing: string;
  /** Дата события, «ДД.ММ.ГГГГ» */
  readonly date: string;
  readonly guests: number;
  /** Повод на языке получателя */
  readonly occasion: string;
  /** Часов на ответ (из sla_due_at − created_at) */
  readonly slaHours: number;
}

export interface Buttons {
  /** Вендору: заявка в кабинете */
  readonly openRequest: string;
  /** Клиенту: его заявка в «Моих заявках» */
  readonly myRequest: string;
  /** Клиенту: каталог похожих на дату и число гостей заявки */
  readonly similar: string;
}

const hoursRu = (n: number) => `${n} ${ruPlural(n, "час", "часа", "часов")}`;
const guestsRu = (n: number) => `${n} ${ruPlural(n, "гость", "гостя", "гостей")}`;

const summaryRu = (f: RequestFacts) => `${f.listing} · ${f.date} · ${guestsRu(f.guests)} · ${f.occasion}`;
const summaryUz = (f: RequestFacts) => `${f.listing} · ${f.date} · ${f.guests} mehmon · ${f.occasion}`;

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
      `Новая заявка №${f.no}\n${summaryRu(f)}\n\n` +
      `Контакты клиента и детали — в кабинете. Ответьте за ${hoursRu(f.slaHours)}: если зал молчит, ` +
      "клиенту покажем похожие.",
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
      `«${f.listing}» не сможет принять заявку №${f.no} на ${f.date}. Посмотрите похожие залы — ` +
      "может, подойдёт другой.",
    slaBreach: (f) =>
      `«${f.listing}» пока не ответил на заявку №${f.no} (${f.date}) за ${hoursRu(f.slaHours)}. ` +
      "Заявка в силе — зал ещё может ответить. А пока можно посмотреть похожие залы.",
  },
  uz: {
    buttons: {
      openRequest: "Kabinetda ochish",
      myRequest: "Soʻrovni ochish",
      similar: "Oʻxshashlarini koʻrish",
    },
    requestNew: (f) =>
      `Yangi soʻrov №${f.no}\n${summaryUz(f)}\n\n` +
      `Mijoz kontaktlari va tafsilotlar — kabinetda. ${f.slaHours} soat ichida javob bering: zal javob ` +
      "bermasa, mijozga oʻxshashlarini koʻrsatamiz.",
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
      `«${f.listing}» ${f.date} sanasiga №${f.no} soʻrovni qabul qila olmaydi. Oʻxshash zallarni koʻring — ` +
      "boshqasi mos kelishi mumkin.",
    slaBreach: (f) =>
      `«${f.listing}» №${f.no} soʻrovga (${f.date}) ${f.slaHours} soat ichida javob bermadi. Soʻrov kuchda — ` +
      "zal hali javob berishi mumkin. Hozircha oʻxshash zallarni koʻrib chiqishingiz mumkin.",
  },
};

// ── команде: только по-русски, панель оператора русская ─────────────────────

export interface OpsSlaFacts extends RequestFacts {
  /** Публичный код вендора (V101) */
  readonly vendorCode: string;
}

export function opsSlaBreach(f: OpsSlaFacts): string {
  return (
    `SLA: заявка №${f.no} без ответа ${hoursRu(f.slaHours)}.\n` +
    `Вендор ${f.vendorCode} · ${f.listing} · ${f.date} · ${guestsRu(f.guests)}.\n` +
    "Клиенту предложены похожие; позвоните вендору."
  );
}

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
  price_from_uzs: "цена",
  price_unit: "за что цена",
  description_ru: "описание (рус.)",
  description_uz: "описание (узб.)",
  packages: "пакеты",
};

export function opsRevisionSubmitted(f: OpsRevisionFacts): string {
  const fields = f.fields.map((key) => REVISION_FIELDS_RU[key] ?? key).join(", ");
  return (
    `Правка карточки на проверке: ${f.listing} (вендор ${f.vendorCode}).\n` +
    `Меняет: ${fields || "—"}.\n` +
    "Решение — в панели, раздел «Модерация»."
  );
}

/** Новые фото опубликованной карточки — команде: площадка, код вендора, сколько ждёт решения */
export interface OpsPhotosFacts {
  readonly listing: string;
  readonly vendorCode: string;
  readonly pending: number;
}

export function opsPhotosSubmitted(f: OpsPhotosFacts): string {
  return (
    `Новые фото на проверке: ${f.listing} (вендор ${f.vendorCode}).\n` +
    `Ждут решения: ${f.pending}. Клиенты их не видят, пока фото не одобрят.\n` +
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
