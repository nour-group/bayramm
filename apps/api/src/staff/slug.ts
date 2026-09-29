// Адрес карточки (slug) из названия: латиница, цифры и дефис, 3–40 символов —
// как CHECK в app.listings. Кириллица — по узбекской латинице (х → x, қ → q):
// названия тойхон узнаваемее так, чем по русской транслитерации.

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
const MAX_SLUG = 40;

/** Основа адреса из названия; пусто или слишком коротко — «hall» */
export function slugify(name: string): string {
  const latin = Array.from(name.toLowerCase())
    .map((ch) => CYRILLIC[ch] ?? ch)
    .join("")
    // oʻ, gʻ, tutuq belgisi и кавычки — без следа, диакритика — без знаков
    .replace(/[ʻʼ'‘’`"]/g, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const slug = latin
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  return SLUG_RE.test(slug) ? slug : "hall";
}

/** Свободный адрес: основа, а если занята — основа-2, основа-3, … */
export function freeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_SLUG - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, MAX_SLUG - 9)}-${crypto.randomUUID().slice(0, 8)}`;
}
