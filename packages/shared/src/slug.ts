// Адрес витрины (slug): латиница, цифры и дефис, 3–40 символов — как CHECK в app.listings.
// Кириллица — по узбекской латинице (х → x, қ → q): названия тойхон узнаваемее так, чем по
// русской транслитерации. Один разбор для API (адрес новой витрины) и панели («из названия»).

const CYRILLIC: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "j",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "x",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sh",
  ъ: "",
  ы: "i",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  ў: "o",
  қ: "q",
  ғ: "g",
  ҳ: "h",
};

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const MAX_SLUG = 40;

/** Латиница из текста: кириллица — по узбекской латинице, oʻ и gʻ — без знака, диакритика — без знаков */
function latin(text: string): string {
  return (
    Array.from(text.toLowerCase())
      .map((ch) => CYRILLIC[ch] ?? ch)
      .join("")
      // oʻ, gʻ, tutuq belgisi и кавычки — без следа, диакритика — без знаков
      .replace(/[ʻʼ'‘’`"]/g, "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
  );
}

/**
 * Адрес из названия: латиница, слова — через дефис, не длиннее 40. Может выйти короче трёх
 * знаков или пустым (из «№ 1») — тогда SLUG_RE его не примет
 */
export function slugFromName(name: string): string {
  return latin(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
}

/**
 * Адрес, пока его набирают: строчные, кириллица — латиницей, пробел и прочее — дефисом, дефисы
 * не двоятся. Дефис в конце остаётся (следующее слово ещё впишут) — его снимает finishSlug
 */
export function typingSlug(input: string): string {
  return latin(input)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG);
}

/** Набрали: без дефисов по краям */
export function finishSlug(input: string): string {
  return typingSlug(input).replace(/-+$/g, "");
}
