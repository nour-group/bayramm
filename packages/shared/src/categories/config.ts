/* Категории площадки — единственный источник правды.

   Из этого описания:
     · миграция сеет app.categories и app.service_types (scripts/categories-sql.ts печатает
       сид; интеграционный тест API сверяет базу с конфигурацией);
     · API проверяет поля витрины, услуги, форму заявки и фильтры каталога (validate.ts);
     · панель, кабинет и клиент строят формы и фильтры, а не пишут их под каждую категорию.

   Новая категория или тип услуги — правка здесь, тексты в i18n/categories (ru, uz) и
   миграция с новым сидом (порядок — в CLAUDE.md, раздел «Категории и услуги»). Код
   категории и типа услуги после выпуска не меняется: на него ссылаются карточки и заявки. */

import type { CategoryTextKey } from "../i18n/categories";
import type {
  AttributeField,
  CategoryCode,
  CategoryConfig,
  Choice,
  OptionTemplate,
  PriceUnit,
  RequestField,
  ServiceTier,
  ServiceType,
} from "./types";

// ── помощники: ключи подписей проверяет компилятор ──────────────────────────

type Suffix<P extends string, K = CategoryTextKey> = K extends `${P}_${infer S}` ? S : never;

/** Варианты из словаря: choices("color", ["white"]) → { code: "white", label: "color_white" } */
function choices<P extends string>(prefix: P, codes: readonly Suffix<P>[]): readonly Choice[] {
  return codes.map((code) => ({ code, label: `${prefix}_${code}` as CategoryTextKey }));
}

function opt(code: Suffix<"opt">, unit: PriceUnit): OptionTemplate {
  return { code, label: `opt_${code}` as CategoryTextKey, unit };
}

interface ServiceSpec {
  readonly units: readonly PriceUnit[];
  readonly tier?: ServiceTier;
  readonly inPriceFrom?: boolean;
  readonly options?: readonly OptionTemplate[];
}

/** Тип услуги категории: подпись — svc_<категория>_<код> */
function service<C extends CategoryCode>(
  category: C,
  code: Suffix<`svc_${C}`>,
  spec: ServiceSpec,
): ServiceType {
  return {
    code,
    label: `svc_${category}_${code}` as CategoryTextKey,
    units: spec.units,
    tier: spec.tier ?? "extra",
    inPriceFrom: spec.inPriceFrom ?? true,
    freeName: false,
    options: spec.options ?? [],
  };
}

/** «Другая услуга»: название пишет вендор, в цену «от» не входит, проходит модерацию */
function other(units: readonly PriceUnit[]): ServiceType {
  return {
    code: "other",
    label: "svc_other",
    units,
    tier: "extra",
    inPriceFrom: false,
    freeName: true,
    options: [],
  };
}

// ── общие наборы вариантов ──────────────────────────────────────────────────

const SERVICE_AREA = choices("area", ["tashkent", "tashkent_region", "uzbekistan"]);
const PALETTE = choices("color", [
  "white",
  "cream",
  "pink",
  "red",
  "burgundy",
  "gold",
  "silver",
  "blue",
  "green",
  "purple",
  "black",
  "multicolor",
]);
const CAR_COLORS = choices("color", ["white", "black", "silver", "red", "blue", "other"]);
const FULFILLMENT = choices("fulfillment", ["delivery", "pickup"]);
const CAR_CLASSES = choices("car_class", ["sedan", "premium", "suv", "limousine", "retro", "minivan", "bus"]);
const FLOWER_KINDS = choices("flowers", ["live", "artificial"]);
const DECOR_STYLES = choices("decor_style", ["classic", "national", "modern", "rustic", "minimal"]);
const FILLINGS = choices("filling", ["chocolate", "vanilla", "berry", "fruit", "nut", "caramel", "cheese"]);
const GIFT_KINDS = choices("gift_kind", ["bonbonniere", "in_law", "couple", "corporate", "souvenirs"]);

// ── общие поля ──────────────────────────────────────────────────────────────

const serviceArea = (required: boolean): AttributeField => ({
  key: "service_area",
  label: "attr_service_area",
  type: "enum",
  options: SERVICE_AREA,
  required,
  filter: "any",
});

