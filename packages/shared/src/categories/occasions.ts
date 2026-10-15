/* Поводы заявки (app.occasions): код, названия, порядок показа и части дня по умолчанию.
   Тот же набор сеет миграция 20261015100000_day_sessions.sql (интеграционный тест API сверяет
   базу с этим списком). Повод подсказывает время: нахорги ош — утром, никах — днём, свадьба —
   вечером; форма заявки отмечает эти части сама, клиент меняет. Код повода после выпуска не
   меняется: на него ссылаются заявки. */

import { sortParts } from "./availability";
import type { DayPart } from "./types";

export interface OccasionSpec {
  /** [a-z_]{2,20} — как ограничение app.occasions.code */
  readonly code: string;
  readonly name: { readonly ru: string; readonly uz: string };
  /** Части дня, которые форма заявки отмечает сама */
  readonly defaultParts: readonly DayPart[];
}

/** В порядке показа (sort — номер в списке, с 1) */
export const OCCASIONS: readonly OccasionSpec[] = [
  { code: "toy", name: { ru: "Свадьба", uz: "Toʻy" }, defaultParts: ["evening"] },
  { code: "nahorgi_osh", name: { ru: "Нахорги ош", uz: "Nahorgi osh" }, defaultParts: ["morning"] },
  { code: "nikoh", name: { ru: "Никах (ЗАГС)", uz: "Nikoh (FHDYo)" }, defaultParts: ["day"] },
  { code: "fotiha", name: { ru: "Фотиха-той", uz: "Fotiha toʻyi" }, defaultParts: ["day"] },
  { code: "qiz_bazmi", name: { ru: "Девичник", uz: "Qiz bazmi" }, defaultParts: ["evening"] },
  { code: "kelin_salom", name: { ru: "Келин салом", uz: "Kelin salom" }, defaultParts: ["morning"] },
  { code: "sunnat", name: { ru: "Суннат-той", uz: "Sunnat toʻyi" }, defaultParts: ["morning"] },
  { code: "beshik", name: { ru: "Бешик-той", uz: "Beshik toʻyi" }, defaultParts: ["day"] },
  { code: "bd", name: { ru: "День рождения", uz: "Tugʻilgan kun" }, defaultParts: ["evening"] },
  { code: "yubiley", name: { ru: "Юбилей", uz: "Yubiley" }, defaultParts: ["evening"] },
  { code: "corp", name: { ru: "Корпоратив", uz: "Korporativ" }, defaultParts: ["evening"] },
  { code: "small", name: { ru: "Частное", uz: "Yopiq davra" }, defaultParts: ["evening"] },
];

/**
 * Какие части отметить в форме заявки, когда клиент выбрал повод: части повода, в которых
 * витрина работает и которые свободны (available). Таких нет, а свободная часть одна — она;
 * иначе ничего (клиент выберет сам)
 */
export function occasionParts(
  defaultParts: readonly DayPart[] | undefined,
  available: readonly DayPart[],
): DayPart[] {
  const picked = sortParts((defaultParts ?? []).filter((part) => available.includes(part)));
  if (picked.length > 0) return picked;
  return available.length === 1 ? [...available] : [];
}
