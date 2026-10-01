/* Сид справочников категорий для миграции: app.categories и app.service_types из
   конфигурации. Печатает его pnpm --filter @bayramm/shared categories:sql; тест
   sql.test.ts сверяет блок в последней миграции с этим выводом, интеграционный тест API —
   базу с конфигурацией. Повторный прогон сида обновляет названия и правила, коды не меняются. */

import { categoriesRu, categoriesUz } from "../i18n/categories";
import { CATEGORIES } from "./config";
import { requiredAttributeKeys } from "./validate";

/** Начало и конец блока сида в миграции — по ним его находит тест */
export const SEED_BEGIN = "-- categories-seed:begin (pnpm --filter @bayramm/shared categories:sql)";
export const SEED_END = "-- categories-seed:end";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const textArray = (values: readonly string[]) =>
  values.length === 0 ? "'{}'::text[]" : `array[${values.map(literal).join(", ")}]::text[]`;

/** Сид категорий и каталога услуг — блок SQL между SEED_BEGIN и SEED_END */
export function categoriesSeedSql(): string {
  const categories = CATEGORIES.map((c) =>
    [
      literal(c.code),
      literal(categoriesRu[c.label]),
      literal(categoriesUz[c.label]),
      String(c.enabled),
      String(c.sort),
      `${literal(c.availability)}::app.availability_mode`,
      `${literal(c.photoPolicy)}::app.photo_policy`,
      String(c.minPhotos),
      String(c.maxVideoLinks),
      textArray(c.listingFields),
      textArray(requiredAttributeKeys(c)),
      textArray(c.requiredServices),
    ].join(", "),
  );

  const services = CATEGORIES.flatMap((c) =>
    c.services.map((s, index) => {
      const options = s.options.map((o) => ({
        code: o.code,
        name_ru: categoriesRu[o.label],
        name_uz: categoriesUz[o.label],
        unit: o.unit,
      }));
      return [
        literal(c.code),
        literal(s.code),
        literal(categoriesRu[s.label]),
        literal(categoriesUz[s.label]),
        `array[${s.units.map(literal).join(", ")}]::app.price_unit[]`,
        `${literal(s.tier)}::app.service_tier`,
        String(s.inPriceFrom),
        String(s.freeName),
        String(index + 1),
        `${literal(JSON.stringify(options))}::jsonb`,
      ].join(", ");
    }),
  );

  return [
    SEED_BEGIN,
    "insert into app.categories (code, name_ru, name_uz, enabled, sort, availability_mode, photo_policy,",
    "                            min_photos, max_video_links, required_fields, required_attributes,",
    "                            required_services) values",
    categories.map((row) => `  (${row})`).join(",\n"),
    "on conflict (code) do update set",
    "  name_ru = excluded.name_ru, name_uz = excluded.name_uz, enabled = excluded.enabled,",
    "  sort = excluded.sort, availability_mode = excluded.availability_mode,",
    "  photo_policy = excluded.photo_policy, min_photos = excluded.min_photos,",
    "  max_video_links = excluded.max_video_links, required_fields = excluded.required_fields,",
    "  required_attributes = excluded.required_attributes, required_services = excluded.required_services;",
    "",
    "insert into app.service_types (category_code, code, name_ru, name_uz, units, tier, in_price_from,",
    "                               free_name, sort, options) values",
    services.map((row) => `  (${row})`).join(",\n"),
    "on conflict (category_code, code) do update set",
    "  name_ru = excluded.name_ru, name_uz = excluded.name_uz, units = excluded.units,",
    "  tier = excluded.tier, in_price_from = excluded.in_price_from, free_name = excluded.free_name,",
    "  sort = excluded.sort, options = excluded.options, enabled = true;",
    SEED_END,
  ].join("\n");
}
