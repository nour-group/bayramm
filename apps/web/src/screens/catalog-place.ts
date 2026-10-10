import type { Dict, Lang } from "@bayramm/shared";
import type { Dictionaries } from "@bayramm/shared/api";
import type { SelectOption } from "@bayramm/ui/react";
import { pick } from "../context";
import type { CatalogFilters } from "./catalog-feed";

/* Место в фильтре каталога — один список «город → район»: город целиком (его районы и
   выездные витрины без района) или один район. Пока город один (Ташкент), первая строка —
   «Ташкент — весь город» и она же значение по умолчанию; когда городов станет больше — сверху
   «Везде», под каждым городом — его районы с отступом. Значение списка — "" (по умолчанию),
   "city:<код>" или "district:<код>"; в адресе — ?city= или ?district= (с районом город не
   пишется: район его уже называет). */

export interface PlaceChoice {
  /** Значение списка для текущих фильтров */
  readonly value: string;
  readonly options: readonly SelectOption[];
  /** Что выбрано, словами — для «что отсекает выдачу»; null — место не ограничено */
  readonly chosen: string | null;
}

type PlaceDictionaries = Pick<Dictionaries, "cities" | "districts">;

export function placeChoice(
  filters: Pick<CatalogFilters, "city" | "district">,
  dicts: PlaceDictionaries | null,
  t: Dict,
  lang: Lang,
): PlaceChoice {
  // Справочник старого API — без городов: районы списком без группы
  const cities = dicts?.cities ?? [];
  const districts = dicts?.districts ?? [];
  const only = cities.length === 1 ? cities[0] : undefined;
  const districtsOf = (city: string) =>
    districts
      .filter((d) => d.city === city)
      .map((d) => ({ value: `district:${d.code}`, label: pick(d.name, lang), nested: true }));

  const options: SelectOption[] = only
    ? [{ value: "", label: t.wholeCity(pick(only.name, lang)) }, ...districtsOf(only.code)]
    : [
        { value: "", label: t.anyPlace },
        ...cities.flatMap((city) => [
          { value: `city:${city.code}`, label: t.wholeCity(pick(city.name, lang)) },
          ...districtsOf(city.code),
        ]),
        ...(cities.length === 0
          ? districts.map((d) => ({ value: `district:${d.code}`, label: pick(d.name, lang) }))
          : []),
      ];

  // Единственный город целиком — то же, что «везде»: значение по умолчанию
  const value =
    filters.district !== null
      ? `district:${filters.district}`
      : filters.city !== null && filters.city !== only?.code
        ? `city:${filters.city}`
        : "";
  const chosen =
    value === "" ? null : (options.find((o) => o.value === value)?.label ?? filters.district ?? filters.city);
  return { value, options, chosen };
}

/** Фильтры места по значению списка: район сбрасывает город и наоборот */
export function placeFilters(value: string): Pick<CatalogFilters, "city" | "district"> {
  const [kind, code = ""] = value.split(":");
  if (kind === "district" && code) return { city: null, district: code };
  if (kind === "city" && code) return { city: code, district: null };
  return { city: null, district: null };
}
