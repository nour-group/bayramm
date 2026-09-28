/* Дизайн-токены Bayramm.

   Значения перенесены из прототипа клиента (prototypes/client/index.html: :root и премиум-тема
   «Suzani»). Цвета, которые не держали WCAG AA для текста, подобраны заново — таблица
   «было → стало» в README.md. src/tokens.css собирается из этого файла (css.ts).

   Правило тем: премиум переопределяет ТЕ ЖЕ базовые токены, а не отдельные классы.
   Обе темы задают один и тот же набор цветов — это проверяет тип Palette и тест. */

/** Цветовые токены. Имя в CSS — kebab-case: railBg → --rail-bg */
export const COLOR_TOKENS = [
  // грунты
  "paper", // фон экрана
  "white", // карточки, поля ввода
  "raise", // приподнятые кнопки поверх карточек
  "railBg", // нижние панели и боковая колонка
  // линии и подложки
  "rule", // линейки и рамки
  "line", // тонкие разделители
  "lilac", // подложки иконок, неактивные и наведённые состояния
  // текст
  "ink", // основной текст
  "muted", // вторичный текст
  "mutedLt", // подписи, плейсхолдеры, капитель
  // тёмные поверхности
  "plum", // заголовки, тёмные блоки, выбранное
  "plumDeep", // уведомления, подсказки
  "plumMid", // наведение на тёмное
  // акцент
  "coral", // заливки и иконки; текст — только крупный
  "coralDeep", // мелкий акцентный текст и кнопки с белым текстом
  "coralSoft", // мягкая коралловая подложка, свечение
  "peach", // акцент на тёмном: номера шагов, выделение в уведомлениях
  "accentHover", // главная кнопка под курсором
  "accentPress", // главная кнопка нажата
  "btnInk", // текст на главной кнопке
  "selInk", // текст на выбранном (тёмном) элементе
  // смысловые
  "teal", // свободно, проверено, успех
  "tealSoft", // подложка для teal
  "berry", // занято, удаление, ошибка
  // календарь
  "cell", // клетка дня
  "cellWk", // клетка выходного
  "busy", // клетка занятого дня
  "busyInk", // число занятого дня — выцветает, а не краснеет
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];

/** Полная палитра темы: каждый токен обязателен */
export type Palette = Readonly<Record<ColorToken, string>>;

export type ThemeName = "base" | "lux";

/** Основная тема — светлая, сливово-коралловая */
export const base: Palette = {
  paper: "#FAF7F4",
  white: "#FFFFFF",
  raise: "#FFFFFF",
  railBg: "#FAF7F4",
  rule: "#E4DCD6",
  line: "#E8E2F0",
  lilac: "#F1EAF9",
  ink: "#2A2233",
  muted: "#6F6580",
  mutedLt: "#786D87",
  plum: "#2C1B47",
  plumDeep: "#1B1030",
  plumMid: "#4E3170",
  coral: "#ED6545",
  coralDeep: "#BB4225",
  coralSoft: "#FDE7DC",
  peach: "#F9CDB2",
  accentHover: "#D74120",
  accentPress: "#90331D",
  btnInk: "#FFFFFF",
  selInk: "#FFFFFF",
  teal: "#237870",
  tealSoft: "#E2F1EF",
  berry: "#A82F52",
  cell: "#FFFFFF",
  cellWk: "#FBF6F1",
  busy: "#FBEEF1",
  busyInk: "#B57C90",
};

/* Премиум «Suzani»: небелёный лён (фон), марена (то, что нажимают), индиго (весь текст).
   Пропорции 70 / 20 / 8 / 2: лён и слоновая кость, индиго, розовый лён, марена.
   Чистых белого и чёрного нет. */
export const lux: Palette = {
  paper: "#EEE7DC", // лён
  white: "#FAF6EF", // слоновая кость
  raise: "#FFFDF8", // хлопок
  railBg: "#F3EDE3", // бледный лён
  rule: "rgba(30, 42, 79, 0.12)",
  line: "rgba(30, 42, 79, 0.12)",
  lilac: "rgba(163, 48, 42, 0.12)", // розовый лён
  ink: "#1E2A4F", // индиго
  muted: "#625C51", // орех
  mutedLt: "#6A6357",
  plum: "#1E2A4F",
  plumDeep: "#16203C",
  plumMid: "#2A3A66",
  coral: "#A3302A", // марена
  coralDeep: "#A3302A",
  coralSoft: "rgba(163, 48, 42, 0.12)",
  peach: "#DA756F",
  accentHover: "#8E2924",
  accentPress: "#7A231F",
  btnInk: "#FBF3E8",
  selInk: "#F6EEDF",
  teal: "#2F6B4F",
  tealSoft: "#E4EDE8",
  berry: "#7A1E1A",
  cell: "#F4EEE4",
  cellWk: "#EFE3D8",
  busy: "#FFFDF8",
  busyInk: "#9E9384",
};