const leadDays = (max: number): AttributeField => ({
  key: "lead_days",
  label: "attr_lead_days",
  type: "int",
  min: 0,
  max,
  required: true,
  filter: "max",
});

const flag = (key: string, label: CategoryTextKey, filter = false): AttributeField => ({
  key,
  label,
  type: "bool",
  required: false,
  ...(filter ? { filter: "eq" as const } : {}),
});

/** Выбор услуг витрины в заявке */
const servicesField = (required: boolean): RequestField => ({
  key: "services",
  label: "rf_services",
  type: "services",
  required,
  minItems: required ? 1 : 0,
});

const startTime = (required: boolean): RequestField => ({
  key: "start_time",
  label: "rf_start_time",
  type: "time",
  required,
});

const hours = (max: number, required: boolean): RequestField => ({
  key: "hours",
  label: "rf_hours",
  type: "int",
  min: 1,
  max,
  required,
});

const fulfillment: RequestField = {
  key: "fulfillment",
  label: "rf_fulfillment",
  type: "enum",
  options: FULFILLMENT,
  required: true,
};

const deliveryDistrict: RequestField = {
  key: "delivery_district",
  label: "rf_delivery_district",
  type: "district",
  required: false,
};

const palette: RequestField = {
  key: "palette",
  label: "rf_palette",
  type: "multi",
  options: PALETTE,
  required: false,
};

// ── категории ───────────────────────────────────────────────────────────────

const hall: CategoryConfig = {
  code: "hall",
  label: "cat_hall",
  enabled: true,
  sort: 1,
  availability: "day",
  photoPolicy: "no_people",
  minPhotos: 3,
  recommendedPhotos: 6,
  maxVideoLinks: 0,
  // Вместимость (cap_min, cap_max) и район — столбцы карточки, как в v0.1
  listingFields: ["guest_capacity", "district"],
  attributes: [
    { key: "halls_count", label: "attr_halls_count", type: "int", min: 1, max: 20, required: false },
    {
      key: "parking_spaces",
      label: "attr_parking_spaces",
      type: "int",
      min: 0,
      max: 2000,
      required: false,
      filter: "min",
    },
    {
      key: "kitchen",
      label: "attr_kitchen",
      type: "enum",
      options: choices("kitchen", ["own", "external", "both"]),
      required: false,
      filter: "any",
    },
    {
      key: "alcohol",
      label: "attr_alcohol",
      type: "enum",
      options: choices("alcohol", ["allowed", "bring_own", "not_allowed"]),
      required: false,
    },
    flag("stage", "attr_stage"),
    flag("bride_room", "attr_bride_room"),
    flag("air_conditioning", "attr_air_conditioning"),
    flag("entrance_arch", "attr_entrance_arch"),
    flag("accessible", "attr_accessible", true),
  ],
  requestForm: { guests: "required", fields: [servicesField(false)] },
  services: [
    service("hall", "banquet_weekday", {
      units: ["per_guest", "per_event"],
      tier: "base",
      options: [opt("extra_dish", "per_guest"), opt("drinks", "per_guest"), opt("cake", "per_event")],
    }),
    service("hall", "banquet_weekend", {
      units: ["per_guest", "per_event"],
      tier: "base",
      options: [opt("extra_dish", "per_guest"), opt("drinks", "per_guest"), opt("cake", "per_event")],
    }),
    service("hall", "morning_plov", { units: ["per_guest"], inPriceFrom: false }),
    service("hall", "fotiha_hall", { units: ["per_guest", "per_event"], inPriceFrom: false }),
    service("hall", "hall_rent", {
      units: ["per_event"],
      inPriceFrom: false,
      options: [opt("decor", "per_event"), opt("sound", "per_event"), opt("stage", "per_event")],
    }),
    other(["per_guest", "per_event"]),
  ],
  // Как пакеты «будни» и «выходные» в v0.1
  requiredServices: ["banquet_weekday", "banquet_weekend"],
};

