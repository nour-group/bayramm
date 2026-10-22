/* Категории и услуги: конфигурация, тексты и проверки — @bayramm/shared/categories.

   Что где:
     config.ts       — CATEGORIES: режим занятости, правило фото, поля витрины, форма заявки,
                       каталог услуг с опциями;
     types.ts        — типы описания и перечисления (единицы цены, части дня, …);
     validate.ts     — проверки полей витрины, ссылок на видео, услуг, формы заявки и
                       фильтров каталога — одинаковые на сервере и в интерфейсах;
     availability.ts — части дня (модель parts): окна, «Время работы» витрины и занятость дня;
     occasions.ts    — поводы заявки и части дня по умолчанию у каждого;
     details.ts      — поля заявки как их хранит база и их краткая запись строками;
     forms.ts        — формы панели и кабинета: поля витрины, ссылки на видео, услуга с
                       опциями, поля заявки и предложение правки услуги для показа;
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
export {
  busyParts,
  choosableParts,
  type DayLoad,
  type DayMarks,
  DEFAULT_DAY_PARTS,
  dayLoadOf,
  dayPartOf,
  dayPartWindows,
  defaultDaySessions,
  effectiveWindows,
  FREE_DAY,
  freeIn,
  hasDayParts,
  inWindow,
  type PartLoad,
  partLoads,
  sortParts,
  toMinutes,
  windowText,
} from "./availability";
export { CATEGORIES } from "./config";
export {
  type ChosenOptionSnapshot,
  type ChosenServiceSnapshot,
  detailsSummary,
  type RequestDetails,
} from "./details";
export {
  type AttributeDraft,
  type AttributeDrafts,
  attributeDrafts,
  attributeErrors,
  attributeLabel,
  attributePatch,
  attributesOf,
  attributeText,
  choiceLabel,
  chosenServices,
  type DaySessionsDraft,
  type DetailRow,
  daySessionsDirty,
  daySessionsDraft,
  daySessionsInput,
  detailRows,
  draftValue,
  emptyListItem,
  type ListItemDraft,
  newOptionDraft,
  newServiceDraft,
  type OptionDraft,
  parseAmount,
  priceUnitLabel,
  type ServiceChangeField,
  type ServiceChangeRow,
  type ServiceDraft,
  serviceChangeRows,
  serviceDirty,
  serviceDraftOf,
  serviceErrors,
  serviceInput,
  serviceTypeLabel,
  videoLinkErrors,
  videoLinksValue,
  windowTimes,
} from "./forms";
export { OCCASIONS, type OccasionSpec, occasionParts } from "./occasions";
export { categoriesSeedSql, SEED_BEGIN, SEED_END } from "./sql";
export * from "./types";
export {
  ATTRIBUTE_FILTER_PREFIX,
  type AttributeFilter,
  type AttributeValue,
  categoryConfig,
  categoryFilters,
  categoryPriceUnits,
  type DaySessionsValue,
  type DetailValue,
  daySessionsOf,
  type FilterSpec,
  guestsAllowed,
  implausiblePerGuest,
  isCategoryCode,
  isDayPart,
  isPriceUnit,
  type ListItemValue,
  type ListingAttributes,
  type LocalizedText,
  MAX_CHOSEN_QTY,
  MAX_CHOSEN_SERVICES,
  MAX_PARALLEL_CAPACITY,
  mergeAttributes,
  missingAttributes,
  normalizeVideoLink,
  PER_GUEST_PRICE_WARN,
  parseAttributeFilters,
  parseWindows,
  type RequestDetailsInput,
  type RequestPartsInput,
  type Result,
  readAttributes,
  requestCovers,
  requiredAttributeKeys,
  SERVICE_LIMITS,
  type ServiceChoice,
  type ServiceOptionValue,
  type ServiceValues,
  serviceType,
  VIDEO_LINK_DB_RE,
  validateAttributePatch,
  validateDaySessions,
  validateRequestDetails,
  validateRequestParts,
  validateServiceInput,
  validateVideoLinks,
  windowOverlaps,
} from "./validate";
