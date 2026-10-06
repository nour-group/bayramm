import type {
  BusyParts,
  DayPart,
  ListingAttributes,
  ListingDetail,
  Localized,
  PriceUnit,
  PublicService,
} from "@bayramm/shared/api";
import { categoryConfig, categoryTexts, serviceType } from "@bayramm/shared/categories";
import { addDays } from "../format";

/* Демо-витрины категорий кроме залов — для `pnpm dev:web` и тестов (через api/mock.ts).
   По три на категорию: поля витрины, услуги с опциями, видео у фото и студий, занятость
   по модели категории (части дня у кортежа, фото и декора; срок заказа у цветов, тортов и
   подарков). Названия вымышленные, телефоны — в несуществующем коде +998 00. Цены «от»
   считаются так же, как у сервера: самая низкая цена услуг, входящих в цену «от». */

/**
 * Демо-витрина: карточка, как её отдаёт API, и её контакты — их API отдаёт только по «Связаться»
 * (POST …/contact); демо-API — так же (mock.ts)
 */
export type DemoListing = ListingDetail & { readonly phone: string; readonly telegram: string | null };

/** Telegram демо-витрины — у каждой второй: имя из адреса страницы (lola-zali → lola_zali) */
export const demoTelegram = (slug: string, n: number): string | null =>
  n % 2 === 0 ? slug.replace(/-/g, "_") : null;

/** UUID из числа — формат как у Postgres; тот же вид, что у демо-залов (mock.ts) */
export const demoUuid = (kind: number, n: number) =>
  `00000000-0000-4000-8${kind}00-${n.toString(16).padStart(12, "0")}`;

interface OptionSpec {
  readonly code: string;
  readonly price: number;
  readonly unit: PriceUnit;
}

interface ServiceSpec {
  readonly type: string;
  readonly price: number;
  readonly unit: PriceUnit;
  readonly minQty?: number;
  readonly leadDays?: number;
  readonly includes?: Localized;
  readonly options?: readonly OptionSpec[];
}

interface VitrinaSpec {
  readonly category: string;
  readonly slug: string;
  readonly name: string;
  readonly district?: string;
  /** Вместимость в гостях [от, до] — у категорий с вместимостью (рестораны) */
  readonly cap?: readonly [number, number];
  readonly attributes: ListingAttributes;
  readonly services: readonly ServiceSpec[];
  readonly videoLinks?: readonly string[];
  readonly parallelCapacity?: number;
  /** Дни, занятые целиком: смещение от «сегодня» */
  readonly busy?: readonly number[];
  /** Частично занятые дни: смещение от «сегодня» и занятые части */
  readonly parts?: readonly (readonly [number, readonly DayPart[]])[];
}

