// Демо-залы staging: три вымышленных вендора, у каждого — карточка зала. Их заводит
// и убирает POST /ops/demo (routes/ops.ts), только на staging.
//
// Всё, что видит клиент, помечено: название начинается с «Демо-зал» и «Demo zal»,
// описание — с предупреждения, что зала нет, адрес — «демо-адрес», телефон —
// +998 00 000 00 0N (кода оператора 00 нет). Людей нет: контакт — «Демо-контакт»,
// фото — абстрактные картинки со словом DEMO (их рисует workflow Demo data).
//
// Метка демо-строк — id из зарезервированного диапазона DEMO_ID_PREFIX: случайный
// UUID туда не попадает, а id вендора и карточки в панели не выбирают. По этому же
// диапазону app.demo_purge() (supabase/migrations/…_demo_purge.sql) находит, что
// убрать, — и ничего сверх этого.
//
// Узбекский — латиница: ʻ (U+02BB) после o/g, ʼ (U+02BC) — tutuq belgisi.

import type { PriceUnit, StaffListingPackage } from "@bayramm/shared/api/staff";

/** Начало id всех демо-строк; тот же литерал — в app.demo_purge() */
export const DEMO_ID_PREFIX = "00000000-0000-4000-8000-de";

/** Фото на зал: минимум для публикации (правило продукта) */
export const DEMO_PHOTOS_PER_VENUE = 3;

/** Занятые дни ставятся в пределах стольких дней от сегодняшнего */
export const DEMO_BUSY_HORIZON_DAYS = 60;

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
  readonly slug: string;
  readonly name: string;
  readonly districtCode: string;
  readonly addressRu: string;
  readonly addressUz: string;
  readonly descriptionRu: string;
  readonly descriptionUz: string;
  readonly priceFromUzs: number;
  readonly priceUnit: PriceUnit;
  readonly capMin: number;
  readonly capMax: number;
  readonly packages: readonly StaffListingPackage[];
  /** Занятые дни — через столько дней от сегодняшнего (по Ташкенту) */
  readonly busyDays: readonly number[];
}

/** id в демо-диапазоне: 10 цифр номера после префикса */
const demoId = (n: number) => `${DEMO_ID_PREFIX}${String(n).padStart(10, "0")}`;

const DISCLAIMER_RU = "Демонстрационная карточка: такого зала нет, заявки уходят на тестовый стенд.";
const DISCLAIMER_UZ = "Namoyish kartochkasi: bunday zal yoʻq, soʻrovlar sinov muhitiga boradi.";

const CONTACT = {
  person: "Демо-контакт",
  role: "Администратор (демо)",
  legalAddress: "Демо-адрес, не настоящий",
} as const;

const weekday = (priceUzs: number, priceUnit: PriceUnit): StaffListingPackage => ({
  kind: "weekday",
  nameRu: "Будни",
  nameUz: "Ish kunlari",
  priceUzs,
  priceUnit,
});

const weekend = (priceUzs: number, priceUnit: PriceUnit): StaffListingPackage => ({
  kind: "weekend",
  nameRu: "Выходные",
  nameUz: "Dam olish kunlari",
  priceUzs,
  priceUnit,
});

