// Демо-витрины staging: вымышленные вендоры, у каждого — витрина в своей категории
// (три зала и по одной в каждой включённой категории). Их заводит и убирает
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
): DemoService => ({
  type,
  priceUzs,
  priceUnit,
});

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
      banquet("banquet_weekday", 180_000, "per_guest"),
      banquet("banquet_weekend", 220_000, "per_guest"),
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
      banquet("banquet_weekday", 150_000, "per_guest"),
      banquet("banquet_weekend", 190_000, "per_guest"),
      { type: "morning_plov", priceUzs: 90_000, priceUnit: "per_guest" },
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
      banquet("banquet_weekday", 18_000_000, "per_event"),
      banquet("banquet_weekend", 24_000_000, "per_event"),
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
