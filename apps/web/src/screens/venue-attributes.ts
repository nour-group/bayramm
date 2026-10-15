import type { Lang } from "@bayramm/shared";
import type {
  ListingAttributes,
  ListingDetail,
  Localized,
  PriceUnit,
  PublicService,
} from "@bayramm/shared/api";
import {
  type AttributeField,
  type CategoryConfig,
  type Choice,
  categoryText,
  type ListItemField,
  normalizeVideoLink,
} from "@bayramm/shared/categories";

/* Поля витрины для страницы: строки «подпись — значение», особенности (да/нет — только «да»)
   и списки (автопарк). По описанию категории: неизвестные поля не показываются, порядок —
   как в описании. Срок заказа (lead_days) — в разделе «Сроки заказа», не здесь. Что уже
   сказано услугой витрины, второй раз не пишем: отметку «Украшение машины» при услуге
   «Украшение машины», минимум часов, когда он стоит у каждой почасовой услуги. Модуль без
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

/** Отметка «да/нет», которую называет услуга этого типа: при такой услуге отметку не пишем */
const FEATURE_SERVICES: Readonly<Record<string, readonly string[]>> = {
  decoration: ["car_decor"],
  tasting: ["tasting"],
  offsite: ["offsite_ceremony"],
  document_help: ["documents_help"],
  foreign_citizens: ["foreign_registration"],
  waiters: ["waiter_service"],
  national_dress: ["national_outfit"],
};

/** Минимальный заказ витрины в единице цены: его пишет «минимум …» у услуг этой единицы */
const MINIMUM_UNITS: Readonly<Record<string, PriceUnit>> = {
  min_order_hours: "per_hour",
  min_guests: "per_guest",
  min_batch: "per_item",
  min_weight_kg: "per_kg",
};

type ServiceFacts = Pick<PublicService, "type" | "priceUnit" | "minQty">;

/** Поле витрины уже видно у услуг: услуга того же названия или минимум у каждой услуги единицы */
function shownByServices(key: string, services: readonly ServiceFacts[]): boolean {
  const types = FEATURE_SERVICES[key];
  if (types) return services.some((s) => types.includes(s.type));
  const unit = MINIMUM_UNITS[key];
  if (!unit) return false;
  const priced = services.filter((s) => s.priceUnit === unit);
  return priced.length > 0 && priced.every((s) => s.minQty !== null);
}

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
  services: readonly ServiceFacts[] = [],
): AttributeView {
  const facts: { label: string; value: string }[] = [];
  const features: string[] = [];
  const lists: { label: string; items: string[] }[] = [];
  for (const field of category.attributes) {
    if (SKIP.has(field.key) || shownByServices(field.key, services)) continue;
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

/** Ссылки на видео — только канонические YouTube и Instagram: чужой адрес не показываем */
export function safeVideoLinks(links: readonly string[]): { readonly href: string; readonly host: string }[] {
  return links.flatMap((link) => {
    const href = normalizeVideoLink(link);
    if (href === null) return [];
    // Канонический вид — только www.youtube.com и www.instagram.com: подпись по хосту
    return [{ href, host: new URL(href).hostname === "www.instagram.com" ? "Instagram" : "YouTube" }];
  });
}
