import type { Lang } from "@bayramm/shared";
import type { DayPart, ListingAttributes, ListingDetail, Localized } from "@bayramm/shared/api";
import {
  type AttributeField,
  type CategoryConfig,
  type Choice,
  categoryText,
  dayPartWindows,
  type ListItemField,
  normalizeVideoLink,
} from "@bayramm/shared/categories";

/* Поля витрины для страницы: строки «подпись — значение», особенности (да/нет — только «да»)
   и списки (автопарк). По описанию категории: неизвестные поля не показываются, порядок —
   как в описании. Срок заказа (lead_days) — в разделе «Сроки заказа», не здесь. Модуль без
   React: его проверяют тесты. */

export interface AttributeView {
  /** «Площадь, м²: 180», «Кухня: Своя кухня» */
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  /** Поля «да/нет» со значением «да»: «Дневной свет», «Гримёрная» */
  readonly features: readonly string[];
  /** Списки: «Автопарк» — по строке на запись */
  readonly lists: readonly { readonly label: string; readonly items: readonly string[] }[];
}

const SKIP = new Set(["lead_days"]);

const choice = (lang: Lang, options: readonly Choice[], code: unknown): string | null => {
  const option = options.find((o) => o.code === code);
  return option ? categoryText(lang, option.label) : null;
};

const pick = (value: { ru?: string; uz?: string }, lang: Lang): string =>
  value[lang] || value[lang === "ru" ? "uz" : "ru"] || "";

/** Значение поля записи списка строкой: число — с подписью («Мест: 4»), варианты — названием */
function itemValue(field: ListItemField, value: unknown, lang: Lang): string | null {
  switch (field.type) {
    case "text":
      return typeof value === "string" && value ? value : null;
    case "enum":
      return choice(lang, field.options, value);
    case "int":
      return typeof value === "number" ? `${categoryText(lang, field.label)}: ${value}` : null;
    case "bool":
      return value === true ? categoryText(lang, field.label) : null;
  }
}

function scalar(field: AttributeField, value: unknown, lang: Lang): string | null {
  switch (field.type) {
    case "int":
      return typeof value === "number" ? String(value) : null;
    case "enum":
      return choice(lang, field.options, value);
    case "multi":
      return Array.isArray(value)
        ? value
            .map((code: unknown) => choice(lang, field.options, code))
            .filter(Boolean)
            .join(", ") || null
        : null;
    case "text":
      if (typeof value === "string") return value || null;
      return typeof value === "object" && value !== null ? pick(value as Localized, lang) || null : null;
    default:
      return null;
  }
}

export function attributeView(
  category: CategoryConfig,
  attributes: ListingAttributes,
  lang: Lang,
): AttributeView {
  const facts: { label: string; value: string }[] = [];
  const features: string[] = [];
  const lists: { label: string; items: string[] }[] = [];
  for (const field of category.attributes) {
    if (SKIP.has(field.key)) continue;
    const value: unknown = attributes[field.key];
    if (value === undefined || value === null) continue;
    const label = categoryText(lang, field.label);
    if (field.type === "bool") {
      if (value === true) features.push(label);
      continue;
    }
    if (field.type === "list") {
      if (!Array.isArray(value)) continue;
      const items = value
        .map((item: unknown) =>
          typeof item === "object" && item !== null
            ? field.fields
                .map((sub) => itemValue(sub, (item as Record<string, unknown>)[sub.key], lang))
                .filter(Boolean)
                .join(" · ")
            : "",
        )
        .filter(Boolean);
      if (items.length > 0) lists.push({ label, items });
      continue;
    }
    const text = scalar(field, value, lang);
    if (text) facts.push({ label, value: text });
  }
  return { facts, features, lists };
}

/** Срок заказа витрины (поле lead_days); нет — null */
export function listingLeadDays(listing: Pick<ListingDetail, "attributes">): number | null {
  const value = listing.attributes.lead_days;
  return typeof value === "number" && value > 0 ? value : null;
}

/** Окно части дня категории: «05:00–11:00» */
export function dayPartWindow(category: CategoryConfig, part: DayPart): string {
  const { from, to } = dayPartWindows(category)[part];
  return `${from}–${to}`;
}

/** Ссылки на видео — только канонические YouTube и Instagram: чужой адрес не показываем */
export function safeVideoLinks(links: readonly string[]): { readonly href: string; readonly host: string }[] {
  return links.flatMap((link) => {
    const href = normalizeVideoLink(link);
    if (href === null) return [];
    return [{ href, host: href.includes("instagram.com") ? "Instagram" : "YouTube" }];
  });
}
