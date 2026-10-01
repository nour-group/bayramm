/* Поля заявки категории в том виде, как их хранит база (app.requests.details) и отдаёт
   API, и их краткая запись строками — для уведомления вендору и списков. Персональных
   данных здесь нет: свободный текст клиента живёт в комментарии (по согласию). */

import { categoryText } from "../i18n/categories";
import type { Lang } from "../i18n/dict";
import type { CategoryConfig, Choice, PriceUnit } from "./types";
import type { DetailValue } from "./validate";

/** Опция выбранной услуги — как была в момент заявки */
export interface ChosenOptionSnapshot {
  readonly id: string;
  readonly name: { readonly ru: string; readonly uz: string };
  readonly priceUzs: number;
  readonly priceUnit: PriceUnit;
}

/** Выбранная услуга — название и цена как были в момент заявки (вендор мог их потом поменять) */
export interface ChosenServiceSnapshot {
  readonly id: string;
  /** Код типа услуги в категории */
  readonly type: string;
  readonly name: { readonly ru: string; readonly uz: string };
  readonly priceUzs: number;
  readonly priceUnit: PriceUnit;
  /** Количество в единице цены (часы, штуки, кг); null — не указано */
  readonly qty: number | null;
  readonly options: readonly ChosenOptionSnapshot[];
}

/**
 * Поля заявки категории: ключ поля формы → значение; у поля выбора услуг (services) —
 * снимки выбранных услуг. Пустой объект — категория без полей или старая заявка
 */
export type RequestDetails = Readonly<Record<string, DetailValue | readonly ChosenServiceSnapshot[]>>;

const choiceLabel = (lang: Lang, options: readonly Choice[], code: string) => {
  const option = options.find((o) => o.code === code);
  return option === undefined ? code : categoryText(lang, option.label);
};

const isSnapshots = (value: unknown): value is readonly ChosenServiceSnapshot[] =>
  Array.isArray(value) && value.every((v) => typeof v === "object" && v !== null && "name" in v);

/**
 * Поля заявки строками «Подпись: значение» в порядке формы. district — название района по
 * коду (справочник районов — в базе); без него показывается код
 */
export function detailsSummary(
  lang: Lang,
  category: CategoryConfig,
  details: RequestDetails,
  district?: (code: string) => string | undefined,
): string[] {
  const lines: string[] = [];
  for (const field of category.requestForm.fields) {
    const value = details[field.key];
    if (value === undefined || value === null) continue;
    const label = categoryText(lang, field.label);
    switch (field.type) {
      case "services": {
        if (!isSnapshots(value) || value.length === 0) break;
        const names = value.map((s) => {
          const options = s.options.map((o) => `+${o.name[lang]}`).join(", ");
          const qty = s.qty === null ? "" : ` × ${s.qty}`;
          return `${s.name[lang]}${qty}${options ? ` (${options})` : ""}`;
        });
        lines.push(`${label}: ${names.join("; ")}`);
        break;
      }
      case "bool":
        if (value === true) lines.push(label);
        break;
      case "enum":
        if (typeof value === "string") lines.push(`${label}: ${choiceLabel(lang, field.options, value)}`);
        break;
      case "multi":
        if (Array.isArray(value)) {
          const names = (value as readonly string[]).map((code) => choiceLabel(lang, field.options, code));
          lines.push(`${label}: ${names.join(", ")}`);
        }
        break;
      case "district":
        if (typeof value === "string") lines.push(`${label}: ${district?.(value) ?? value}`);
        break;
      case "int":
      case "time":
        if (typeof value === "number" || typeof value === "string") lines.push(`${label}: ${value}`);
        break;
    }
  }
  return lines;
}
