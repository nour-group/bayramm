/* Текст приглашения в кабинет партнёра — на его языке (язык кабинета и уведомлений, который
   выбрали при приглашении). Сотрудник копирует его и отправляет партнёру сам — бот первым
   написать не может. Ссылка на бота — с ?start=partner (сразу кнопка «Я партнёр»), на
   кабинет — с ?signin=1 (сразу вход через хаб на сайте) и языком. Номера в тексте нет:
   партнёр знает свой, а ПДн в переписке ни к чему. Панель русская, поэтому узбекский текст
   живёт здесь, а не в texts.ts. */

export type InviteLang = "ru" | "uz";

export interface VendorInviteFacts {
  /** Имя партнёра из приглашения; null — без обращения по имени */
  readonly name: string | null;
  /** Название вендора; нет — его код */
  readonly vendor: string;
  readonly role: "owner" | "member";
  /** Имя бота окружения (GET /auth/methods); null — Telegram не ответил: только сайт */
  readonly bot: string | null;
  /** Адрес кабинета окружения (GET /auth/methods), без «/» в конце */
  readonly cabinetUrl: string;
  /** Вход по коду на телефон включён: на сайте приглашение примет код на этот номер */
  readonly phoneLogin: boolean;
}

/** Бот сразу с кнопкой «Я партнёр» (apps/api/src/bot/handler.ts, PARTNER_START_PAYLOAD) */
export const botPartnerLink = (bot: string): string => `https://t.me/${bot}?start=partner`;

/** Кабинет вне Telegram: ?signin=1 сразу уводит в хаб входа, lang — язык до входа */
export const cabinetSignInLink = (cabinetUrl: string, lang: InviteLang): string =>
  `${cabinetUrl.replace(/\/+$/, "")}/?signin=1&lang=${lang}`;

function ru(f: VendorInviteFacts): string {
  const site = cabinetSignInLink(f.cabinetUrl, "ru");
  const lines = [
    f.name ? `Здравствуйте, ${f.name}!` : "Здравствуйте!",
    `Вас пригласили в кабинет партнёра «${f.vendor}» на Bayramm.`,
    f.role === "owner"
      ? "Вы — владелец кабинета: заявки клиентов, календарь, витрина, фото и услуги."
      : "Вы — сотрудник площадки: заявки клиентов и календарь.",
    "",
  ];
  if (f.bot) {
    lines.push(
      "Как войти:",
      `1. Откройте бота Bayramm: ${botPartnerLink(f.bot)}`,
      "2. Нажмите «Я партнёр» и отправьте свой номер — тот, что вы дали менеджеру.",
      "Кабинет откроется прямо в Telegram, туда же будут приходить новые заявки.",
      "",
      f.phoneLogin
        ? `Или войдите на сайте кодом на этот номер: ${site}`
        : `После этого кабинет откроется и на сайте: ${site}`,
    );
  } else {
    lines.push(`Войдите на сайте кодом на номер, который вы дали менеджеру: ${site}`);
  }
  return lines.join("\n");
}

function uz(f: VendorInviteFacts): string {
  const site = cabinetSignInLink(f.cabinetUrl, "uz");
  const lines = [
    f.name ? `Assalomu alaykum, ${f.name}!` : "Assalomu alaykum!",
    `Sizni Bayramm platformasidagi «${f.vendor}» hamkor kabinetiga taklif qilishdi.`,
    f.role === "owner"
      ? "Siz kabinet egasisiz: mijozlar soʻrovlari, taqvim, vitrina, suratlar va xizmatlar."
      : "Siz maydon xodimisiz: mijozlar soʻrovlari va taqvim.",
    "",
  ];
  if (f.bot) {
    lines.push(
      "Qanday kirish mumkin:",
      `1. Bayramm botini oching: ${botPartnerLink(f.bot)}`,
      "2. «Men hamkorman» tugmasini bosing va raqamingizni yuboring — menejerga bergan raqamni.",
      "Kabinet toʻgʻridan-toʻgʻri Telegramda ochiladi, yangi soʻrovlar ham shu yerga keladi.",
      "",
      f.phoneLogin
        ? `Yoki saytda shu raqamga kelgan kod bilan kiring: ${site}`
        : `Shundan soʻng kabinet saytda ham ochiladi: ${site}`,
    );
  } else {
    lines.push(`Saytda menejerga bergan raqamingizga kelgan kod bilan kiring: ${site}`);
  }
  return lines.join("\n");
}

/** Текст приглашения на языке партнёра */
export function vendorInviteText(lang: InviteLang, facts: VendorInviteFacts): string {
  return lang === "uz" ? uz(facts) : ru(facts);
}
