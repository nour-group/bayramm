// Профиль бота как код: команды, описания и кнопка меню. Применяет POST /telegram/sync
// (routes/telegram.ts) после каждого деплоя — одинаково для бота любого окружения.
//
// Здесь только то, что меняется через Bot API. Домен виджета входа (/setdomain) и
// основное Mini App бота задаются в @BotFather вручную.
//
// Тексты — на двух языках плюс значение по умолчанию (русский) для остальных языков
// Telegram. Правила те же, что у словарей @bayramm/shared: ни «брони», ни
// «забронировать»; узбекский — латиница с апострофами U+02BB и U+02BC.

import type { Lang } from "@bayramm/shared";
import type { BotApiCall } from "./client";

interface BotTexts {
  /** Подпись команды /start в меню команд, до 256 символов */
  startCommand: string;
  /** Текст в пустом чате с ботом («What can this bot do?»), до 512 символов */
  description: string;
  /** Текст в профиле бота и при пересылке ссылки, до 120 символов */
  shortDescription: string;
}

export const BOT_TEXTS: Readonly<Record<Lang, BotTexts>> = {
  ru: {
    startCommand: "Открыть Bayramm",
    description:
      "Bayramm — площадка поиска подрядчиков на праздники в Ташкенте.\n\n" +
      "Цены и фото — в карточке, телефон вендора виден сразу. Выберите дату и отправьте заявку: " +
      "вендор получит её в Telegram.\n\n" +
      "Для вас это бесплатно — ни комиссий, ни платы за заявку.",
    shortDescription: "Подрядчики на праздники в Ташкенте: цены сразу, заявка вендору бесплатно.",
  },
  uz: {
    startCommand: "Bayramm ilovasini ochish",
    description:
      "Bayramm — Toshkentda bayramlar uchun hamkorlarni qidirish platformasi.\n\n" +
      "Narx va suratlar kartochkada, hamkorning telefoni darhol koʻrinadi. Sanani tanlang va soʻrov " +
      "yuboring: hamkor uni Telegramda oladi.\n\n" +
      "Siz uchun bepul — na komissiya, na soʻrov uchun toʻlov.",
    shortDescription: "Toshkentda bayramlar uchun hamkorlar: narxlar darhol, hamkorga soʻrov bepul.",
  },
};

/** Язык значений по умолчанию — для пользователей Telegram не на русском и не на узбекском */
export const DEFAULT_LANG: Lang = "ru";

/** Кнопка меню одна на все языки (у setChatMenuButton нет language_code) — текст языка по умолчанию */
export const MENU_BUTTON_TEXT = "Открыть";

/** Для какого языка значение: default — без language_code */
export type ProfileLanguage = "default" | Lang;

export type BotProfileStep = BotApiCall & { language: ProfileLanguage };

export interface BotProfileOptions {
  /** Адрес Mini App (WEB_APP_URL): его открывает кнопка меню */
  readonly webAppUrl: string;
}

const SCOPES: readonly { language: ProfileLanguage; texts: BotTexts; lang: { language_code?: Lang } }[] = [
  { language: "default", texts: BOT_TEXTS[DEFAULT_LANG], lang: {} },
  { language: "ru", texts: BOT_TEXTS.ru, lang: { language_code: "ru" } },
  { language: "uz", texts: BOT_TEXTS.uz, lang: { language_code: "uz" } },
];

/**
 * Весь профиль бота — список вызовов Bot API в порядке применения. Каждый
 * вызов идемпотентен: повтор с теми же параметрами ничего не меняет.
 *
 * Новая настройка — новая запись в списке. Вебхук (setWebhook) добавится так
 * же, когда появится его обработчик: метод — в BotApiMethods (client.ts), вызов —
 * сюда.
 */
export function botProfile({ webAppUrl }: BotProfileOptions): readonly BotProfileStep[] {
  return [
    ...SCOPES.map(
      ({ language, texts, lang }): BotProfileStep => ({
        language,
        method: "setMyCommands",
        params: { commands: [{ command: "start", description: texts.startCommand }], ...lang },
      }),
    ),
    ...SCOPES.map(
      ({ language, texts, lang }): BotProfileStep => ({
        language,
        method: "setMyDescription",
        params: { description: texts.description, ...lang },
      }),
    ),
    ...SCOPES.map(
      ({ language, texts, lang }): BotProfileStep => ({
        language,
        method: "setMyShortDescription",
        params: { short_description: texts.shortDescription, ...lang },
      }),
    ),
    {
      language: "default",
      method: "setChatMenuButton",
      params: { menu_button: { type: "web_app", text: MENU_BUTTON_TEXT, web_app: { url: webAppUrl } } },
    },
  ];
}
