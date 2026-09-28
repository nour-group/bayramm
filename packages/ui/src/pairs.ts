import type { ColorToken } from "./tokens";

/* Пары «текст на фоне», которые разрешено использовать. Проверяются тестом в ОБЕИХ темах:
   компонент один, меняются только значения токенов. Нужна новая пара — добавить сюда,
   тест скажет, держит ли она контраст.

   small — обычный текст: ≥ 4,5:1.
   large — крупный текст (от 24px или от 18,66px жирным), а также иконки и рамка фокуса
   (для нетекстовых элементов WCAG требует те же 3:1): ≥ 3:1. */

export type TextSize = "small" | "large";

export const MIN_CONTRAST: Readonly<Record<TextSize, number>> = { small: 4.5, large: 3 };

export interface TextPair {
  readonly fg: ColorToken;
  readonly bg: ColorToken;
  readonly size: TextSize;
  /** Где встречается */
  readonly use: string;
}

const small = (fg: ColorToken, bg: ColorToken, use: string): TextPair => ({ fg, bg, size: "small", use });
const large = (fg: ColorToken, bg: ColorToken, use: string): TextPair => ({ fg, bg, size: "large", use });

export const TEXT_PAIRS: readonly TextPair[] = [
  // основной и вторичный текст на всех грунтах
  small("ink", "paper", "основной текст на фоне экрана"),
  small("ink", "white", "текст карточек и полей"),
  small("ink", "raise", "текст приподнятых кнопок"),
  small("ink", "railBg", "текст нижних панелей"),
  small("ink", "lilac", "наведённые пункты меню и чипы"),
  small("ink", "cell", "число дня в календаре"),
  small("ink", "cellWk", "число выходного дня"),
  small("muted", "paper", "вторичный текст на фоне"),
  small("muted", "white", "вторичный текст в карточках"),
  small("muted", "raise", "вторичный текст приподнятых кнопок"),
  small("muted", "railBg", "пояснения в нижних панелях"),
  small("muted", "lilac", "статус «ждём ответа», пометка «по желанию»"),
  small("muted", "cellWk", "цена выходного дня"),
  small("mutedLt", "paper", "подписи, капитель разделов"),
  small("mutedLt", "white", "подписи и плейсхолдеры в полях"),
  small("mutedLt", "raise", "подписи на приподнятом"),
  small("mutedLt", "cell", "цена дня в календаре"),
  small("mutedLt", "cellWk", "цена выходного дня, дни недели"),
  // заголовки и тёмные поверхности
  small("plum", "paper", "заголовки на фоне"),
  small("plum", "white", "заголовки и кнопки в карточках"),
  small("plum", "raise", "текст круглых кнопок"),
  small("plum", "lilac", "кнопки на сиреневой подложке"),
  small("selInk", "plum", "выбранная дата, нажатые пилюли"),
  small("selInk", "ink", "выбранное в премиум-теме"),
  small("selInk", "plumDeep", "текст уведомлений и подсказок"),
  small("selInk", "plumMid", "наведение на тёмную кнопку"),
  small("peach", "plum", "номера шагов, акцент на тёмном"),
  small("peach", "plumDeep", "выделение в уведомлении"),
  // акцент
  small("btnInk", "coralDeep", "главная кнопка"),
  small("btnInk", "accentHover", "главная кнопка под курсором"),
  small("btnInk", "accentPress", "главная кнопка нажата"),
  small("coralDeep", "paper", "мелкий акцентный текст, метка «Реклама»"),
  small("coralDeep", "white", "рейтинг, звёзды, метка «Реклама» в карточке"),
  small("coralDeep", "raise", "акцентный текст на приподнятом"),
  small("coralDeep", "coralSoft", "метка «Реклама» и активный пункт на коралловой подложке"),
  large("coral", "paper", "иконки, рамка фокуса, крупный акцентный текст"),
  large("coral", "white", "иконки и крупный текст в карточках"),
  large("coral", "raise", "иконки на приподнятом"),
  large("btnInk", "coral", "иконка на коралловой заливке"),
  // смысловые
  small("teal", "paper", "«Проверено», «свободно»"),
  small("teal", "white", "«Проверено» в карточке"),
  small("teal", "tealSoft", "статус «договорились», чипы успеха"),
  small("berry", "paper", "«занято», ошибка"),
  small("berry", "white", "«занято» в карточке, удаление"),
];

/* Пары, которым контраст не нужен: неактивные элементы WCAG 1.4.3 не касается.
   Держим список, чтобы исключение было видно, а не забыто. */
export const EXEMPT_PAIRS: readonly { fg: ColorToken; bg: ColorToken; why: string }[] = [
  { fg: "busyInk", bg: "busy", why: "занятый день выбрать нельзя — он намеренно выцветает" },
];
