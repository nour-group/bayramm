import type { Lang } from "@bayramm/shared";

/* Тексты кабинета вендора. Узбекский — латиница, апострофы ʻ (U+02BB) после o/g и ʼ (U+02BC),
   как в @bayramm/shared. Когда текстов станет больше, словарь переедет туда же. */

const ru = {
  area: "кабинет вендора",
  skip: "К содержимому",
  sections: "Разделы кабинета",
  language: "Язык",
  requests: "Заявки",
  requestsLead: "Новые заявки клиентов и ваши ответы. На каждую нужно ответить за 12 часов.",
  calendar: "Календарь",
  calendarLead: "Отмечайте занятые дни — клиенты видят их сразу.",
  card: "Карточка",
  cardLead: "Фото, цена «от» и описание услуг. Без цены и трёх фото карточка не публикуется.",
  login: "Вход",
  loginLead: "Вход по номеру телефона.",
  soon: "Раздел в разработке",
  notFound: "Страница не найдена",
  notFoundLead: "Проверьте адрес или откройте заявки.",
  toHome: "К заявкам",
};

/** Словарь кабинета: набор ключей задаёт русский, узбекский обязан совпасть */
export type VendorDict = { readonly [K in keyof typeof ru]: string };

const uz: VendorDict = {
  area: "hamkor kabineti",
  skip: "Asosiy qismga oʻtish",
  sections: "Kabinet boʻlimlari",
  language: "Til",
  requests: "Soʻrovlar",
  requestsLead: "Mijozlarning yangi soʻrovlari va javoblaringiz. Har biriga 12 soat ichida javob bering.",
  calendar: "Taqvim",
  calendarLead: "Band kunlarni belgilang — mijozlar ularni darhol koʻradi.",
  card: "Kartochka",
  cardLead: "Foto, «dan» narx va xizmatlar tavsifi. Narx va uchta fotosiz kartochka eʼlon qilinmaydi.",
  login: "Kirish",
  loginLead: "Telefon raqami orqali kirish.",
  soon: "Boʻlim ishlab chiqilmoqda",
  notFound: "Sahifa topilmadi",
  notFoundLead: "Manzilni tekshiring yoki soʻrovlarni oching.",
  toHome: "Soʻrovlarga",
};

export const vendorDict: Readonly<Record<Lang, VendorDict>> = { ru, uz };

/** Название языка на нём самом — для подсказки в переключателе */
export const LANG_NAMES: Readonly<Record<Lang, string>> = { ru: "Русский", uz: "Oʻzbekcha" };