const SPECS: readonly VitrinaSpec[] = [
  // ── кортеж: части дня, несколько машин одновременно ──
  {
    category: "car",
    slug: "oq-kortej",
    name: "Oq Kortej",
    attributes: {
      fleet: [
        { model: "Chevrolet Malibu", class: "sedan", color: "white", seats: 4, year: 2022 },
        { model: "Mercedes-Benz E-Class", class: "premium", color: "black", seats: 4, year: 2020 },
      ],
      decoration: true,
      service_area: "tashkent",
      min_order_hours: 3,
    },
    services: [
      {
        type: "bride_car",
        price: 350_000,
        unit: "per_hour",
        minQty: 3,
        includes: {
          ru: "Водитель, топливо, лёгкое украшение лентами",
          uz: "Haydovchi, yoqilgʻi, lentalar bilan oddiy bezak",
        },
        options: [
          { code: "flower_decor", price: 400_000, unit: "per_event" },
          { code: "extra_hour", price: 350_000, unit: "per_hour" },
          { code: "champagne", price: 120_000, unit: "per_item" },
        ],
      },
      {
        type: "motorcade",
        price: 300_000,
        unit: "per_hour",
        minQty: 3,
        options: [
          { code: "decor", price: 200_000, unit: "per_event" },
          { code: "coordinator", price: 300_000, unit: "per_event" },
        ],
      },
      { type: "car_decor", price: 250_000, unit: "per_item" },
    ],
    parallelCapacity: 3,
    busy: [12],
    parts: [
      [7, ["evening"]],
      [9, ["morning", "day"]],
    ],
  },
  {
    category: "car",
    slug: "limuzin-lux",
    name: "Limuzin Lux",
    attributes: {
      fleet: [{ model: "Lincoln Town Car", class: "limousine", color: "white", seats: 10, year: 2015 }],
      decoration: true,
      service_area: "tashkent_region",
      min_order_hours: 2,
    },
    services: [
      {
        type: "limousine",
        price: 900_000,
        unit: "per_hour",
        minQty: 2,
        options: [{ code: "photo_stops", price: 300_000, unit: "per_event" }],
      },
    ],
    busy: [7],
  },
  {
    category: "car",
    slug: "retro-avto",
    name: "Retro Avto",
    attributes: {
      fleet: [
        { model: "GAZ-21 Volga", class: "retro", color: "black", seats: 4, year: 1965 },
        { model: "Mercedes-Benz Sprinter", class: "minivan", color: "silver", seats: 18, year: 2019 },
      ],
      decoration: false,
      service_area: "tashkent",
    },
    services: [
      { type: "retro_car", price: 700_000, unit: "per_hour", minQty: 2 },
      { type: "guest_transfer", price: 500_000, unit: "per_hour", minQty: 2 },
    ],
    parallelCapacity: 2,
  },
  // ── фотостудия: день в календаре, время — в заявке ──
  {
    category: "studio",
    slug: "oydin-studio",
    name: "Oydin Studio",
    district: "yunusobod",
    attributes: {
      area_m2: 180,
      zones_count: 4,
      zones: {
        ru: "Белый зал, окно в пол, классический интерьер, лофт",
        uz: "Oq zal, polgacha deraza, klassik interyer, loft",
      },
      natural_light: true,
      props: true,
      makeup_room: true,
      dressing_room: true,
      max_people: 15,
      parking: true,
    },
    services: [
      {
        type: "studio_rent",
        price: 250_000,
        unit: "per_hour",
        options: [
          { code: "extra_hour", price: 250_000, unit: "per_hour" },
          { code: "extra_zone", price: 100_000, unit: "per_hour" },
        ],
      },
      {
        type: "love_story_package",
        price: 2_500_000,
        unit: "per_event",
        options: [
          { code: "makeup", price: 600_000, unit: "per_event" },
          { code: "outfit_rent", price: 400_000, unit: "per_event" },
        ],
      },
      { type: "makeup_hair", price: 500_000, unit: "per_event" },
    ],
    videoLinks: ["https://www.youtube.com/watch?v=demoStudio1"],
    busy: [7, 15],
  },
  {
    category: "studio",
    slug: "kamalak-foto",
    name: "Kamalak Foto",
    district: "chilonzor",
    attributes: { area_m2: 90, zones_count: 2, natural_light: false, props: true, makeup_room: false },
    services: [
      { type: "studio_rent", price: 150_000, unit: "per_hour", minQty: 2 },
      { type: "family_shoot", price: 1_200_000, unit: "per_event" },
    ],
  },
  {
    category: "studio",
    slug: "nur-loft",
    name: "Nur Loft",
    district: "mirobod",
    attributes: {
      area_m2: 300,
      zones_count: 6,
      natural_light: true,
      props: true,
      makeup_room: true,
      dressing_room: true,
    },
    services: [
      { type: "studio_rent", price: 400_000, unit: "per_hour" },
      { type: "pre_wedding_shoot", price: 3_000_000, unit: "per_event" },
    ],
    videoLinks: ["https://www.instagram.com/reel/demoNurLoft1/"],
  },
  // ── цветы: календаря нет, заказ за N дней ──
  {
    category: "flowers",
    slug: "gulzor-flowers",
    name: "Gulzor Flowers",
    attributes: {
      flower_kinds: ["live"],
      delivery: true,
      pickup: true,
      lead_days: 2,
      working_hours: "09:00–20:00",
    },
    services: [
      {
        type: "bridal_bouquet",
        price: 450_000,
        unit: "per_item",
        options: [{ code: "toss_bouquet", price: 150_000, unit: "per_item" }],
      },
      { type: "boutonniere", price: 60_000, unit: "per_item" },
      { type: "car_flower_decor", price: 600_000, unit: "per_set" },
      { type: "table_compositions", price: 180_000, unit: "per_table", minQty: 5 },
    ],
  },
  {
    category: "flowers",
    slug: "lola-gul",
    name: "Lola Gul",
    attributes: { flower_kinds: ["live", "artificial"], delivery: true, lead_days: 3 },
    services: [
      {
        type: "hall_flower_decor",
        price: 4_500_000,
        unit: "per_event",
        options: [
          { code: "arch", price: 1_500_000, unit: "per_item" },
          { code: "flower_wall", price: 2_000_000, unit: "per_item" },
        ],
      },
      { type: "flower_arch", price: 1_800_000, unit: "per_item" },
    ],
  },
  {
    category: "flowers",
    slug: "sumbula-gul",
    name: "Sumbula",
    attributes: { flower_kinds: ["artificial"], delivery: false, pickup: true, lead_days: 1 },
    services: [
      {
        type: "gift_bouquet",
        price: 250_000,
        unit: "per_item",
        options: [{ code: "delivery", price: 50_000, unit: "per_event" }],
      },
      { type: "bridal_bouquet", price: 300_000, unit: "per_item" },
    ],
  },
  // ── фото и видео: части дня, команды ──
  {
    category: "photo",
    slug: "kadr-media",
    name: "Kadr Media",
    attributes: {
      team: ["photographer", "videographer", "drone_operator"],
      equipment: ["camera", "drone", "stabilizer", "lighting"],
      delivery_days: 30,
      styles: ["reportage", "cinematic"],
      service_area: "tashkent",
    },
    services: [
      {
        type: "photo_shoot",
        price: 500_000,
        unit: "per_hour",
        minQty: 3,
        includes: {
          ru: "300+ обработанных снимков, онлайн-галерея",
          uz: "300+ ishlangan surat, onlayn galereya",
        },
        options: [
          { code: "extra_hour", price: 500_000, unit: "per_hour" },
          { code: "second_photographer", price: 1_500_000, unit: "per_event" },
          { code: "photobook", price: 900_000, unit: "per_item" },
        ],
      },
      {
        type: "videography",
        price: 4_000_000,
        unit: "per_event",
        options: [{ code: "second_camera", price: 1_500_000, unit: "per_event" }],
      },
      { type: "drone", price: 1_200_000, unit: "per_event" },
      { type: "same_day_edit", price: 2_500_000, unit: "per_event", leadDays: 5 },
    ],
    videoLinks: [
      "https://www.youtube.com/watch?v=demoKadr001",
      "https://www.instagram.com/reel/demoKadrReel/",
    ],
    parallelCapacity: 2,
    busy: [10],
    parts: [
      [7, ["morning"]],
      [8, ["day", "evening"]],
    ],
  },
  {
    category: "photo",
    slug: "lahza-foto",
    name: "Lahza Foto",
    attributes: { team: ["photographer"], delivery_days: 14, styles: ["classic", "fine_art"] },
    services: [
      { type: "photo_shoot", price: 2_500_000, unit: "per_event" },
      {
        type: "love_story",
        price: 1_800_000,
        unit: "per_event",
        options: [{ code: "studio_rent", price: 200_000, unit: "per_hour" }],
      },
      { type: "morning_plov_shoot", price: 400_000, unit: "per_hour", minQty: 2 },
    ],
    busy: [7],
  },
  {
    category: "photo",
    slug: "tong-video",
    name: "Tong Video",
    attributes: { team: ["photographer", "videographer"], delivery_days: 45 },
    services: [
      { type: "videography", price: 600_000, unit: "per_hour", minQty: 4 },
      { type: "photo_shoot", price: 450_000, unit: "per_hour", minQty: 3 },
    ],
    parts: [[7, ["day", "evening"]]],
  },
  // ── торты: заказ за N дней ──
  {
    category: "cake",
    slug: "shirin-cake",
    name: "Shirin Cake",
    attributes: {
      cake_kinds: ["wedding", "tiered", "cupcakes"],
      fillings: ["chocolate", "vanilla", "berry"],
      cake_decor: ["fondant", "fresh_flowers"],
      delivery: true,
      tasting: true,
      lead_days: 5,
      min_weight_kg: 3,
      certificates: true,
    },
    services: [
      {
        type: "wedding_cake",
        price: 180_000,
        unit: "per_kg",
        minQty: 3,
        options: [
          { code: "tier", price: 300_000, unit: "per_item" },
          { code: "figure", price: 250_000, unit: "per_item" },
          { code: "fresh_flowers", price: 200_000, unit: "per_event" },
          { code: "delivery", price: 100_000, unit: "per_event" },
        ],
      },
      {
        type: "candy_bar",
        price: 60_000,
        unit: "per_guest",
        minQty: 50,
        options: [{ code: "decor", price: 500_000, unit: "per_event" }],
      },
      { type: "tasting", price: 150_000, unit: "per_event" },
    ],
  },
  {
    category: "cake",
    slug: "bento-box",
    name: "Bento Box",
    attributes: { cake_kinds: ["bento", "cupcakes"], delivery: true, tasting: false, lead_days: 1 },
    services: [
      { type: "bento", price: 220_000, unit: "per_item" },
      { type: "pastries", price: 120_000, unit: "per_kg", minQty: 2 },
    ],
  },
  {
    category: "cake",
    slug: "milliy-shirinlik",
    name: "Milliy Shirinlik",
    attributes: { cake_kinds: ["national"], delivery: false, lead_days: 3 },
    services: [
      { type: "pastries", price: 90_000, unit: "per_kg", minQty: 3 },
      { type: "wedding_cake", price: 150_000, unit: "per_kg", minQty: 5, leadDays: 7 },
    ],
  },
  // ── подарки: заказ за N дней, партия ──
  {
    category: "gifts",
    slug: "sovga-uyi",
    name: "Sovgʻa Uyi",
    attributes: {
      gift_kinds: ["bonbonniere", "couple", "souvenirs"],
      personalization: true,
      packaging: true,
      min_batch: 50,
      lead_days: 7,
      delivery: true,
    },
    services: [
      {
        type: "bonbonniere",
        price: 25_000,
        unit: "per_item",
        minQty: 50,
        options: [{ code: "name_print", price: 5_000, unit: "per_item" }],
      },
      { type: "couple_gift_set", price: 900_000, unit: "per_set" },
    ],
  },
  {
    category: "gifts",
    slug: "quda-sovgalari",
    name: "Quda Sovgʻalari",
    attributes: {
      gift_kinds: ["in_law"],
      personalization: false,
      packaging: true,
      min_batch: 1,
      lead_days: 10,
      delivery: true,
    },
    services: [
      {
        type: "in_law_gift_set",
        price: 1_500_000,
        unit: "per_set",
        options: [{ code: "special_packaging", price: 200_000, unit: "per_set" }],
      },
    ],
  },
  {
    category: "gifts",
    slug: "korporativ-gift",
    name: "Korporativ Gift",
    attributes: { gift_kinds: ["corporate"], personalization: true, min_batch: 20, lead_days: 14 },
    services: [
      {
        type: "corporate_gifts",
        price: 80_000,
        unit: "per_item",
        minQty: 20,
        options: [{ code: "logo", price: 10_000, unit: "per_item" }],
      },
    ],
  },
  // ── декор: части дня (утренний плов и вечерняя свадьба) ──
  {
    category: "decor",
    slug: "bezak-art",
    name: "Bezak Art",
    attributes: {
      styles: ["classic", "national"],
      flower_kinds: ["live", "artificial"],
      own_furniture: true,
      installation: true,
      service_area: "tashkent",
    },
    services: [
      {
        type: "stage_decor",
        price: 6_000_000,
        unit: "per_event",
        options: [
          { code: "flower_wall", price: 3_000_000, unit: "per_event" },
          { code: "lighting", price: 1_500_000, unit: "per_event" },
        ],
      },
      { type: "full_hall_package", price: 25_000_000, unit: "per_event" },
      { type: "table_decor", price: 350_000, unit: "per_table", minQty: 10 },
      { type: "morning_plov_decor", price: 3_000_000, unit: "per_event" },
    ],
    parallelCapacity: 2,
    parts: [[7, ["morning"]]],
  },
  {
    category: "decor",
    slug: "zamonaviy-dekor",
    name: "Zamonaviy Dekor",
    attributes: { styles: ["modern", "minimal"], flower_kinds: ["artificial"], installation: true },
    services: [
      { type: "entrance_arch", price: 2_500_000, unit: "per_item" },
      {
        type: "lighting_effects",
        price: 2_000_000,
        unit: "per_event",
        options: [
          { code: "smoke", price: 800_000, unit: "per_event" },
          { code: "confetti", price: 500_000, unit: "per_event" },
        ],
      },
    ],
    busy: [7],
  },
  {
    category: "decor",
    slug: "rustik-toy",
    name: "Rustik Toʻy",
    attributes: { styles: ["rustic"], flower_kinds: ["live"] },
    services: [
      { type: "stage_decor", price: 4_000_000, unit: "per_event" },
      { type: "table_decor", price: 250_000, unit: "per_table", minQty: 8 },
    ],
  },
  // ── ЗАГС: день в календаре, время церемонии — в заявке ──
  {
    category: "zags",
    slug: "visol-saroyi",
    name: "Visol saroyi",
    district: "mirzo_ulugbek",
    attributes: {
      zags_kind: "palace",
      ceremony_capacity: 80,
      document_help: true,
      foreign_citizens: true,
      ceremony_langs: ["uz", "ru"],
      parking: true,
      working_hours: "09:00–18:00",
    },
    services: [
      {
        type: "solemn_ceremony",
        price: 1_200_000,
        unit: "per_event",
        includes: {
          ru: "Зал на 80 гостей, музыка на входе, регистратор",
          uz: "80 mehmonlik zal, kirishda musiqa, roʻyxatga oluvchi",
        },
        options: [
          { code: "music", price: 800_000, unit: "per_event" },
          { code: "photographer", price: 1_000_000, unit: "per_event" },
          { code: "champagne", price: 150_000, unit: "per_item" },
        ],
      },
      { type: "simple_registration", price: 300_000, unit: "per_event" },
      { type: "documents_help", price: 400_000, unit: "per_event" },
    ],
    busy: [5, 12, 19],
  },
  {
    category: "zags",
    slug: "baxt-nikoh-uyi",
    name: "Baxt nikoh uyi",
    district: "chilonzor",
    attributes: {
      zags_kind: "registry",
      ceremony_capacity: 30,
      document_help: true,
      ceremony_langs: ["uz"],
      working_hours: "09:00–17:00",
    },
    services: [
      { type: "simple_registration", price: 250_000, unit: "per_event" },
      { type: "solemn_ceremony", price: 700_000, unit: "per_event" },
      { type: "date_appointment", price: 150_000, unit: "per_event" },
    ],
    busy: [3, 10],
  },
  {
    category: "zags",
    slug: "ikki-yurak",
    name: "Ikki yurak",
    district: "yunusobod",
    attributes: {
      zags_kind: "agency",
      offsite: true,
      document_help: true,
      foreign_citizens: true,
      ceremony_langs: ["uz", "ru", "en"],
    },
    services: [
      {
        type: "offsite_ceremony",
        price: 4_500_000,
        unit: "per_event",
        options: [
          { code: "arch", price: 1_500_000, unit: "per_item" },
          { code: "decor", price: 2_000_000, unit: "per_event" },
          { code: "music", price: 800_000, unit: "per_event" },
        ],
      },
      { type: "documents_help", price: 500_000, unit: "per_event" },
      { type: "foreign_registration", price: 1_500_000, unit: "per_event" },
    ],
    busy: [8],
  },
  // ── рестораны: части дня, несколько залов одновременно, вместимость ──
  {
    category: "restaurant",
    slug: "ipak-restoran",
    name: "Ipak restoran",
    district: "yakkasaroy",
    cap: [10, 120],
    attributes: {
      cuisine: ["national", "european", "oriental"],
      events: ["fotiha", "girls_party", "engagement", "birthday", "family"],
      private_rooms: 3,
      alcohol: "not_allowed",
      live_music: true,
      kids_room: true,
      parking: true,
      accessible: true,
    },
    services: [
      {
        type: "banquet_menu",
        price: 220_000,
        unit: "per_guest",
        minQty: 10,
        options: [
          { code: "extra_dish", price: 40_000, unit: "per_guest" },
          { code: "music", price: 1_500_000, unit: "per_event" },
        ],
      },
      { type: "fotiha_menu", price: 150_000, unit: "per_guest", minQty: 10 },
      { type: "girls_party", price: 180_000, unit: "per_guest", minQty: 10 },
      { type: "private_room", price: 300_000, unit: "per_hour", minQty: 2 },
    ],
    parallelCapacity: 3,
    busy: [14],
    parts: [
      [4, ["evening"]],
      [6, ["day"]],
    ],
  },
  {
    category: "restaurant",
    slug: "zarafshon-kafe",
    name: "Zarafshon kafe",
    district: "shayxontohur",
    cap: [8, 60],
    attributes: {
      cuisine: ["national"],
      events: ["fotiha", "girls_party", "family"],
      private_rooms: 2,
      alcohol: "not_allowed",
      parking: true,
    },
    services: [
      { type: "fotiha_menu", price: 120_000, unit: "per_guest", minQty: 8 },
      { type: "banquet_menu", price: 160_000, unit: "per_guest", minQty: 8 },
      { type: "kids_menu", price: 60_000, unit: "per_guest" },
    ],
    parallelCapacity: 2,
    busy: [9],
    parts: [[2, ["day"]]],
  },
  {
    category: "restaurant",
    slug: "osiyo-lounge",
    name: "Osiyo Lounge",
    district: "mirobod",
    cap: [20, 200],
    attributes: {
      cuisine: ["asian", "european", "mixed"],
      events: ["birthday", "corporate", "engagement"],
      alcohol: "allowed",
      live_music: true,
      accessible: true,
    },
    services: [
      {
        type: "banquet_menu",
        price: 320_000,
        unit: "per_guest",
        minQty: 20,
        options: [{ code: "cake", price: 900_000, unit: "per_event" }],
      },
      { type: "private_room", price: 2_000_000, unit: "per_event" },
    ],
    parts: [[11, ["evening"]]],
  },
  // ── свадебные наряды: календаря нет, срок заказа ──
  {
    category: "attire",
    slug: "kelin-salon",
    name: "Kelin salon",
    district: "chilonzor",
    attributes: {
      attire_for: ["bride", "groom"],
      deal_kinds: ["sale", "rent", "tailoring"],
      national_dress: true,
      alterations: true,
      fitting_room: true,
      size_range: "40–56",
      lead_days: 14,
      working_hours: "10:00–20:00",
    },
    services: [
      {
        type: "dress_rent",
        price: 2_500_000,
        unit: "per_item",
        includes: { ru: "Платье, чехол, химчистка после", uz: "Koʻylak, gʻilof, keyin kimyoviy tozalash" },
        options: [
          { code: "veil", price: 300_000, unit: "per_item" },
          { code: "alterations", price: 400_000, unit: "per_item" },
          { code: "shoes", price: 350_000, unit: "per_item" },
        ],
      },
      { type: "dress_sale", price: 9_000_000, unit: "per_item" },
      { type: "suit_rent", price: 1_200_000, unit: "per_set" },
      { type: "tailoring", price: 12_000_000, unit: "per_item", leadDays: 45 },
    ],
    videoLinks: ["https://www.instagram.com/reel/demoKelinSalon1/"],
  },
  {
    category: "attire",
    slug: "kuyov-style",
    name: "Kuyov Style",
    district: "yunusobod",
    attributes: {
      attire_for: ["groom", "family"],
      deal_kinds: ["sale", "rent"],
      alterations: true,
      fitting_room: true,
      size_range: "44–62",
      lead_days: 3,
    },
    services: [
      {
        type: "suit_rent",
        price: 900_000,
        unit: "per_set",
        options: [{ code: "shoes", price: 250_000, unit: "per_item" }],
      },
      {
        type: "suit_sale",
        price: 4_500_000,
        unit: "per_set",
        options: [{ code: "alterations", price: 300_000, unit: "per_item" }],
      },
      { type: "accessories", price: 200_000, unit: "per_item" },
    ],
  },
  {
    category: "attire",
    slug: "atlas-libos",
    name: "Atlas libos",
    district: "shayxontohur",
    attributes: {
      attire_for: ["bride", "family"],
      deal_kinds: ["rent", "tailoring"],
      national_dress: true,
      alterations: true,
      lead_days: 21,
    },
    services: [
      { type: "national_outfit", price: 1_800_000, unit: "per_item" },
      { type: "tailoring", price: 6_000_000, unit: "per_item", leadDays: 30 },
      { type: "accessories", price: 300_000, unit: "per_item" },
    ],
  },
  // ── кейтеринг: части дня, бригады одновременно ──
  {
    category: "food",
    slug: "dasturxon-katering",
    name: "Dasturxon katering",
    attributes: {
      cuisine: ["national", "european"],
      min_guests: 30,
      max_guests: 800,
      on_site_cooking: true,
      waiters: true,
      furniture: true,
      tasting: true,
      certificates: true,
      service_area: "tashkent_region",
    },
    services: [
      {
        type: "banquet_catering",
        price: 180_000,
        unit: "per_guest",
        minQty: 30,
        options: [
          { code: "waiters", price: 600_000, unit: "per_event" },
          { code: "furniture", price: 25_000, unit: "per_guest" },
        ],
      },
      {
        type: "morning_plov",
        price: 60_000,
        unit: "per_guest",
        minQty: 50,
        options: [{ code: "tent", price: 1_500_000, unit: "per_event" }],
      },
      { type: "fotiha_table", price: 120_000, unit: "per_guest", minQty: 20 },
    ],
    parallelCapacity: 2,
    busy: [16],
    parts: [
      [5, ["morning"]],
      [9, ["evening"]],
    ],
  },
  {
    category: "food",
    slug: "qozon-osh-markazi",
    name: "Qozon osh markazi",
    attributes: {
      cuisine: ["national"],
      min_guests: 50,
      max_guests: 2000,
      on_site_cooking: true,
      service_area: "tashkent",
    },
    services: [
      {
        type: "morning_plov",
        price: 45_000,
        unit: "per_guest",
        minQty: 100,
        includes: {
          ru: "Плов в казане на месте, лепёшки, салат",
          uz: "Joyida qozonda osh, non, salat",
        },
      },
      { type: "waiter_service", price: 400_000, unit: "per_event" },
    ],
    parallelCapacity: 3,
    parts: [
      [3, ["morning"]],
      [10, ["morning"]],
    ],
  },
  {
    category: "food",
    slug: "furshet-pro",
    name: "Furshet Pro",
    attributes: {
      cuisine: ["european", "mixed"],
      min_guests: 20,
      max_guests: 300,
      waiters: true,
      furniture: true,
      tasting: true,
      service_area: "tashkent",
    },
    services: [
      { type: "buffet", price: 140_000, unit: "per_guest", minQty: 20 },
      { type: "equipment_rent", price: 15_000, unit: "per_guest" },
      { type: "waiter_service", price: 150_000, unit: "per_hour", minQty: 4 },
    ],
    busy: [6, 13],
  },
];