export const themes: Readonly<Record<ThemeName, Palette>> = { base, lux };

/** Атрибут и значение, включающие премиум-тему: <div data-theme="lux"> */
export const THEME_ATTRIBUTE = "data-theme";

/* ---------- типографика ---------- */

export const fonts = {
  display: '"Unbounded", system-ui, sans-serif', // заголовки, 500–700
  body: '"Manrope", system-ui, -apple-system, "Segoe UI", sans-serif', // остальное, 400–800
  accent: '"Cormorant", Georgia, serif', // только слоган заставки
} as const;

/** Кегли, px. Только из этого набора */
export const FONT_SIZES = [10, 11, 12.5, 13.5, 14, 15, 16, 19, 22, 23, 27] as const;
export type FontSize = (typeof FONT_SIZES)[number];

/** Unbounded не бывает мельче 13px (из набора — от 13,5) и не бывает красным */
export const DISPLAY_MIN_SIZE = 13;

/** Капитель — только двух видов */
export const caps = {
  sm: { size: 10, weight: 700, letterSpacing: "0.18em" },
  md: { size: 11, weight: 700, letterSpacing: "0.12em" },
} as const satisfies Record<string, { size: FontSize; weight: number; letterSpacing: string }>;

/* ---------- шкалы ---------- */

/** Скругления, px. 999 — пилюля */
export const RADII = [3, 8, 11, 14, 18, 22, 999] as const;
export type Radius = (typeof RADII)[number];

/** Арка карточки вендора (отсылка к пештаку): 44 сверху, 20 снизу */
export const CARD_ARCH = "44px 44px 20px 20px";

/** Зазоры между элементами, px. Внутренние отступы — только чётные */
export const GAPS = [3, 5, 7, 9, 12] as const;
export type Gap = (typeof GAPS)[number];

/** Размеры иконок, px */
export const ICON_SIZES = [12, 14, 17, 20, 24, 26] as const;
export type IconSize = (typeof ICON_SIZES)[number];

/** Минимальная зона нажатия, px. Расширять невидимым слоем, не увеличивая рисунок */
export const HIT_MIN = 44;

/* ---------- движение ---------- */

/** Длительности, мс */
export const durations = {
  t1: 150, // касания, переключатели, наведение
  t2: 270, // карточки, чипы, раскрытие
  t3: 400, // экраны, шторки, диалоги
} as const;

export const easings = {
  ease: "cubic-bezier(0.32, 0.72, 0, 1)", // мягкая посадка вместо резкого щелчка
  easeSoft: "cubic-bezier(0.4, 0.14, 0.3, 1)", // появление — замедляется
  easeIn: "cubic-bezier(0.55, 0.06, 0.68, 0.19)", // уход — ускоряется
  easeIo: "cubic-bezier(0.65, 0, 0.35, 1)", // перемещение внутри экрана
} as const;

/** При prefers-reduced-motion длительности почти нулевые (не 0: transitionend должен прийти) */
export const REDUCED_DURATION = "0.01ms";

/* ---------- безопасные зоны ---------- */

/* Цепочка: значение Telegram → системное env() → ноль.
   safeArea — вырез и жест-бар устройства; contentSafeArea — кнопки Telegram в полноэкранном
   режиме. Верхний и нижний отступы складывают ОБЕ зоны. Ключ — имя переменной без «--». */
export const safeArea = {
  "sa-t": "var(--tg-safe-area-inset-top, env(safe-area-inset-top, 0px))",
  "sa-b": "var(--tg-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
  "sa-l": "var(--tg-safe-area-inset-left, env(safe-area-inset-left, 0px))",
  "sa-r": "var(--tg-safe-area-inset-right, env(safe-area-inset-right, 0px))",
  "csa-t": "var(--tg-content-safe-area-inset-top, 0px)",
  "csa-b": "var(--tg-content-safe-area-inset-bottom, 0px)",
  "pad-t": "calc(var(--sa-t) + var(--csa-t))",
  "pad-b": "calc(var(--sa-b) + var(--csa-b))",
} as const;

/* ---------- имена CSS-переменных ---------- */

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const px = (n: number) => String(n).replace(".", "-");

/** CSS-переменная цвета: colorVar("railBg") → "--rail-bg" */
export const colorVar = (token: ColorToken) => `--${kebab(token)}`;
export const fontVar = (name: keyof typeof fonts) => `--font-${name}`;
export const fontSizeVar = (size: FontSize) => `--fs-${px(size)}`;
export const radiusVar = (r: Radius) => `--r-${r}`;
export const gapVar = (g: Gap) => `--gap-${g}`;
export const iconVar = (s: IconSize) => `--ico-${s}`;
export const durationVar = (name: keyof typeof durations) => `--${name}`;
export const easingVar = (name: keyof typeof easings) => `--${kebab(name)}`;
