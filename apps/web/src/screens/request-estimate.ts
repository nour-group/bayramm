import type { PriceUnit, PublicService, ServiceOption } from "@bayramm/shared/api";

/* Примерная сумма заявки по выбранным услугам — только подсказка клиенту: точную сумму
   называет вендор (так и подписано в форме). Считается по ценам витрины:

     · услуга за мероприятие — цена один раз; за гостя — × гостей (не указаны — посчитать
       нельзя, форма просит указать); штучные единицы (час, кг, штука, комплект, стол) —
       × количество из формы (не меньше минимального у вендора);
     · опция — один раз; в той же единице, что услуга, — × то же количество (зона студии на
       каждый час, имя на каждой бонбоньерке); за гостя — × гостей; «дополнительный час» —
       один час (сколько их, клиент обсудит с вендором). */

/** Единицы, в которых клиент указывает количество */
const COUNTED: readonly PriceUnit[] = ["per_hour", "per_item", "per_kg", "per_set", "per_table"];

/** Нужно ли количество у услуги в этой единице цены */
export const hasQty = (unit: PriceUnit): boolean => COUNTED.includes(unit);

export interface Choice {
  /** Количество в единице цены услуги; null — не указано (минимальное у вендора или 1) */
  readonly qty: number | null;
  readonly options: readonly string[];
}

/** Сумма по одной услуге с опциями; null — нужна цифра гостей, а её нет */
export function lineTotal(service: PublicService, choice: Choice, guests: number | null): number | null {
  const count = choice.qty ?? service.minQty ?? 1;
  const times = (unit: PriceUnit, option: ServiceOption | null): number | null => {
    if (unit === "per_guest") return guests;
    if (unit === "per_event" || option?.code === "extra_hour") return 1;
    if (option === null || unit === service.priceUnit) return count;
    return 1;
  };
  const base = times(service.priceUnit, null);
  if (base === null) return null;
  let total = service.priceUzs * base;
  for (const id of choice.options) {
    const option = service.options.find((o) => o.id === id);
    if (!option) continue;
    const n = times(option.priceUnit, option);
    if (n === null) return null;
    total += option.priceUzs * n;
  }
  return total;
}

export interface Estimate {
  /** Сумма по услугам, которые удалось посчитать */
  readonly total: number;
  /** Сколько услуг в сумме */
  readonly counted: number;
  /** Есть услуги с ценой за гостя, а гости не указаны: они в сумму не вошли */
  readonly needsGuests: boolean;
}

/** Примерная сумма по выбранным услугам витрины */
export function estimate(
  services: readonly PublicService[],
  chosen: readonly ({ readonly id: string } & Choice)[],
  guests: number | null,
): Estimate {
  let total = 0;
  let counted = 0;
  let needsGuests = false;
  for (const choice of chosen) {
    const service = services.find((s) => s.id === choice.id);
    if (!service) continue;
    const line = lineTotal(service, choice, guests);
    if (line === null) needsGuests = true;
    else {
      total += line;
      counted += 1;
    }
  }
  return { total, counted, needsGuests };
}

/**
 * Количество, которое форма предлагает при выборе услуги: из поля формы в той же единице
 * (часы, вес, штуки, столы), иначе минимальное у вендора или 1 — но не меньше минимального
 */
export function suggestedQty(
  service: Pick<PublicService, "priceUnit" | "minQty">,
  values: Readonly<Record<string, unknown>>,
): string {
  if (!hasQty(service.priceUnit)) return "";
  const from: Partial<Record<PriceUnit, string>> = {
    per_hour: "hours",
    per_kg: "weight_kg",
    per_item: "quantity",
    per_table: "tables",
  };
  const key = from[service.priceUnit];
  const raw = key === undefined ? undefined : values[key];
  const field = typeof raw === "string" && /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : null;
  const min = service.minQty ?? 1;
  return String(Math.max(min, field ?? min));
}