const DESCRIPTION: Localized = {
  ru: "Демо-витрина для разработки: услуги, цены и занятость — как у настоящей.\nНастоящие описания приходят из API.",
  uz: "Ishlab chiqish uchun demo vitrina: xizmatlar, narxlar va bandlik — haqiqiysidek.\nHaqiqiy tavsiflar API dan keladi.",
};

/** Номер первой демо-витрины: id и телефоны не пересекаются с демо-залами (1…24) */
const FIRST = 101;

/** Демо-витрины категорий; занятость считается от today, чтобы календарь был живой */
export function demoVitrinas(today: string): DemoListing[] {
  return SPECS.map((spec, i) => {
    const n = FIRST + i;
    const id = demoUuid(1, n);
    const category = categoryConfig(spec.category);
    if (!category) throw new Error(`демо: нет категории ${spec.category}`);
    const services: PublicService[] = spec.services.map((s, k) => {
      const type = serviceType(category, s.type);
      if (!type) throw new Error(`демо: нет услуги ${spec.category}/${s.type}`);
      return {
        id: demoUuid(5, n * 10 + k),
        type: s.type,
        name: categoryTexts(type.label),
        priceUzs: s.price,
        priceUnit: s.unit,
        minQty: s.minQty ?? null,
        leadDays: s.leadDays ?? null,
        includes: s.includes ?? null,
        options: (s.options ?? []).map((o, j) => ({
          id: demoUuid(7, n * 100 + k * 10 + j),
          code: o.code,
          name: categoryTexts(`opt_${o.code}` as Parameters<typeof categoryTexts>[0]),
          priceUzs: o.price,
          priceUnit: o.unit,
        })),
      };
    });
    // Цена «от» — по услугам, входящим в неё; таких нет — по всем (как у сервера)
    const counted = services.filter((s) => serviceType(category, s.type)?.inPriceFrom);
    const from = [...(counted.length > 0 ? counted : services)].sort((a, b) => a.priceUzs - b.priceUzs)[0];
    if (!from) throw new Error(`демо: у ${spec.slug} нет услуг`);
    const photos = Array.from({ length: 3 + (i % 3) }, (_, k) => ({
      key: `listings/${id}/${demoUuid(2, n * 10 + k)}.webp`,
      width: 1600,
      height: 1067,
    }));
    const busyParts: BusyParts[] = (spec.parts ?? []).map(([offset, parts]) => ({
      date: addDays(today, offset),
      parts,
    }));
    return {
      id,
      slug: spec.slug,
      name: spec.name,
      categoryCode: spec.category,
      districtCode: spec.district ?? null,
      priceFromUzs: from.priceUzs,
      priceUnit: from.priceUnit,
      capMin: spec.cap?.[0] ?? null,
      capMax: spec.cap?.[1] ?? null,
      cover: photos[0] ?? null,
      photoCount: photos.length,
      busyOnDate: null,
      dateLoad: null,
      description: DESCRIPTION,
      address: { ru: `Ташкент, демо-адрес ${n}`, uz: `Toshkent, demo manzil ${n}` },
      attributes: spec.attributes,
      videoLinks: spec.videoLinks ?? [],
      services,
      parallelCapacity: spec.parallelCapacity ?? 1,
      photos,
      contactChannels: demoTelegram(spec.slug, n) ? ["phone", "telegram"] : ["phone"],
      phone: `+998000000${String(n).padStart(3, "0")}`,
      telegram: demoTelegram(spec.slug, n),
      busyDates: (spec.busy ?? []).map((offset) => addDays(today, offset)).sort(),
      busyParts: busyParts.sort((a, b) => a.date.localeCompare(b.date)),
    } satisfies DemoListing;
  });
}
