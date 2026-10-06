// Демо-витрины staging: вымышленные вендоры, у каждого — витрина в своей категории
// (три зала и по две в каждой другой включённой категории — каталог раздела не из одной
// карточки). Их заводит и убирает
// POST /ops/demo (routes/ops.ts), только на staging.
//
// Всё, что видит клиент, помечено: название начинается с «Демо-» и «Demo», описание —
// с предупреждения, что такой компании нет, адрес — «демо-адрес», телефон —
// +998 00 000 00 NN (кода оператора 00 нет). Людей нет: контакт — «Демо-контакт»,
// фото — абстрактные картинки со словом DEMO (их рисует workflow Demo data).
//
// Метка демо-строк — id из зарезервированного диапазона DEMO_ID_PREFIX: случайный
// UUID туда не попадает, а id вендора и карточки в панели не выбирают. По этому же
// диапазону app.demo_purge() (supabase/migrations/…_demo_purge.sql) находит, что
// убрать, — и ничего сверх этого.
//
// Поля витрины и услуги — по конфигурации категорий (@bayramm/shared/categories): тест
// venues.test.ts прогоняет их через те же проверки, что панель и кабинет.
//
// Узбекский — латиница: ʻ (U+02BB) после o/g, ʼ (U+02BC) — tutuq belgisi.

import type { DayPart, PriceUnit } from "@bayramm/shared/api";
import type { CategoryCode, ListingAttributes } from "@bayramm/shared/categories";

/** Начало id всех демо-строк; тот же литерал — в app.demo_purge() */
export const DEMO_ID_PREFIX = "00000000-0000-4000-8000-de";

/** Фото на витрину: минимум для публикации (правило продукта, у всех категорий — 3) */
export const DEMO_PHOTOS_PER_VENUE = 3;

/** Занятые дни ставятся в пределах стольких дней от сегодняшнего */
export const DEMO_BUSY_HORIZON_DAYS = 60;

/** Опция демо-услуги: код шаблона категории (opt_<код> — название), цена */
export interface DemoOption {
  readonly code: string;
  readonly priceUzs: number;
  readonly priceUnit: PriceUnit;
}

/** Демо-услуга: тип из каталога категории, цена и единица — из его допустимых */
export interface DemoService {
  readonly type: string;
  readonly priceUzs: number;
  readonly priceUnit: PriceUnit;
  readonly minQty?: number;
  readonly leadDays?: number;
  readonly includes?: { readonly ru: string; readonly uz: string };
  /** Название — только у «другой услуги» (other) */
  readonly name?: { readonly ru: string; readonly uz: string };
  readonly options?: readonly DemoOption[];
}

export interface DemoVenue {
  readonly vendorId: string;
  readonly listingId: string;
  /** Название вендора — только для панели */
  readonly vendorName: string;
  readonly legalName: string;
  readonly contractNo: string;
  /** Вымышленный СТИР: чек-лист панели отмечает «СТИР сверен», только когда он вписан */
  readonly stir: string;
  /** Телефон контакта и телефон для заявок — заведомо несуществующий номер */
  readonly phone: string;
  readonly category: CategoryCode;
  readonly slug: string;
  readonly name: string;
  readonly districtCode: string | null;
  readonly addressRu: string;
  readonly addressUz: string;
  readonly descriptionRu: string;
  readonly descriptionUz: string;
  /** Вместимость в гостях — у залов */
  readonly capMin: number | null;
  readonly capMax: number | null;
  /** Сколько заказов одновременно (режим parts) */
  readonly parallelCapacity: number;
  readonly attributes: ListingAttributes;
  readonly services: readonly DemoService[];
  /** Занятые дни — через столько дней от сегодняшнего (по Ташкенту) */
  readonly busyDays: readonly number[];
  /** Занятые части дня (режим parts): через столько дней, какая часть */
  readonly busyParts: readonly { readonly offset: number; readonly part: DayPart }[];
}

/** id в демо-диапазоне: 10 цифр номера после префикса */
const demoId = (n: number) => `${DEMO_ID_PREFIX}${String(n).padStart(10, "0")}`;

const HALL_DISCLAIMER_RU = "Демонстрационная карточка: такого зала нет, заявки уходят на тестовый стенд.";
const HALL_DISCLAIMER_UZ = "Namoyish kartochkasi: bunday zal yoʻq, soʻrovlar sinov muhitiga boradi.";
const DISCLAIMER_RU = "Демонстрационная карточка: такой компании нет, заявки уходят на тестовый стенд.";
const DISCLAIMER_UZ = "Namoyish kartochkasi: bunday kompaniya yoʻq, soʻrovlar sinov muhitiga boradi.";

const CONTACT = {
  person: "Демо-контакт",
  role: "Администратор (демо)",
  legalAddress: "Демо-адрес, не настоящий",
} as const;

/** Вендор и витрина под номером n: id, договор, СТИР и телефон — из него */
function base(n: number) {
  const nn = String(n).padStart(2, "0");
  return {
    vendorId: demoId(n),
    listingId: demoId(100 + n),
    contractNo: `DEMO-${n}`,
    stir: `0000000${nn}`,
    phone: `+9980000000${nn}`,
  };
}

const banquet = (
  type: "banquet_weekday" | "banquet_weekend",
  priceUzs: number,
  priceUnit: PriceUnit,
  includes?: DemoService["includes"],
): DemoService => ({
  type,
  priceUzs,
  priceUnit,
  ...(includes === undefined ? {} : { includes }),
});

/** Что входит в банкет залов «Анор» и «Чинор» — одно меню */
const BANQUET_MENU = {
  ru: "Закуски, салаты, два горячих, плов, фрукты, чай",
  uz: "Gazaklar, salatlar, ikki xil issiq taom, osh, mevalar, choy",
} as const;