const car: CategoryConfig = {
  code: "car",
  label: "cat_car",
  enabled: true,
  sort: 2,
  // Несколько машин — несколько заказов в день: утром, днём и вечером
  availability: "parts",
  photoPolicy: "no_people",
  minPhotos: 3,
  recommendedPhotos: 6,
  maxVideoLinks: 0,
  listingFields: [],
  attributes: [
    {
      key: "fleet",
      label: "attr_fleet",
      type: "list",
      maxItems: 30,
      required: true,
      fields: [
        {
          key: "model",
          label: "attr_fleet_model",
          type: "text",
          maxLength: 60,
          localized: false,
          required: true,
        },
        {
          key: "class",
          label: "attr_fleet_class",
          type: "enum",
          options: CAR_CLASSES,
          required: true,
          filter: "any",
        },
        {
          key: "color",
          label: "attr_fleet_color",
          type: "enum",
          options: CAR_COLORS,
          required: false,
          filter: "any",
        },
        {
          key: "seats",
          label: "attr_fleet_seats",
          type: "int",
          min: 1,
          max: 60,
          required: false,
          filter: "min",
        },
        { key: "year", label: "attr_fleet_year", type: "int", min: 1950, max: 2030, required: false },
      ],
    },
    flag("decoration", "attr_car_decoration", true),
    serviceArea(true),
    { key: "min_order_hours", label: "attr_min_order_hours", type: "int", min: 1, max: 24, required: false },
  ],
  requestForm: {
    guests: "hidden",
    fields: [
      startTime(true),
      hours(24, true),
      { key: "cars_count", label: "rf_cars_count", type: "int", min: 1, max: 30, required: true },
      { key: "car_class", label: "rf_car_class", type: "enum", options: CAR_CLASSES, required: false },
      servicesField(false),
    ],
  },
  services: [
    service("car", "bride_car", {
      units: ["per_hour"],
      tier: "base",
      options: [
        opt("flower_decor", "per_event"),
        opt("extra_hour", "per_hour"),
        opt("champagne", "per_item"),
      ],
    }),
    service("car", "motorcade", {
      units: ["per_hour"],
      options: [opt("decor", "per_event"), opt("coordinator", "per_event")],
    }),
    service("car", "limousine", { units: ["per_hour"], options: [opt("photo_stops", "per_event")] }),
    service("car", "retro_car", {
      units: ["per_hour", "per_event"],
      options: [opt("photo_stops", "per_event")],
    }),
    service("car", "guest_transfer", { units: ["per_hour", "per_event"] }),
    service("car", "car_decor", {
      units: ["per_item"],
      inPriceFrom: false,
      options: [opt("fresh_flowers", "per_item")],
    }),
    other(["per_hour", "per_event", "per_item"]),
  ],
  requiredServices: [],
};

const studio: CategoryConfig = {
  code: "studio",
  label: "cat_studio",
  enabled: true,
  sort: 3,
  availability: "slot",
  photoPolicy: "portfolio",
  minPhotos: 3,
  recommendedPhotos: 6,
  maxVideoLinks: 3,
  listingFields: ["district"],
  attributes: [
    { key: "area_m2", label: "attr_area_m2", type: "int", min: 10, max: 5000, required: true, filter: "min" },
    {
      key: "zones_count",
      label: "attr_zones_count",
      type: "int",
      min: 1,
      max: 50,
      required: true,
      filter: "min",
    },
    { key: "zones", label: "attr_zones", type: "text", maxLength: 300, localized: true, required: false },
    flag("natural_light", "attr_natural_light", true),
    flag("props", "attr_props"),
    flag("makeup_room", "attr_makeup_room", true),
    flag("dressing_room", "attr_dressing_room"),
    { key: "max_people", label: "attr_max_people", type: "int", min: 1, max: 200, required: false },
    flag("parking", "attr_parking"),
  ],
  requestForm: {
    guests: "hidden",
    fields: [
      startTime(true),
      hours(12, true),
      { key: "people", label: "rf_people", type: "int", min: 1, max: 100, required: true },
      {
        key: "session_kind",
        label: "rf_session_kind",
        type: "enum",
        options: choices("session", ["love_story", "pre_wedding", "family", "beshik", "portrait"]),
        required: false,
      },
      { key: "need_photographer", label: "rf_need_photographer", type: "bool", required: false },
      servicesField(false),
    ],
  },
  services: [
    service("studio", "studio_rent", {
      units: ["per_hour"],
      tier: "base",
      options: [opt("extra_hour", "per_hour"), opt("extra_zone", "per_hour")],
    }),
    service("studio", "love_story_package", {
      units: ["per_event"],
      options: [opt("makeup", "per_event"), opt("outfit_rent", "per_event")],
    }),
    service("studio", "pre_wedding_shoot", { units: ["per_event"] }),
    service("studio", "family_shoot", { units: ["per_event"] }),
    service("studio", "makeup_hair", { units: ["per_event"], inPriceFrom: false }),
    other(["per_hour", "per_event"]),
  ],
  requiredServices: [],
};

