/* Категории и услуги: конфигурация, тексты и проверки — @bayramm/shared/categories.

   Что где:
     config.ts       — CATEGORIES: режим занятости, правило фото, поля витрины, форма заявки,
                       каталог услуг с опциями;
     types.ts        — типы описания и перечисления (единицы цены, части дня, …);
     validate.ts     — проверки полей витрины, ссылок на видео, услуг, формы заявки и
                       фильтров каталога — одинаковые на сервере и в интерфейсах;
     availability.ts — части дня (модель parts) и перевод времени заявки в часть дня;
     details.ts      — поля заявки как их хранит база и их краткая запись строками;
     sql.ts          — сид app.categories и app.service_types для миграции.
   Тексты — i18n/categories (ru, uz): ключи подписей проверяет компилятор. */

export {
  type CategoryDict,
  type CategoryTextKey,
  categoriesRu,
  categoriesUz,
  categoryDictionaries,
  categoryText,
  categoryTexts,
} from "../i18n/categories";
export { DEFAULT_DAY_PARTS, dayPartOf, dayPartWindows, hasDayParts } from "./availability";
export { CATEGORIES } from "./config";
export {
  type ChosenOptionSnapshot,
  type ChosenServiceSnapshot,
  detailsSummary,
  type RequestDetails,
} from "./details";
export { categoriesSeedSql, SEED_BEGIN, SEED_END } from "./sql";
export * from "./types";
export {
  ATTRIBUTE_FILTER_PREFIX,
  type AttributeFilter,
  type AttributeValue,
  categoryConfig,
  categoryFilters,
  categoryPriceUnits,
  type DetailValue,
  type FilterSpec,
  guestsAllowed,
  isCategoryCode,
  isPriceUnit,
  type ListItemValue,
  type ListingAttributes,
  type LocalizedText,
  MAX_CHOSEN_QTY,
  MAX_CHOSEN_SERVICES,
  mergeAttributes,
  missingAttributes,
  normalizeVideoLink,
  parseAttributeFilters,
  type RequestDetailsInput,
  type Result,
  readAttributes,
  requiredAttributeKeys,
  SERVICE_LIMITS,
  type ServiceChoice,
  type ServiceOptionValue,
  type ServiceValues,
  serviceType,
  VIDEO_LINK_DB_RE,
  validateAttributePatch,
  validateRequestDetails,
  validateServiceInput,
  validateVideoLinks,
} from "./validate";