export const DEMO_VENUES: readonly DemoVenue[] = [
  {
    vendorId: demoId(1),
    listingId: demoId(101),
    vendorName: "Демо-вендор «Анор»",
    legalName: "Демо Анор (вымышленное юрлицо)",
    contractNo: "DEMO-1",
    stir: "000000001",
    phone: "+998000000001",
    slug: "demo-zal-anor",
    name: "Демо-зал «Анор» · Demo zal «Anor»",
    districtCode: "yunusobod",
    addressRu: "Ташкент, Юнусабад — демо-адрес, не настоящий",
    addressUz: "Toshkent, Yunusobod — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Светлый банкетный зал на 60–300 гостей. Своя кухня — национальные и европейские блюда, плов готовят при гостях. Сцена и звук для ведущего и музыкантов, комната для невесты, парковка на 80 машин. Торт и фрукты можно принести свои — без доплаты.`,
    descriptionUz: `${DISCLAIMER_UZ}

60–300 mehmonga moʻljallangan yorugʻ banket zali. Oshxona oʻzimizniki — milliy va yevropa taomlari, osh mehmonlar oldida damlanadi. Boshlovchi va sozandalar uchun sahna va ovoz tizimi, kelin xonasi, 80 ta mashinaga avtoturargoh. Tort va mevalarni oʻzingiz olib kelishingiz mumkin — qoʻshimcha toʻlovsiz.`,
    priceFromUzs: 180_000,
    priceUnit: "per_guest",
    capMin: 60,
    capMax: 300,
    packages: [weekday(180_000, "per_guest"), weekend(220_000, "per_guest")],
    busyDays: [3, 10, 11, 24, 38, 52],
  },
  {
    vendorId: demoId(2),
    listingId: demoId(102),
    vendorName: "Демо-вендор «Чинор»",
    legalName: "Демо Чинор (вымышленное юрлицо)",
    contractNo: "DEMO-2",
    stir: "000000002",
    phone: "+998000000002",
    slug: "demo-zal-chinor",
    name: "Демо-зал «Чинор» · Demo zal «Chinor»",
    districtCode: "chilonzor",
    addressRu: "Ташкент, Чиланзар — демо-адрес, не настоящий",
    addressUz: "Toshkent, Chilonzor — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Большой зал на 100–500 гостей для свадеб и утреннего плова. Два уровня, высокие потолки, много дневного света. Своя кухня и кондитер, живая музыка — по договорённости. Рядом метро, парковка во дворе.`,
    descriptionUz: `${DISCLAIMER_UZ}

Toʻy va nahorgi osh uchun 100–500 mehmonga moʻljallangan katta zal. Ikki qavat, baland shift, kunduzi yorugʻ. Oʻz oshxonamiz va qandolatchimiz bor, jonli musiqa — kelishuv asosida. Metro yaqin, hovlida avtoturargoh.`,
    priceFromUzs: 150_000,
    priceUnit: "per_guest",
    capMin: 100,
    capMax: 500,
    packages: [
      weekday(150_000, "per_guest"),
      weekend(190_000, "per_guest"),
      {
        kind: "custom",
        nameRu: "Утренний плов",
        nameUz: "Nahorgi osh",
        priceUzs: 90_000,
        priceUnit: "per_guest",
      },
    ],
    busyDays: [4, 5, 18, 19, 33, 47],
  },
  {
    vendorId: demoId(3),
    listingId: demoId(103),
    vendorName: "Демо-вендор «Гирих»",
    legalName: "Демо Гирих (вымышленное юрлицо)",
    contractNo: "DEMO-3",
    stir: "000000003",
    phone: "+998000000003",
    slug: "demo-zal-girih",
    name: "Демо-зал «Гирих» · Demo zal «Girih»",
    districtCode: "mirzo_ulugbek",
    addressRu: "Ташкент, Мирзо-Улугбек — демо-адрес, не настоящий",
    addressUz: "Toshkent, Mirzo Ulugʻbek — demo manzil, haqiqiy emas",
    descriptionRu: `${DISCLAIMER_RU}

Камерный зал на 30–150 гостей: дни рождения, бешик-той, корпоративы. Цена — за мероприятие целиком: зал, обслуживание и оформление. На стенах — орнамент гирих, есть терраса и детская комната с няней.`,
    descriptionUz: `${DISCLAIMER_UZ}

Tugʻilgan kun, beshik toʻyi va korporativlar uchun 30–150 mehmonga moʻljallangan ixcham zal. Narx butun tadbir uchun: zal, xizmat koʻrsatish va bezak. Devorlarda girih naqshi, ayvon va enaga bilan bolalar xonasi bor.`,
    priceFromUzs: 18_000_000,
    priceUnit: "per_event",
    capMin: 30,
    capMax: 150,
    packages: [weekday(18_000_000, "per_event"), weekend(24_000_000, "per_event")],
    busyDays: [6, 13, 20, 27, 41, 55],
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

/** Сколько фото ждёт seed: по DEMO_PHOTOS_PER_VENUE на каждый зал, по порядку залов */
export const DEMO_PHOTO_COUNT = DEMO_VENUES.length * DEMO_PHOTOS_PER_VENUE;