const flowers: CategoryConfig = {
  code: "flowers",
  label: "cat_flowers",
  enabled: true,
  sort: 4,
  availability: "lead",
  photoPolicy: "no_people",
  minPhotos: 3,
  recommendedPhotos: 6,
  maxVideoLinks: 0,
  listingFields: [],
  attributes: [
    {
      key: "flower_kinds",
      label: "attr_flower_kinds",
      type: "multi",
      options: FLOWER_KINDS,
      required: true,
      filter: "any",
    },
    flag("delivery", "attr_delivery", true),
    flag("pickup", "attr_pickup"),
    leadDays(60),
    {
      key: "working_hours",
      label: "attr_working_hours",
      type: "text",
      maxLength: 40,
      localized: false,
      required: false,
    },
  ],
  requestForm: {
    guests: "hidden",
    fields: [
      { key: "ready_time", label: "rf_ready_time", type: "time", required: false },
      fulfillment,
      deliveryDistrict,
      servicesField(true),
      palette,
    ],
  },
  services: [
    service("flowers", "bridal_bouquet", {
      units: ["per_item"],
      tier: "base",
      options: [opt("toss_bouquet", "per_item")],
    }),
    service("flowers", "boutonniere", { units: ["per_item"], inPriceFrom: false }),
    service("flowers", "car_flower_decor", { units: ["per_set"] }),
    service("flowers", "hall_flower_decor", {
      units: ["per_event"],
      options: [opt("arch", "per_item"), opt("flower_wall", "per_item")],
    }),
    service("flowers", "flower_arch", { units: ["per_item"] }),
    service("flowers", "table_compositions", { units: ["per_table"] }),
    service("flowers", "gift_bouquet", { units: ["per_item"], options: [opt("delivery", "per_event")] }),
    other(["per_item", "per_set", "per_event", "per_table"]),
  ],
  requiredServices: [],
};

const photo: CategoryConfig = {
  code: "photo",
  label: "cat_photo",
  enabled: true,
  sort: 5,
  // Утром — нахорги ош, днём — ЗАГС и фотосессия, вечером — свадьба
  availability: "parts",
  photoPolicy: "portfolio",
  minPhotos: 3,
  recommendedPhotos: 6,
  maxVideoLinks: 3,
  listingFields: [],
  attributes: [
    {
      key: "team",
      label: "attr_team",
      type: "multi",
      options: choices("team", ["photographer", "videographer", "drone_operator"]),
      required: true,
      filter: "all",
    },
    {
      key: "equipment",
      label: "attr_equipment",
      type: "multi",
      options: choices("equipment", ["camera", "drone", "stabilizer", "lighting"]),
      required: false,
    },
    {
      key: "delivery_days",
      label: "attr_delivery_days",
      type: "int",
      min: 1,
      max: 180,
      required: true,
      filter: "max",
    },
    {
      key: "styles",
      label: "attr_photo_styles",
      type: "multi",
      options: choices("photo_style", ["reportage", "cinematic", "classic", "fine_art"]),
      required: false,
      filter: "any",
    },
    serviceArea(false),
  ],
  requestForm: {
    guests: "optional",
    fields: [
      startTime(true),
      hours(16, false),
      {
        key: "coverage",
        label: "rf_coverage",
        type: "multi",
        options: choices("coverage", ["photo", "video", "drone", "love_story"]),
        required: true,
      },
      servicesField(false),
    ],
  },
  services: [
    service("photo", "photo_shoot", {
      units: ["per_hour", "per_event"],
      tier: "base",
      options: [
        opt("extra_hour", "per_hour"),
        opt("second_photographer", "per_event"),
        opt("photobook", "per_item"),
      ],
    }),
    service("photo", "videography", {
      units: ["per_hour", "per_event"],
      options: [opt("second_camera", "per_event"), opt("extra_hour", "per_hour")],
    }),
    service("photo", "drone", { units: ["per_event"] }),
    service("photo", "love_story", { units: ["per_event"], options: [opt("studio_rent", "per_hour")] }),
    service("photo", "same_day_edit", { units: ["per_event"] }),
    service("photo", "morning_plov_shoot", { units: ["per_hour", "per_event"] }),
    service("photo", "photobook", { units: ["per_item"], inPriceFrom: false }),
    other(["per_hour", "per_event", "per_item"]),
  ],
  requiredServices: [],
};