export const DEMO_VENUES: readonly DemoVenue[] = [
  {
    ...base(1),
    vendorName: "Демо-вендор «Анор»",
    legalName: "Демо Анор (вымышленное юрлицо)",
    category: "hall",
    slug: "demo-zal-anor",
    name: "Демо-зал «Анор» · Demo zal «Anor»",
    districtCode: "yunusobod",
    addressRu: "Ташкент, Юнусабад — демо-адрес, не настоящий",
    addressUz: "Toshkent, Yunusobod — demo manzil, haqiqiy emas",
    descriptionRu: `${HALL_DISCLAIMER_RU}

Светлый банкетный зал на 60–300 гостей. Своя кухня — национальные и европейские блюда, плов готовят при гостях. Сцена и звук для ведущего и музыкантов, комната для невесты, парковка на 80 машин. Торт и фрукты можно принести свои — без доплаты.`,
    descriptionUz: `${HALL_DISCLAIMER_UZ}

60–300 mehmonga moʻljallangan yorugʻ banket zali. Oshxona oʻzimizniki — milliy va yevropa taomlari, osh mehmonlar oldida damlanadi. Boshlovchi va sozandalar uchun sahna va ovoz tizimi, kelin xonasi, 80 ta mashinaga avtoturargoh. Tort va mevalarni oʻzingiz olib kelishingiz mumkin — qoʻshimcha toʻlovsiz.`,
    capMin: 60,
    capMax: 300,
    parallelCapacity: 1,
    attributes: { halls_count: 1, parking_spaces: 80, kitchen: "own", stage: true, bride_room: true },
    services: [
      banquet("banquet_weekday", 180_000, "per_guest", BANQUET_MENU),
      banquet("banquet_weekend", 220_000, "per_guest", BANQUET_MENU),
    ],
    busyDays: [3, 10, 11, 24, 38, 52],
    busyParts: [],
  },
  {
    ...base(2),
    vendorName: "Демо-вендор «Чинор»",
    legalName: "Демо Чинор (вымышленное юрлицо)",
    category: "hall",
    slug: "demo-zal-chinor",
    name: "Демо-зал «Чинор» · Demo zal «Chinor»",
    districtCode: "chilonzor",
    addressRu: "Ташкент, Чиланзар — демо-адрес, не настоящий",
    addressUz: "Toshkent, Chilonzor — demo manzil, haqiqiy emas",
    descriptionRu: `${HALL_DISCLAIMER_RU}

Большой зал на 100–500 гостей для свадеб и утреннего плова. Два уровня, высокие потолки, много дневного света. Своя кухня и кондитер, живая музыка — по договорённости. Рядом метро, парковка во дворе.`,
    descriptionUz: `${HALL_DISCLAIMER_UZ}

Toʻy va nahorgi osh uchun 100–500 mehmonga moʻljallangan katta zal. Ikki qavat, baland shift, kunduzi yorugʻ. Oʻz oshxonamiz va qandolatchimiz bor, jonli musiqa — kelishuv asosida. Metro yaqin, hovlida avtoturargoh.`,
    capMin: 100,
    capMax: 500,
    parallelCapacity: 1,
    attributes: { halls_count: 2, parking_spaces: 120, kitchen: "own", air_conditioning: true },
    services: [
      banquet("banquet_weekday", 150_000, "per_guest", BANQUET_MENU),
      banquet("banquet_weekend", 190_000, "per_guest", BANQUET_MENU),
      {
        type: "morning_plov",
        priceUzs: 90_000,
        priceUnit: "per_guest",
        includes: {
          ru: "Плов, салаты, лепёшки, чай, сладости",
          uz: "Osh, salatlar, non, choy, shirinliklar",
        },
      },
    ],
    busyDays: [4, 5, 18, 19, 33, 47],
    busyParts: [],
  },
  {
    ...base(3),
    vendorName: "Демо-вендор «Гирих»",
    legalName: "Демо Гирих (вымышленное юрлицо)",
    category: "hall",
    slug: "demo-zal-girih",
    name: "Демо-зал «Гирих» · Demo zal «Girih»",
    districtCode: "mirzo_ulugbek",
    addressRu: "Ташкент, Мирзо-Улугбек — демо-адрес, не настоящий",
    addressUz: "Toshkent, Mirzo Ulugʻbek — demo manzil, haqiqiy emas",
    descriptionRu: `${HALL_DISCLAIMER_RU}

Камерный зал на 30–150 гостей: дни рождения, бешик-той, корпоративы. Цена — за мероприятие целиком: зал, обслуживание и оформление. На стенах — орнамент гирих, есть терраса и детская комната с няней.`,
    descriptionUz: `${HALL_DISCLAIMER_UZ}

Tugʻilgan kun, beshik toʻyi va korporativlar uchun 30–150 mehmonga moʻljallangan ixcham zal. Narx butun tadbir uchun: zal, xizmat koʻrsatish va bezak. Devorlarda girih naqshi, ayvon va enaga bilan bolalar xonasi bor.`,
    capMin: 30,
    capMax: 150,
    parallelCapacity: 1,
    attributes: { halls_count: 1, kitchen: "both", accessible: true },
    services: [
      banquet("banquet_weekday", 18_000_000, "per_event", {
        ru: "Зал, обслуживание, оформление и меню на 30 гостей",
        uz: "Zal, xizmat koʻrsatish, bezak va 30 mehmonga menyu",
      }),
      banquet("banquet_weekend", 24_000_000, "per_event", {
        ru: "Зал, обслуживание, оформление и меню на 30 гостей",
        uz: "Zal, xizmat koʻrsatish, bezak va 30 mehmonga menyu",
      }),
    ],
    busyDays: [6, 13, 20, 27, 41, 55],
    busyParts: [],
  },
  {
    ...base(4),
    vendorName: "Демо-вендор «Шарк»",
    legalName: "Демо Шарк (вымышленное юрлицо)",
    category: "car",
    slug: "demo-kortej-sharq",
    name: "Демо-кортеж «Шарк» · Demo kortej «Sharq»",
    districtCode: "yashnobod",
    addressRu: "Ташкент, Яшнабад — демо-адрес, не настоящий",
    addressUz: "Toshkent, Yashnobod — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Машины для молодожёнов и кортежи: премиум-седаны, лимузин, минивэны для гостей. Водитель, топливо и простое украшение лентами — в цене. Подаём машину к ЗАГСу, на фотосессию и к залу.`,
    descriptionUz: `${DISCLAIMER_UZ}

Kelin-kuyov mashinalari va kortejlar: premium sedanlar, limuzin, mehmonlar uchun minivenlar. Haydovchi, yoqilgʻi va lentali oddiy bezak narxga kiradi. Mashinani FHDYo, fotosessiya va toʻyxonaga yetkazamiz.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 3,
    attributes: {
      fleet: [
        { model: "Mercedes-Benz S-Class", class: "premium", color: "black", seats: 4, year: 2021 },
        { model: "Chevrolet Malibu", class: "sedan", color: "white", seats: 4, year: 2023 },
        { model: "Lincoln Town Car", class: "limousine", color: "white", seats: 8, year: 2015 },
      ],
      decoration: true,
      service_area: "tashkent",
      min_order_hours: 3,
    },
    services: [
      {
        type: "bride_car",
        priceUzs: 350_000,
        priceUnit: "per_hour",
        minQty: 3,
        includes: { ru: "Водитель, топливо, ленты на капот", uz: "Haydovchi, yoqilgʻi, kapotdagi lentalar" },
        options: [
          { code: "flower_decor", priceUzs: 300_000, priceUnit: "per_event" },
          { code: "extra_hour", priceUzs: 350_000, priceUnit: "per_hour" },
        ],
      },
      { type: "motorcade", priceUzs: 250_000, priceUnit: "per_hour", minQty: 3 },
      { type: "limousine", priceUzs: 600_000, priceUnit: "per_hour", minQty: 2 },
      { type: "car_decor", priceUzs: 150_000, priceUnit: "per_item" },
    ],
    busyDays: [9, 30],
    busyParts: [
      { offset: 5, part: "evening" },
      { offset: 12, part: "morning" },
      { offset: 12, part: "evening" },
    ],
  },
  {
    ...base(5),
    vendorName: "Демо-вендор «Нур»",
    legalName: "Демо Нур (вымышленное юрлицо)",
    category: "studio",
    slug: "demo-studiya-nur",
    name: "Демо-студия «Нур» · Demo studiya «Nur»",
    districtCode: "mirobod",
    addressRu: "Ташкент, Мирабад — демо-адрес, не настоящий",
    addressUz: "Toshkent, Mirobod — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Фотостудия 180 м² с четырьмя зонами: белый зал, большое окно, интерьер и циклорама. Свет, фоны и реквизит — в аренде, гримёрная и комната для переодевания рядом.`,
    descriptionUz: `${DISCLAIMER_UZ}

Toʻrt zonali 180 m² fotostudiya: oq zal, katta deraza, interyer va siklorama. Yoritish, fonlar va rekvizit ijaraga kiradi, grim va kiyim almashtirish xonalari yonida.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 1,
    attributes: {
      area_m2: 180,
      zones_count: 4,
      zones: { ru: "Белый зал, окно, интерьер, циклорама", uz: "Oq zal, deraza, interyer, siklorama" },
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
        priceUzs: 250_000,
        priceUnit: "per_hour",
        minQty: 1,
        options: [{ code: "extra_zone", priceUzs: 100_000, priceUnit: "per_hour" }],
      },
      { type: "love_story_package", priceUzs: 2_500_000, priceUnit: "per_event" },
      { type: "family_shoot", priceUzs: 1_800_000, priceUnit: "per_event" },
    ],
    busyDays: [2, 8, 15, 29],
    busyParts: [],
  },
  {
    ...base(6),
    vendorName: "Демо-вендор «Лола»",
    legalName: "Демо Лола (вымышленное юрлицо)",
    category: "flowers",
    slug: "demo-gullar-lola",
    name: "Демо-цветы «Лола» · Demo gullar «Lola»",
    districtCode: "chilonzor",
    addressRu: "Ташкент, Чиланзар — демо-адрес, не настоящий",
    addressUz: "Toshkent, Chilonzor — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Букеты невесты, бутоньерки, цветы на машину и композиции на столы из живых цветов. Заказ — не позже чем за два дня, доставка по Ташкенту или самовывоз.`,
    descriptionUz: `${DISCLAIMER_UZ}

Kelin guldastalari, butonyerkalar, mashina uchun gullar va jonli gullardan stol kompozitsiyalari. Buyurtma — kamida ikki kun oldin, Toshkent boʻylab yetkazib berish yoki olib ketish.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 1,
    attributes: {
      flower_kinds: ["live"],
      delivery: true,
      pickup: true,
      lead_days: 2,
      working_hours: "09:00–21:00",
    },
    services: [
      {
        type: "bridal_bouquet",
        priceUzs: 450_000,
        priceUnit: "per_item",
        options: [{ code: "toss_bouquet", priceUzs: 200_000, priceUnit: "per_item" }],
      },
      { type: "boutonniere", priceUzs: 60_000, priceUnit: "per_item" },
      { type: "car_flower_decor", priceUzs: 700_000, priceUnit: "per_set" },
      { type: "table_compositions", priceUzs: 250_000, priceUnit: "per_table", minQty: 5 },
    ],
    busyDays: [],
    busyParts: [],
  },
  {
    ...base(7),
    vendorName: "Демо-вендор «Кадр»",
    legalName: "Демо Кадр (вымышленное юрлицо)",
    category: "photo",
    slug: "demo-foto-kadr",
    name: "Демо-съёмка «Кадр» · Demo suratga olish «Kadr»",
    districtCode: null,
    addressRu: "Ташкент — демо-адрес, не настоящий",
    addressUz: "Toshkent — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Фото и видео свадьбы: две команды, дрон, стабилизатор. Утром снимаем утренний плов, днём — ЗАГС и прогулку, вечером — зал. Готовые фото — через 30 дней, клип — в тот же вечер по заказу.`,
    descriptionUz: `${DISCLAIMER_UZ}

Toʻy foto va videosi: ikki jamoa, dron, stabilizator. Ertalab nahorgi osh, kunduzi FHDYo va sayr, kechqurun toʻyxona. Tayyor suratlar — 30 kunda, klip — buyurtma boʻyicha shu kechaning oʻzida.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 2,
    attributes: {
      team: ["photographer", "videographer", "drone_operator"],
      equipment: ["camera", "drone", "stabilizer"],
      delivery_days: 30,
      styles: ["reportage", "cinematic"],
      service_area: "tashkent",
    },
    services: [
      {
        type: "photo_shoot",
        priceUzs: 400_000,
        priceUnit: "per_hour",
        minQty: 4,
        options: [
          { code: "extra_hour", priceUzs: 400_000, priceUnit: "per_hour" },
          { code: "second_photographer", priceUzs: 1_500_000, priceUnit: "per_event" },
        ],
      },
      { type: "videography", priceUzs: 6_000_000, priceUnit: "per_event" },
      { type: "drone", priceUzs: 1_200_000, priceUnit: "per_event" },
      { type: "same_day_edit", priceUzs: 2_000_000, priceUnit: "per_event" },
    ],
    busyDays: [21],
    busyParts: [
      { offset: 7, part: "morning" },
      { offset: 7, part: "evening" },
      { offset: 14, part: "day" },
    ],
  },
  {
    ...base(8),
    vendorName: "Демо-вендор «Ширин»",
    legalName: "Демо Ширин (вымышленное юрлицо)",
    category: "cake",
    slug: "demo-tort-shirin",
    name: "Демо-кондитерская «Ширин» · Demo qandolatxona «Shirin»",
    districtCode: "shayxontohur",
    addressRu: "Ташкент, Шайхантахур — демо-адрес, не настоящий",
    addressUz: "Toshkent, Shayxontohur — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Свадебные и многоярусные торты, капкейки и кэнди-бар. Мастика, крем, живые цветы. Дегустация по записи, заказ — не позже чем за пять дней.`,
    descriptionUz: `${DISCLAIMER_UZ}

Toʻy va koʻp qavatli tortlar, keks va shirinlik stoli. Mastika, krem, jonli gullar. Degustatsiya — oldindan yozilib, buyurtma — kamida besh kun oldin.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 1,
    attributes: {
      cake_kinds: ["wedding", "tiered", "cupcakes"],
      fillings: ["chocolate", "berry", "nut"],
      cake_decor: ["fondant", "cream", "fresh_flowers"],
      delivery: true,
      tasting: true,
      lead_days: 5,
      min_weight_kg: 3,
      certificates: true,
    },
    services: [
      {
        type: "wedding_cake",
        priceUzs: 180_000,
        priceUnit: "per_kg",
        minQty: 3,
        options: [
          { code: "tier", priceUzs: 300_000, priceUnit: "per_item" },
          { code: "delivery", priceUzs: 100_000, priceUnit: "per_event" },
        ],
      },
      { type: "candy_bar", priceUzs: 35_000, priceUnit: "per_guest" },
      { type: "tasting", priceUzs: 100_000, priceUnit: "per_event" },
    ],
    busyDays: [],
    busyParts: [],
  },
  {
    ...base(9),
    vendorName: "Демо-вендор «Тухфа»",
    legalName: "Демо Тухфа (вымышленное юрлицо)",
    category: "gifts",
    slug: "demo-sovga-tuhfa",
    name: "Демо-подарки «Тухфа» · Demo sovgʻalar «Tuhfa»",
    districtCode: "olmazor",
    addressRu: "Ташкент, Алмазар — демо-адрес, не настоящий",
    addressUz: "Toshkent, Olmazor — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Бонбоньерки для гостей, подарки сватам и наборы для молодожёнов. Имена и дату печатаем на упаковке. Партия — от 50 штук, заказ — не позже чем за неделю.`,
    descriptionUz: `${DISCLAIMER_UZ}

Mehmonlar uchun bonbonyerkalar, quda sovgʻalari va kelin-kuyov toʻplamlari. Qadoqqa ismlar va sanani bosamiz. Partiya — 50 donadan, buyurtma — kamida bir hafta oldin.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 1,
    attributes: {
      gift_kinds: ["bonbonniere", "in_law", "couple"],
      personalization: true,
      packaging: true,
      min_batch: 50,
      lead_days: 7,
      delivery: true,
    },
    services: [
      {
        type: "bonbonniere",
        priceUzs: 25_000,
        priceUnit: "per_item",
        minQty: 50,
        options: [{ code: "name_print", priceUzs: 5_000, priceUnit: "per_item" }],
      },
      { type: "in_law_gift_set", priceUzs: 1_500_000, priceUnit: "per_set" },
      { type: "couple_gift_set", priceUzs: 900_000, priceUnit: "per_set" },
    ],
    busyDays: [],
    busyParts: [],
  },
  {
    ...base(10),
    vendorName: "Демо-вендор «Безак»",
    legalName: "Демо Безак (вымышленное юрлицо)",
    category: "decor",
    slug: "demo-dekor-bezak",
    name: "Демо-декор «Безак» · Demo dekor «Bezak»",
    districtCode: "sergeli",
    addressRu: "Ташкент, Сергели — демо-адрес, не настоящий",
    addressUz: "Toshkent, Sergeli — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Оформление тора, входа, столов и фотозоны: классика, национальный стиль, современный. Своя мебель и реквизит, монтаж и демонтаж — наши. Две бригады: утренний плов и вечерняя свадьба в один день.`,
    descriptionUz: `${DISCLAIMER_UZ}

Toʻr, kirish, stollar va fotozonani bezash: klassik, milliy va zamonaviy uslubda. Mebel va rekvizit oʻzimizniki, montaj va demontaj — bizda. Ikki brigada: bir kunda nahorgi osh va kechki toʻy.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 2,
    attributes: {
      styles: ["classic", "national", "modern"],
      flower_kinds: ["live", "artificial"],
      own_furniture: true,
      installation: true,
      service_area: "tashkent",
    },
    services: [
      {
        type: "stage_decor",
        priceUzs: 3_500_000,
        priceUnit: "per_event",
        options: [
          { code: "flower_wall", priceUzs: 2_000_000, priceUnit: "per_event" },
          { code: "lighting", priceUzs: 800_000, priceUnit: "per_event" },
        ],
      },
      { type: "full_hall_package", priceUzs: 12_000_000, priceUnit: "per_event" },
      { type: "table_decor", priceUzs: 150_000, priceUnit: "per_table", minQty: 10 },
    ],
    busyDays: [16],
    busyParts: [
      { offset: 6, part: "morning" },
      { offset: 20, part: "evening" },
    ],
  },
  {
    ...base(11),
    vendorName: "Демо-вендор «Дастурхон»",
    legalName: "Демо Дастурхон (вымышленное юрлицо)",
    category: "food",
    slug: "demo-katering-dasturxon",
    name: "Демо-кейтеринг «Дастурхон» · Demo katering «Dasturxon»",
    districtCode: "olmazor",
    addressRu: "Ташкент, Алмазар — демо-адрес, не настоящий",
    addressUz: "Toshkent, Olmazor — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Утренний плов в казане на месте, банкет и фуршет у вас дома, во дворе или в офисе. Официанты, столы, стулья и посуда — наши. Две бригады: утренний плов и вечерний банкет в один день.`,
    descriptionUz: `${DISCLAIMER_UZ}

Nahorgi osh qozonda joyida, uyingizda, hovlida yoki ofisda banket va furshet. Ofitsiantlar, stol, stul va idish-tovoq — bizdan. Ikki brigada: bir kunda nahorgi osh va kechki banket.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 2,
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
        priceUzs: 180_000,
        priceUnit: "per_guest",
        minQty: 30,
        options: [
          { code: "waiters", priceUzs: 600_000, priceUnit: "per_event" },
          { code: "furniture", priceUzs: 25_000, priceUnit: "per_guest" },
        ],
      },
      {
        type: "morning_plov",
        priceUzs: 60_000,
        priceUnit: "per_guest",
        minQty: 50,
        options: [{ code: "tent", priceUzs: 1_500_000, priceUnit: "per_event" }],
      },
      { type: "fotiha_table", priceUzs: 120_000, priceUnit: "per_guest", minQty: 20 },
    ],
    busyDays: [12],
    busyParts: [
      { offset: 5, part: "morning" },
      { offset: 9, part: "evening" },
    ],
  },
  {
    ...base(12),
    vendorName: "Демо-вендор «Ипак»",
    legalName: "Демо Ипак (вымышленное юрлицо)",
    category: "restaurant",
    slug: "demo-restoran-ipak",
    name: "Демо-ресторан «Ипак» · Demo restoran «Ipak»",
    districtCode: "yakkasaroy",
    addressRu: "Ташкент, Яккасарай — демо-адрес, не настоящий",
    addressUz: "Toshkent, Yakkasaroy — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Ресторан для фотихи, девичника и семейных праздников: общий зал на 120 гостей и три отдельных зала. Национальная, европейская и восточная кухня, живая музыка по вечерам, детская комната.`,
    descriptionUz: `${DISCLAIMER_UZ}

Fotiha, qiz bazmi va oilaviy bayramlar uchun restoran: 120 mehmonlik umumiy zal va uchta alohida zal. Milliy, Yevropa va Sharq taomlari, kechqurun jonli musiqa, bolalar xonasi.`,
    capMin: 10,
    capMax: 120,
    parallelCapacity: 3,
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
        priceUzs: 220_000,
        priceUnit: "per_guest",
        minQty: 10,
        options: [
          { code: "extra_dish", priceUzs: 40_000, priceUnit: "per_guest" },
          { code: "music", priceUzs: 1_500_000, priceUnit: "per_event" },
        ],
      },
      { type: "fotiha_menu", priceUzs: 150_000, priceUnit: "per_guest", minQty: 10 },
      { type: "girls_party", priceUzs: 180_000, priceUnit: "per_guest", minQty: 10 },
      { type: "private_room", priceUzs: 300_000, priceUnit: "per_hour", minQty: 2 },
    ],
    busyDays: [7, 21],
    busyParts: [
      { offset: 3, part: "day" },
      { offset: 10, part: "evening" },
    ],
  },
  {
    ...base(13),
    vendorName: "Демо-вендор «Келин»",
    legalName: "Демо Келин (вымышленное юрлицо)",
    category: "attire",
    slug: "demo-libos-kelin",
    name: "Демо-салон «Келин» · Demo salon «Kelin»",
    districtCode: "chilonzor",
    addressRu: "Ташкент, Чиланзар — демо-адрес, не настоящий",
    addressUz: "Toshkent, Chilonzor — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Свадебные платья и костюмы жениха — продажа, прокат и пошив, национальные наряды для келин салом. Примерочная и подгонка по фигуре в салоне, размеры 40–56.`,
    descriptionUz: `${DISCLAIMER_UZ}

Kelinlik koʻylaklari va kuyov kostyumlari — sotuv, ijara va tikish, kelin salom uchun milliy liboslar. Salonda kiyib koʻrish xonasi va qomatga moslash, oʻlchamlar 40–56.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 1,
    attributes: {
      attire_for: ["bride", "groom"],
      deal_kinds: ["sale", "rent", "tailoring"],
      national_dress: true,
      alterations: true,
      fitting_room: true,
      delivery: false,
      size_range: "40–56",
      lead_days: 14,
      working_hours: "10:00–20:00",
    },
    services: [
      {
        type: "dress_rent",
        priceUzs: 2_500_000,
        priceUnit: "per_item",
        options: [
          { code: "veil", priceUzs: 300_000, priceUnit: "per_item" },
          { code: "alterations", priceUzs: 400_000, priceUnit: "per_item" },
        ],
      },
      { type: "dress_sale", priceUzs: 9_000_000, priceUnit: "per_item" },
      { type: "suit_rent", priceUzs: 1_200_000, priceUnit: "per_set" },
      { type: "national_outfit", priceUzs: 1_800_000, priceUnit: "per_item" },
      { type: "tailoring", priceUzs: 12_000_000, priceUnit: "per_item", leadDays: 45 },
    ],
    busyDays: [],
    busyParts: [],
  },
  {
    ...base(14),
    vendorName: "Демо-вендор «Висол»",
    legalName: "Демо Висол (вымышленное юрлицо)",
    category: "zags",
    slug: "demo-fhdyo-visol",
    name: "Демо-ЗАГС «Висол» · Demo FHDYo «Visol»",
    districtCode: "mirzo_ulugbek",
    addressRu: "Ташкент, Мирзо-Улугбек — демо-адрес, не настоящий",
    addressUz: "Toshkent, Mirzo Ulugʻbek — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Торжественная регистрация брака в зале на 60 гостей и выездные церемонии. Поможем с документами и записью на дату, регистрируем и с иностранными гражданами. Церемония — на узбекском или русском.`,
    descriptionUz: `${DISCLAIMER_UZ}

60 mehmonlik zalda tantanali nikoh marosimi va koʻchma marosimlar. Hujjatlar va sanaga yozdirishda yordam beramiz, chet el fuqarolari bilan ham nikohdan oʻtkazamiz. Marosim — oʻzbek yoki rus tilida.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 1,
    attributes: {
      zags_kind: "palace",
      ceremony_capacity: 60,
      offsite: true,
      document_help: true,
      foreign_citizens: true,
      ceremony_langs: ["uz", "ru"],
      parking: true,
      working_hours: "09:00–18:00",
    },
    services: [
      {
        type: "solemn_ceremony",
        priceUzs: 1_200_000,
        priceUnit: "per_event",
        options: [
          { code: "music", priceUzs: 800_000, priceUnit: "per_event" },
          { code: "photographer", priceUzs: 1_000_000, priceUnit: "per_event" },
        ],
      },
      { type: "simple_registration", priceUzs: 300_000, priceUnit: "per_event" },
      {
        type: "offsite_ceremony",
        priceUzs: 4_500_000,
        priceUnit: "per_event",
        options: [{ code: "arch", priceUzs: 1_500_000, priceUnit: "per_item" }],
      },
      { type: "documents_help", priceUzs: 400_000, priceUnit: "per_event" },
    ],
    busyDays: [4, 11, 18],
    busyParts: [],
  },
  // ── вторые витрины категорий: другой район, цена и набор услуг ──────────────
  {
    ...base(15),
    vendorName: "Демо-вендор «Бахт»",
    legalName: "Демо Бахт (вымышленное юрлицо)",
    category: "zags",
    slug: "demo-fhdyo-baxt",
    name: "Демо-ЗАГС «Бахт» · Demo FHDYo «Baxt»",
    districtCode: "yunusobod",
    addressRu: "Ташкент, Юнусабад — демо-адрес, не настоящий",
    addressUz: "Toshkent, Yunusobod — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Уютный зал регистрации на 30 гостей: простая и торжественная регистрация, запись на удобную дату и помощь с документами. Для гостей — комната ожидания, у входа — место для фото. Церемония — на узбекском, русском или английском.`,
    descriptionUz: `${DISCLAIMER_UZ}

30 mehmonlik shinam nikoh zali: oddiy va tantanali roʻyxatdan oʻtkazish, qulay sanaga yozdirish va hujjatlarga yordam. Mehmonlar uchun kutish xonasi, kirish oldida suratga tushish joyi bor. Marosim — oʻzbek, rus yoki ingliz tilida.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 1,
    attributes: {
      zags_kind: "registry",
      ceremony_capacity: 30,
      document_help: true,
      foreign_citizens: true,
      ceremony_langs: ["uz", "ru", "en"],
      working_hours: "09:00–17:00",
    },
    services: [
      {
        type: "solemn_ceremony",
        priceUzs: 800_000,
        priceUnit: "per_event",
        includes: { ru: "Зал на 30 гостей, музыка, поздравление", uz: "30 mehmonlik zal, musiqa, tabrik" },
        options: [{ code: "photographer", priceUzs: 700_000, priceUnit: "per_event" }],
      },
      {
        type: "simple_registration",
        priceUzs: 250_000,
        priceUnit: "per_event",
        includes: { ru: "Регистрация и свидетельство", uz: "Roʻyxatdan oʻtkazish va guvohnoma" },
      },
      { type: "date_appointment", priceUzs: 150_000, priceUnit: "per_event" },
      { type: "documents_help", priceUzs: 300_000, priceUnit: "per_event" },
      {
        type: "foreign_registration",
        priceUzs: 1_500_000,
        priceUnit: "per_event",
        includes: {
          ru: "Перевод документов и переводчик на церемонии",
          uz: "Hujjatlar tarjimasi va marosimda tarjimon",
        },
      },
    ],
    busyDays: [2, 9, 16, 23, 30],
    busyParts: [],
  },
  {
    ...base(16),
    vendorName: "Демо-вендор «Ретро»",
    legalName: "Демо Ретро (вымышленное юрлицо)",
    category: "car",
    slug: "demo-kortej-retro",
    name: "Демо-кортеж «Ретро» · Demo kortej «Retro»",
    districtCode: "uchtepa",
    addressRu: "Ташкент, Учтепа — демо-адрес, не настоящий",
    addressUz: "Toshkent, Uchtepa — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Ретро-автомобили и внедорожники для свадебной прогулки, минивэн для гостей. Машины украшаем живыми цветами, по пути — остановки для фото в любимых местах Ташкента. Работаем и по области.`,
    descriptionUz: `${DISCLAIMER_UZ}

Toʻy sayri uchun retro avtomobillar va yoʻltanlamaslar, mehmonlar uchun miniven. Mashinalarni jonli gullar bilan bezaymiz, yoʻl-yoʻlakay Toshkentning sevimli joylarida suratga tushish uchun toʻxtaymiz. Viloyat boʻylab ham ishlaymiz.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 3,
    attributes: {
      fleet: [
        { model: "GAZ-21 Volga", class: "retro", color: "white", seats: 4, year: 1962 },
        { model: "Cadillac Escalade", class: "suv", color: "black", seats: 7, year: 2022 },
        { model: "Mercedes-Benz Sprinter", class: "minivan", color: "silver", seats: 16, year: 2020 },
      ],
      decoration: true,
      service_area: "tashkent_region",
      min_order_hours: 2,
    },
    services: [
      {
        type: "retro_car",
        priceUzs: 500_000,
        priceUnit: "per_hour",
        minQty: 2,
        includes: {
          ru: "Водитель, ленты и бант, остановки для фото",
          uz: "Haydovchi, lenta va bant, suratga tushish uchun toʻxtashlar",
        },
        options: [{ code: "photo_stops", priceUzs: 200_000, priceUnit: "per_event" }],
      },
      {
        type: "motorcade",
        priceUzs: 300_000,
        priceUnit: "per_hour",
        minQty: 3,
        options: [{ code: "coordinator", priceUzs: 400_000, priceUnit: "per_event" }],
      },
      { type: "guest_transfer", priceUzs: 250_000, priceUnit: "per_hour", minQty: 3 },
      {
        type: "car_decor",
        priceUzs: 200_000,
        priceUnit: "per_item",
        options: [{ code: "fresh_flowers", priceUzs: 250_000, priceUnit: "per_item" }],
      },
    ],
    busyDays: [13],
    busyParts: [
      { offset: 4, part: "day" },
      { offset: 11, part: "evening" },
      { offset: 25, part: "morning" },
    ],
  },
  {
    ...base(17),
    vendorName: "Демо-вендор «Лахза»",
    legalName: "Демо Лахза (вымышленное юрлицо)",
    category: "photo",
    slug: "demo-foto-lahza",
    name: "Демо-съёмка «Лахза» · Demo suratga olish «Lahza»",
    districtCode: "yakkasaroy",
    addressRu: "Ташкент, Яккасарай — демо-адрес, не настоящий",
    addressUz: "Toshkent, Yakkasaroy — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Свадебная фото- и видеосъёмка в стиле fine art: мягкий свет, спокойные цвета, живые моменты без постановки. Фотокнига ручной работы, love story в студии или на природе. Выезжаем по всему Узбекистану.`,
    descriptionUz: `${DISCLAIMER_UZ}

Fine art uslubida toʻy foto va videosi: yumshoq yorugʻlik, sokin ranglar, sahnalashtirilmagan jonli lahzalar. Qoʻlda yasalgan fotokitob, studiyada yoki tabiat qoʻynida love story. Butun Oʻzbekiston boʻylab chiqamiz.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 1,
    attributes: {
      team: ["photographer", "videographer"],
      equipment: ["camera", "stabilizer", "lighting"],
      delivery_days: 21,
      styles: ["fine_art", "classic"],
      service_area: "uzbekistan",
    },
    services: [
      {
        type: "photo_shoot",
        priceUzs: 5_500_000,
        priceUnit: "per_event",
        includes: {
          ru: "Весь день съёмки, от 500 фото в обработке",
          uz: "Kun boʻyi suratga olish, 500 tadan ortiq ishlangan surat",
        },
        options: [
          { code: "photobook", priceUzs: 900_000, priceUnit: "per_item" },
          { code: "second_photographer", priceUzs: 1_200_000, priceUnit: "per_event" },
        ],
      },
      {
        type: "videography",
        priceUzs: 7_000_000,
        priceUnit: "per_event",
        options: [{ code: "second_camera", priceUzs: 1_500_000, priceUnit: "per_event" }],
      },
      {
        type: "love_story",
        priceUzs: 2_000_000,
        priceUnit: "per_event",
        options: [{ code: "studio_rent", priceUzs: 250_000, priceUnit: "per_hour" }],
      },
      { type: "morning_plov_shoot", priceUzs: 350_000, priceUnit: "per_hour", minQty: 2 },
      { type: "photobook", priceUzs: 900_000, priceUnit: "per_item" },
    ],
    busyDays: [17, 31],
    busyParts: [
      { offset: 3, part: "morning" },
      { offset: 8, part: "evening" },
      { offset: 22, part: "day" },
    ],
  },
  {
    ...base(18),
    vendorName: "Демо-вендор «Marry me»",
    legalName: "Демо Marry me (вымышленное юрлицо)",
    category: "studio",
    slug: "demo-studiya-marry-me",
    name: "Демо-студия «Marry me» · Demo studiya «Marry me»",
    districtCode: "yunusobod",
    addressRu: "Ташкент, Юнусабад — демо-адрес, не настоящий",
    addressUz: "Toshkent, Yunusobod — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Студия для love story и предсвадебных фотосессий: шесть зон — цветочная арка, белая спальня, зеркальный зал, восточный дворик, циклорама и балкон с закатным светом. Свет, дым-машина и реквизит — в аренде, визажист — по записи.`,
    descriptionUz: `${DISCLAIMER_UZ}

Love story va toʻydan oldingi fotosessiyalar uchun studiya: oltita zona — gul arkasi, oq yotoqxona, oynali zal, sharqona hovli, siklorama va quyosh botishi nuri tushadigan balkon. Yoritish, tutun mashinasi va rekvizit ijaraga kiradi, vizajist — oldindan yozilib.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 1,
    attributes: {
      area_m2: 240,
      zones_count: 6,
      zones: {
        ru: "Цветочная арка, белая спальня, зеркальный зал, восточный дворик, циклорама, балкон",
        uz: "Gul arkasi, oq yotoqxona, oynali zal, sharqona hovli, siklorama, balkon",
      },
      natural_light: true,
      props: true,
      makeup_room: true,
      dressing_room: true,
      max_people: 20,
      parking: true,
    },
    services: [
      {
        type: "studio_rent",
        priceUzs: 300_000,
        priceUnit: "per_hour",
        minQty: 1,
        options: [
          { code: "extra_hour", priceUzs: 300_000, priceUnit: "per_hour" },
          { code: "extra_zone", priceUzs: 120_000, priceUnit: "per_hour" },
        ],
      },
      {
        type: "love_story_package",
        priceUzs: 3_200_000,
        priceUnit: "per_event",
        includes: {
          ru: "3 часа студии, фотограф, 60 фото в обработке",
          uz: "3 soat studiya, fotograf, 60 ta ishlangan surat",
        },
        options: [
          { code: "makeup", priceUzs: 500_000, priceUnit: "per_event" },
          { code: "outfit_rent", priceUzs: 400_000, priceUnit: "per_event" },
        ],
      },
      { type: "pre_wedding_shoot", priceUzs: 2_800_000, priceUnit: "per_event" },
      { type: "makeup_hair", priceUzs: 700_000, priceUnit: "per_event" },
    ],
    busyDays: [1, 5, 12, 19, 26],
    busyParts: [],
  },
  {
    ...base(19),
    vendorName: "Демо-вендор «Бахор»",
    legalName: "Демо Бахор (вымышленное юрлицо)",
    category: "restaurant",
    slug: "demo-restoran-bahor",
    name: "Демо-ресторан «Бахор» · Demo restoran «Bahor»",
    districtCode: "mirobod",
    addressRu: "Ташкент, Мирабад — демо-адрес, не настоящий",
    addressUz: "Toshkent, Mirobod — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Ресторан с летней террасой и двумя банкетными залами: помолвка, день рождения, семейный ужин, корпоратив. Национальная, восточная и азиатская кухня, свой кондитер. Детское меню, напитки можно принести свои.`,
    descriptionUz: `${DISCLAIMER_UZ}

Yozgi ayvonli va ikkita banket zalli restoran: unashtiruv, tugʻilgan kun, oilaviy kechki ovqat, korporativ. Milliy, sharq va osiyo taomlari, oʻz qandolatchimiz bor. Bolalar menyusi, ichimliklarni oʻzingiz olib kelishingiz mumkin.`,
    capMin: 20,
    capMax: 200,
    parallelCapacity: 2,
    attributes: {
      cuisine: ["national", "oriental", "asian"],
      events: ["engagement", "birthday", "family", "corporate", "fotiha"],
      private_rooms: 2,
      alcohol: "bring_own",
      parking: true,
      accessible: true,
    },
    services: [
      {
        type: "banquet_menu",
        priceUzs: 260_000,
        priceUnit: "per_guest",
        minQty: 20,
        includes: {
          ru: "Закуски, салаты, два горячих, плов, десерт, чай",
          uz: "Gazaklar, salatlar, ikki xil issiq taom, osh, desert, choy",
        },
        options: [
          { code: "drinks", priceUzs: 30_000, priceUnit: "per_guest" },
          { code: "cake", priceUzs: 900_000, priceUnit: "per_event" },
        ],
      },
      { type: "fotiha_menu", priceUzs: 1_200_000, priceUnit: "per_table", minQty: 2 },
      {
        type: "girls_party",
        priceUzs: 6_000_000,
        priceUnit: "per_event",
        options: [
          { code: "decor", priceUzs: 1_000_000, priceUnit: "per_event" },
          { code: "music", priceUzs: 1_200_000, priceUnit: "per_event" },
        ],
      },
      {
        type: "private_room",
        priceUzs: 1_500_000,
        priceUnit: "per_event",
        options: [{ code: "sound", priceUzs: 400_000, priceUnit: "per_event" }],
      },
      { type: "kids_menu", priceUzs: 70_000, priceUnit: "per_guest" },
    ],
    busyDays: [14],
    busyParts: [
      { offset: 2, part: "evening" },
      { offset: 6, part: "day" },
      { offset: 20, part: "evening" },
    ],
  },
  {
    ...base(20),
    vendorName: "Демо-вендор «Гулзор»",
    legalName: "Демо Гулзор (вымышленное юрлицо)",
    category: "flowers",
    slug: "demo-gullar-gulzor",
    name: "Демо-цветы «Гулзор» · Demo gullar «Gulzor»",
    districtCode: "mirzo_ulugbek",
    addressRu: "Ташкент, Мирзо-Улугбек — демо-адрес, не настоящий",
    addressUz: "Toshkent, Mirzo Ulugʻbek — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Цветочная мастерская: оформление зала, цветочные арки и стены, букеты невесты из пионов и роз. Работаем с живыми и искусственными цветами — искусственные не вянут и подходят для утреннего плова. Доставка и монтаж — наши.`,
    descriptionUz: `${DISCLAIMER_UZ}

Gul ustaxonasi: zalni bezash, gul arkalari va devorlari, pion va atirgullardan kelin guldastalari. Jonli va sunʼiy gullar bilan ishlaymiz — sunʼiy gullar soʻlimaydi va nahorgi oshga mos keladi. Yetkazib berish va montaj — bizdan.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 1,
    attributes: {
      flower_kinds: ["live", "artificial"],
      delivery: true,
      lead_days: 3,
      working_hours: "08:00–22:00",
    },
    services: [
      {
        type: "bridal_bouquet",
        priceUzs: 600_000,
        priceUnit: "per_item",
        options: [{ code: "toss_bouquet", priceUzs: 250_000, priceUnit: "per_item" }],
      },
      {
        type: "hall_flower_decor",
        priceUzs: 6_000_000,
        priceUnit: "per_event",
        includes: {
          ru: "Тор, вход, столы гостей, монтаж и демонтаж",
          uz: "Toʻr, kirish, mehmonlar stollari, montaj va demontaj",
        },
        options: [
          { code: "arch", priceUzs: 2_500_000, priceUnit: "per_item" },
          { code: "flower_wall", priceUzs: 3_000_000, priceUnit: "per_item" },
        ],
      },
      { type: "flower_arch", priceUzs: 3_500_000, priceUnit: "per_item" },
      {
        type: "gift_bouquet",
        priceUzs: 250_000,
        priceUnit: "per_item",
        options: [{ code: "delivery", priceUzs: 50_000, priceUnit: "per_event" }],
      },
      { type: "boutonniere", priceUzs: 80_000, priceUnit: "per_item" },
    ],
    busyDays: [],
    busyParts: [],
  },
  {
    ...base(21),
    vendorName: "Демо-вендор «Куёв»",
    legalName: "Демо Куёв (вымышленное юрлицо)",
    category: "attire",
    slug: "demo-libos-kuyov",
    name: "Демо-салон «Куёв» · Demo salon «Kuyov»",
    districtCode: "shayxontohur",
    addressRu: "Ташкент, Шайхантахур — демо-адрес, не настоящий",
    addressUz: "Toshkent, Shayxontohur — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Костюмы для жениха и семьи: классические тройки, смокинги и национальные чапаны с тюбетейкой. Прокат и продажа, подгонка по фигуре за один день. Обувь, галстуки и запонки — в том же салоне.`,
    descriptionUz: `${DISCLAIMER_UZ}

Kuyov va oila uchun kostyumlar: klassik uchlik, smoking va doʻppili milliy chopon. Ijara va sotuv, bir kunda qomatga moslash. Poyabzal, galstuk va zaponkalar — shu salonda.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 1,
    attributes: {
      attire_for: ["groom", "family"],
      deal_kinds: ["sale", "rent"],
      national_dress: true,
      alterations: true,
      fitting_room: true,
      delivery: true,
      size_range: "44–64",
      lead_days: 3,
      working_hours: "10:00–21:00",
    },
    services: [
      {
        type: "suit_rent",
        priceUzs: 900_000,
        priceUnit: "per_set",
        includes: { ru: "Пиджак, брюки, жилет, рубашка", uz: "Pidjak, shim, jilet, koʻylak" },
        options: [{ code: "shoes", priceUzs: 200_000, priceUnit: "per_item" }],
      },
      {
        type: "suit_sale",
        priceUzs: 4_500_000,
        priceUnit: "per_set",
        options: [{ code: "alterations", priceUzs: 300_000, priceUnit: "per_item" }],
      },
      {
        type: "national_outfit",
        priceUzs: 2_200_000,
        priceUnit: "per_set",
        includes: { ru: "Чапан, тюбетейка, поясной платок", uz: "Chopon, doʻppi, belbogʻ" },
      },
      { type: "accessories", priceUzs: 150_000, priceUnit: "per_item" },
    ],
    busyDays: [],
    busyParts: [],
  },
  {
    ...base(22),
    vendorName: "Демо-вендор «Ёдгор»",
    legalName: "Демо Ёдгор (вымышленное юрлицо)",
    category: "gifts",
    slug: "demo-sovga-yodgor",
    name: "Демо-подарки «Ёдгор» · Demo sovgʻalar «Yodgor»",
    districtCode: "uchtepa",
    addressRu: "Ташкент, Учтепа — демо-адрес, не настоящий",
    addressUz: "Toshkent, Uchtepa — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Сувениры с узбекским характером: шкатулки с сюзане, мини-ляганы, наборы чая и сладостей. Бонбоньерки для гостей и корпоративные подарки с логотипом. Партия — от 30 штук, доставка по Ташкенту.`,
    descriptionUz: `${DISCLAIMER_UZ}

Oʻzbekona ruhdagi esdaliklar: suzani qutichalar, kichik laganlar, choy va shirinlik toʻplamlari. Mehmonlar uchun bonbonyerkalar va logotipli korporativ sovgʻalar. Partiya — 30 donadan, Toshkent boʻylab yetkazib berish.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 1,
    attributes: {
      gift_kinds: ["bonbonniere", "souvenirs", "corporate", "couple"],
      personalization: true,
      packaging: true,
      min_batch: 30,
      lead_days: 10,
      delivery: true,
    },
    services: [
      {
        type: "bonbonniere",
        priceUzs: 18_000,
        priceUnit: "per_item",
        minQty: 30,
        options: [{ code: "name_print", priceUzs: 4_000, priceUnit: "per_item" }],
      },
      {
        type: "corporate_gifts",
        priceUzs: 120_000,
        priceUnit: "per_item",
        minQty: 20,
        options: [{ code: "logo", priceUzs: 15_000, priceUnit: "per_item" }],
      },
      {
        type: "couple_gift_set",
        priceUzs: 1_200_000,
        priceUnit: "per_set",
        includes: {
          ru: "Чайный набор, сюзане, сладости в шкатулке",
          uz: "Choy toʻplami, suzani, qutichada shirinliklar",
        },
      },
      {
        type: "in_law_gift_set",
        priceUzs: 2_000_000,
        priceUnit: "per_set",
        options: [{ code: "special_packaging", priceUzs: 300_000, priceUnit: "per_set" }],
      },
    ],
    busyDays: [],
    busyParts: [],
  },
  {
    ...base(23),
    vendorName: "Демо-вендор «Асал»",
    legalName: "Демо Асал (вымышленное юрлицо)",
    category: "cake",
    slug: "demo-tort-asal",
    name: "Демо-кондитерская «Асал» · Demo qandolatxona «Asal»",
    districtCode: "mirobod",
    addressRu: "Ташкент, Мирабад — демо-адрес, не настоящий",
    addressUz: "Toshkent, Mirobod — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Торты, бенто и национальные сладости: чак-чак, пашмак, нишолда. Сливочные кремы, ягоды и фигурки, торты — от 2 кг. Кэнди-бар под ключ — со столом и оформлением.`,
    descriptionUz: `${DISCLAIMER_UZ}

Tortlar, bento va milliy shirinliklar: chak-chak, pashmak, nisholda. Qaymoqli kremlar, rezavorlar va figurkalar, tortlar — 2 kg dan. Shirinlik stoli tayyor holda — stol va bezagi bilan.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 1,
    attributes: {
      cake_kinds: ["tiered", "bento", "national", "candy_bar", "cupcakes"],
      fillings: ["vanilla", "caramel", "cheese", "fruit"],
      cake_decor: ["cream", "figures", "fresh_flowers"],
      delivery: true,
      lead_days: 3,
      min_weight_kg: 2,
    },
    services: [
      {
        type: "wedding_cake",
        priceUzs: 150_000,
        priceUnit: "per_kg",
        minQty: 2,
        options: [
          { code: "figure", priceUzs: 250_000, priceUnit: "per_item" },
          { code: "fresh_flowers", priceUzs: 300_000, priceUnit: "per_event" },
        ],
      },
      { type: "bento", priceUzs: 120_000, priceUnit: "per_item" },
      {
        type: "pastries",
        priceUzs: 90_000,
        priceUnit: "per_kg",
        minQty: 1,
        includes: { ru: "Чак-чак, пашмак, нишолда на выбор", uz: "Chak-chak, pashmak, nisholda — tanlovga" },
      },
      {
        type: "candy_bar",
        priceUzs: 2_500_000,
        priceUnit: "per_event",
        options: [
          { code: "decor", priceUzs: 600_000, priceUnit: "per_event" },
          { code: "table", priceUzs: 300_000, priceUnit: "per_event" },
        ],
      },
    ],
    busyDays: [],
    busyParts: [],
  },
  {
    ...base(24),
    vendorName: "Демо-вендор «Нахор»",
    legalName: "Демо Нахор (вымышленное юрлицо)",
    category: "food",
    slug: "demo-katering-nahor",
    name: "Демо-кейтеринг «Нахор» · Demo katering «Nahor»",
    districtCode: "chilonzor",
    addressRu: "Ташкент, Чиланзар — демо-адрес, не настоящий",
    addressUz: "Toshkent, Chilonzor — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Утренний плов на 100–1500 гостей: повара с казанами приезжают на рассвете, к семи утра всё готово. Столы, скатерти, посуда, официанты и шатёр — по выбору. Фуршет и стол для фотихи — тоже к нам.`,
    descriptionUz: `${DISCLAIMER_UZ}

100–1500 mehmonga nahorgi osh: oshpazlar qozonlari bilan tong saharda keladi, soat yettiga hammasi tayyor. Stol, dasturxon, idish-tovoq, ofitsiantlar va chodir — tanlovga. Furshet va fotiha dasturxoni ham bizda.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 3,
    attributes: {
      cuisine: ["national"],
      min_guests: 100,
      max_guests: 1500,
      on_site_cooking: true,
      waiters: true,
      furniture: true,
      certificates: true,
      service_area: "tashkent_region",
    },
    services: [
      {
        type: "morning_plov",
        priceUzs: 55_000,
        priceUnit: "per_guest",
        minQty: 100,
        includes: {
          ru: "Плов, салаты, лепёшки, чай, сладости",
          uz: "Osh, salatlar, non, choy, shirinliklar",
        },
        options: [
          { code: "waiters", priceUzs: 800_000, priceUnit: "per_event" },
          { code: "furniture", priceUzs: 20_000, priceUnit: "per_guest" },
          { code: "tent", priceUzs: 2_000_000, priceUnit: "per_event" },
        ],
      },
      { type: "buffet", priceUzs: 140_000, priceUnit: "per_guest", minQty: 30 },
      { type: "fotiha_table", priceUzs: 900_000, priceUnit: "per_table", minQty: 2 },
      { type: "waiter_service", priceUzs: 500_000, priceUnit: "per_event" },
      { type: "equipment_rent", priceUzs: 20_000, priceUnit: "per_guest", minQty: 50 },
    ],
    busyDays: [19],
    busyParts: [
      { offset: 2, part: "morning" },
      { offset: 7, part: "morning" },
      { offset: 9, part: "morning" },
      { offset: 15, part: "day" },
    ],
  },
  {
    ...base(25),
    vendorName: "Демо-вендор «Нафис»",
    legalName: "Демо Нафис (вымышленное юрлицо)",
    category: "decor",
    slug: "demo-dekor-nafis",
    name: "Демо-декор «Нафис» · Demo dekor «Nafis»",
    districtCode: "yashnobod",
    addressRu: "Ташкент, Яшнабад — демо-адрес, не настоящий",
    addressUz: "Toshkent, Yashnobod — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Декор в спокойных тонах: минимализм, рустик, современная классика. Арки на вход, световые инсталляции, тяжёлый дым и конфетти на первый танец. Оформляем и утренний плов — с национальными тканями и сюзане.`,
    descriptionUz: `${DISCLAIMER_UZ}

Sokin ranglardagi bezak: minimalizm, rustik, zamonaviy klassika. Kirish arkalari, yorugʻlik instalyatsiyalari, birinchi raqs uchun ogʻir tutun va konfetti. Nahorgi oshni ham milliy matolar va suzanilar bilan bezaymiz.`,
    capMin: null,
    capMax: null,
    parallelCapacity: 2,
    attributes: {
      styles: ["minimal", "rustic", "modern"],
      flower_kinds: ["artificial"],
      own_furniture: true,
      installation: true,
      service_area: "tashkent_region",
    },
    services: [
      {
        type: "stage_decor",
        priceUzs: 2_500_000,
        priceUnit: "per_event",
        options: [{ code: "lighting", priceUzs: 700_000, priceUnit: "per_event" }],
      },
      { type: "entrance_arch", priceUzs: 1_800_000, priceUnit: "per_item" },
      {
        type: "lighting_effects",
        priceUzs: 1_200_000,
        priceUnit: "per_event",
        options: [
          { code: "smoke", priceUzs: 600_000, priceUnit: "per_event" },
          { code: "confetti", priceUzs: 300_000, priceUnit: "per_event" },
        ],
      },
      {
        type: "morning_plov_decor",
        priceUzs: 2_000_000,
        priceUnit: "per_event",
        includes: {
          ru: "Сюзане, текстиль на столы, оформление входа",
          uz: "Suzani, stollar uchun mato, kirishni bezash",
        },
      },
      { type: "table_decor", priceUzs: 120_000, priceUnit: "per_table", minQty: 10 },
    ],
    busyDays: [27],
    busyParts: [
      { offset: 4, part: "morning" },
      { offset: 4, part: "evening" },
      { offset: 18, part: "day" },
    ],
  },
];

/** Реквизиты и контакт вендора — всё вымышленное */
export function demoContacts(venue: DemoVenue) {
  return {
    legal_name: venue.legalName,
    stir: venue.stir,
    legal_address: CONTACT.legalAddress,
    contact_person: CONTACT.person,
    contact_role: CONTACT.role,
    phone: venue.phone,
  };
}

/** Сколько фото ждёт seed: по DEMO_PHOTOS_PER_VENUE на каждую витрину, по порядку витрин */
export const DEMO_PHOTO_COUNT = DEMO_VENUES.length * DEMO_PHOTOS_PER_VENUE;
