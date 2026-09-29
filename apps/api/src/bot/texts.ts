// Ответы бота в чате. Правила те же, что у словарей @bayramm/shared: «заявка», а не
// «бронь»; узбекский — латиница с ʻ (U+02BB) после o/g и ʼ (U+02BC). Язык — по
// языку Telegram: русский для ru, узбекский для всех остальных.

import type { Lang } from "@bayramm/shared";

export interface BotTexts {
  /** Приветствие на /start: что это и зачем открывать приложение */
  welcome: string;
  /** Кнопка под приветствием: клиентское Mini App */
  openApp: string;
  /** Для вендоров: поделиться номером кнопкой внизу */
  partnerPrompt: string;
  /** Кнопка клавиатуры с request_contact */
  partnerButton: string;
  /** /start от уже привязанного пользователя вендора */
  vendorLinked: string;
  /** Кнопка кабинета вендора (Mini App) */
  openCabinet: string;
  /** Номер подтверждён, Telegram привязан к кабинету */
  claimed: string;
  /** Текст над кнопкой кабинета после привязки */
  cabinetHint: string;
  /** Прислали чужой контакт */
  notOwnContact: string;
  /** Номера нет среди пользователей вендоров (или он отключён) */
  notFound: string;
  /** Номер уже привязан к другому аккаунту Telegram */
  linkedElsewhere: string;
  /** Этот Telegram уже привязан к другому пользователю вендора */
  telegramTaken: string;
}

export const BOT_TEXTS: Readonly<Record<Lang, BotTexts>> = {
  ru: {
    welcome:
      "Bayramm — залы для свадеб и торжеств в Ташкенте.\n\n" +
      "Цены и фото — сразу, телефон зала виден до заявки. Выберите дату и отправьте заявку: " +
      "зал получит её в Telegram. Для вас это бесплатно.",
    openApp: "Открыть Bayramm",
    partnerPrompt:
      "Вы партнёр Bayramm? Нажмите «Я партнёр» внизу и отправьте свой номер — тот, что вы дали " +
      "менеджеру. Так мы найдём ваш кабинет.",
    partnerButton: "Я партнёр",
    vendorLinked: "Этот Telegram привязан к кабинету партнёра. Новые заявки приходят сюда.",
    openCabinet: "Открыть кабинет",
    claimed:
      "Готово: номер подтверждён, кабинет привязан к этому Telegram. Новые заявки будут приходить сюда.",
    cabinetHint: "Кабинет открывается прямо в Telegram:",
    notOwnContact:
      "Отправьте, пожалуйста, свой номер — кнопкой «Я партнёр» внизу. Чужие контакты мы не принимаем.",
    notFound:
      "Этот номер не найден среди партнёров Bayramm. Если вы с нами работаете, напишите своему " +
      "менеджеру — он проверит номер.",
    linkedElsewhere: "Этот номер уже привязан к другому аккаунту Telegram. Напишите своему менеджеру.",
    telegramTaken: "Этот Telegram уже привязан к другому кабинету партнёра. Напишите своему менеджеру.",
  },
  uz: {
    welcome:
      "Bayramm — Toshkentda toʻy va bayramlar uchun zallar.\n\n" +
      "Narx va suratlar darhol, zal telefoni soʻrovdan oldin koʻrinadi. Sanani tanlang va soʻrov " +
      "yuboring: zal uni Telegramda oladi. Siz uchun bepul.",
    openApp: "Bayramm ilovasini ochish",
    partnerPrompt:
      "Bayramm hamkorimisiz? Pastdagi «Men hamkorman» tugmasini bosing va raqamingizni yuboring — " +
      "menejerga bergan raqamni. Shunda kabinetingizni topamiz.",
    partnerButton: "Men hamkorman",
    vendorLinked: "Bu Telegram hamkor kabinetiga ulangan. Yangi soʻrovlar shu yerga keladi.",
    openCabinet: "Kabinetni ochish",
    claimed: "Tayyor: raqam tasdiqlandi, kabinet shu Telegramga ulandi. Yangi soʻrovlar shu yerga keladi.",
    cabinetHint: "Kabinet toʻgʻridan-toʻgʻri Telegramda ochiladi:",
    notOwnContact:
      "Iltimos, oʻz raqamingizni pastdagi «Men hamkorman» tugmasi orqali yuboring. Boshqalarning " +
      "kontaktini qabul qilmaymiz.",
    notFound:
      "Bu raqam Bayramm hamkorlari orasida topilmadi. Agar biz bilan ishlasangiz, menejeringizga " +
      "yozing — u raqamni tekshiradi.",
    linkedElsewhere: "Bu raqam boshqa Telegram akkauntiga ulangan. Menejeringizga yozing.",
    telegramTaken: "Bu Telegram boshqa hamkor kabinetiga ulangan. Menejeringizga yozing.",
  },
};

/** Команде — только по-русски: панель оператора русская */
export const STAFF_STARTED = "Оповещения для команды Bayramm будут приходить сюда.";

/** Язык ответа по language_code из Telegram: ru — русский, остальные — узбекский */
export function botLang(languageCode: string | undefined): Lang {
  return languageCode?.toLowerCase().split("-")[0] === "ru" ? "ru" : "uz";
}