const cake: CategoryConfig = {
  code: "cake",
  label: "cat_cake",
  enabled: true,
  sort: 6,
  availability: "lead",
  photoPolicy: "no_people",
  minPhotos: 3,
  recommendedPhotos: 6,
  maxVideoLinks: 0,
  listingFields: [],
  attributes: [
    {
      key: "cake_kinds",
      label: "attr_cake_kinds",
      type: "multi",
      options: choices("cake_kind", ["wedding", "tiered", "bento", "cupcakes", "national", "candy_bar"]),
      required: true,
      filter: "any",
    },
    { key: "fillings", label: "attr_fillings", type: "multi", options: FILLINGS, required: false },
    {
      key: "cake_decor",
      label: "attr_cake_decor",
      type: "multi",
      options: choices("cake_decor", ["fondant", "cream", "fresh_flowers", "figures"]),
      required: false,
    },
    flag("delivery", "attr_delivery", true),
    flag("tasting", "attr_tasting", true),
    leadDays(60),
    {
      key: "min_weight_kg",
      label: "attr_min_weight_kg",
      type: "int",
      min: 1,
      max: 100,
      required: false,
      filter: "max",
    },
    flag("certificates", "attr_certificates"),
  ],
  requestForm: {
    guests: "optional",
    fields: [
      { key: "weight_kg", label: "rf_weight_kg", type: "int", min: 1, max: 200, required: false },
      { key: "tiers", label: "rf_tiers", type: "int", min: 1, max: 10, required: false },
      { key: "filling", label: "rf_filling", type: "enum", options: FILLINGS, required: false },
      fulfillment,
      deliveryDistrict,
      { key: "ready_time", label: "rf_ready_time", type: "time", required: false },
      servicesField(false),
    ],
  },
  services: [
    service("cake", "wedding_cake", {
      units: ["per_kg"],
      tier: "base",
      options: [
        opt("tier", "per_item"),
        opt("figure", "per_item"),
        opt("fresh_flowers", "per_event"),
        opt("delivery", "per_event"),
      ],
    }),
    service("cake", "bento", { units: ["per_item"] }),
    service("cake", "candy_bar", {
      units: ["per_guest", "per_event"],
      options: [opt("decor", "per_event"), opt("table", "per_event")],
    }),
    service("cake", "pastries", { units: ["per_kg", "per_item"] }),
    service("cake", "tasting", { units: ["per_event"], inPriceFrom: false }),
    other(["per_kg", "per_item", "per_event"]),
  ],
  requiredServices: [],
};

const gifts: CategoryConfig = {
  code: "gifts",
  label: "cat_gifts",
  enabled: true,
  sort: 7,
  availability: "lead",
  photoPolicy: "no_people",
  minPhotos: 3,
  recommendedPhotos: 6,
  maxVideoLinks: 0,
  listingFields: [],
  attributes: [
    {
      key: "gift_kinds",
      label: "attr_gift_kinds",
      type: "multi",
      options: GIFT_KINDS,
      required: true,
      filter: "any",
    },
    flag("personalization", "attr_personalization", true),
    flag("packaging", "attr_packaging"),
    {
      key: "min_batch",
      label: "attr_min_batch",
      type: "int",
      min: 1,
      max: 10000,
      required: true,
      filter: "max",
    },
    leadDays(90),
    flag("delivery", "attr_delivery", true),
  ],
  requestForm: {
    guests: "hidden",
    fields: [
      { key: "quantity", label: "rf_quantity", type: "int", min: 1, max: 10000, required: true },
      { key: "gift_kind", label: "rf_gift_kind", type: "enum", options: GIFT_KINDS, required: false },
      { key: "personalization", label: "rf_personalization", type: "bool", required: false },
      fulfillment,
      deliveryDistrict,
      servicesField(false),
    ],
  },
  services: [
    service("gifts", "bonbonniere", {
      units: ["per_item"],
      tier: "base",
      options: [opt("name_print", "per_item")],
    }),
    service("gifts", "in_law_gift_set", {
      units: ["per_set"],
      options: [opt("special_packaging", "per_set")],
    }),
    service("gifts", "couple_gift_set", { units: ["per_set"] }),
    service("gifts", "corporate_gifts", { units: ["per_item"], options: [opt("logo", "per_item")] }),
    other(["per_item", "per_set"]),
  ],
  requiredServices: [],
};

const decor: CategoryConfig = {
  code: "decor",
  label: "cat_decor",
  enabled: true,
  sort: 8,
  // Утренний плов и вечерняя свадьба — разные заказы одной команды
  availability: "parts",
  photoPolicy: "no_people",
  minPhotos: 3,
  recommendedPhotos: 6,
  maxVideoLinks: 0,
  listingFields: [],
  attributes: [
    {
      key: "styles",
      label: "attr_decor_styles",
      type: "multi",
      options: DECOR_STYLES,
      required: true,
      filter: "any",
    },
    {
      key: "flower_kinds",
      label: "attr_flower_kinds",
      type: "multi",
      options: FLOWER_KINDS,
      required: false,
      filter: "any",
    },
    flag("own_furniture", "attr_own_furniture"),
    flag("installation", "attr_installation"),
    serviceArea(false),
  ],
  requestForm: {
    guests: "optional",
    fields: [
      startTime(true),
      { key: "tables", label: "rf_tables", type: "int", min: 1, max: 500, required: false },
      {
        key: "zones",
        label: "rf_zones",
        type: "multi",
        options: choices("zone", ["stage", "entrance", "tables", "photozone"]),
        required: true,
      },
      { key: "style", label: "rf_style", type: "enum", options: DECOR_STYLES, required: false },
      palette,
      servicesField(false),
    ],
  },
  services: [
    service("decor", "stage_decor", {
      units: ["per_event"],
      tier: "base",
      options: [opt("flower_wall", "per_event"), opt("lighting", "per_event")],
    }),
    service("decor", "full_hall_package", { units: ["per_event"] }),
    service("decor", "table_decor", { units: ["per_table"] }),
    service("decor", "entrance_arch", { units: ["per_item", "per_event"] }),
    service("decor", "lighting_effects", {
      units: ["per_event"],
      options: [opt("smoke", "per_event"), opt("confetti", "per_event")],
    }),
    service("decor", "morning_plov_decor", { units: ["per_event"] }),
    other(["per_event", "per_table", "per_item"]),
  ],
  requiredServices: [],
};

/**
 * Следующий этап: в каталоге выключены, у вендора — только «другая услуга». Поля витрины,
 * формы и каталог услуг добавятся вместе с включением категории
 */
function later(
  code: CategoryCode,
  label: CategoryTextKey,
  sort: number,
  units: readonly PriceUnit[],
): CategoryConfig {
  return {
    code,
    label,
    enabled: false,
    sort,
    availability: code === "attire" ? "lead" : "day",
    photoPolicy: "no_people",
    minPhotos: 3,
    recommendedPhotos: 6,
    maxVideoLinks: 0,
    listingFields: [],
    attributes: [],
    requestForm: { guests: "optional", fields: [servicesField(false)] },
    services: [other(units)],
    requiredServices: [],
  };
}

/** Все категории в порядке показа */
export const CATEGORIES: readonly CategoryConfig[] = [
  hall,
  car,
  studio,
  flowers,
  photo,
  cake,
  gifts,
  decor,
  later("food", "cat_food", 9, ["per_guest", "per_event"]),
  later("restaurant", "cat_restaurant", 10, ["per_guest", "per_event"]),
  later("attire", "cat_attire", 11, ["per_item", "per_event"]),
  later("music", "cat_music", 12, ["per_hour", "per_event"]),
  later("kids", "cat_kids", 13, ["per_hour", "per_event"]),
  later("zags", "cat_zags", 14, ["per_event"]),
];
