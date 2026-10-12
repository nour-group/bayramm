import { type RawBuilder, sql } from "kysely";

/* Сколько всего записей в списке панели, когда страница уже прочитана.

   Раньше в запрос страницы входило `count(*) over ()`: оно заставляло базу пройти все строки
   выборки, отсортировать их и вычислить поля для каждой, хотя нужны только limit штук
   (на 75 тысячах заявок страница стоила 91 мс вместо 32, на 500 тысячах строк журнала —
   около секунды вместо 5 мс с индексом). Теперь страница читается сама, а общее число —
   отдельным запросом, и только когда его не видно по странице. */

/**
 * Общее число записей. Страница неполная и не пустая — конец списка виден по ней самой
 * (offset + строк); первая страница пуста — список пуст; иначе нужен count — отдельный запрос
 * с теми же условиями
 */
export async function pageTotal(
  rows: number,
  limit: number,
  offset: number,
  count: () => Promise<number>,
): Promise<number> {
  if (rows > 0 && rows < limit) return offset + rows;
  if (rows === 0 && offset === 0) return 0;
  return count();
}

/** Условия списка одним выражением (через and): страница и count берут одно и то же; пусто — true */
export function allOf(conditions: readonly RawBuilder<boolean>[]): RawBuilder<boolean> {
  if (conditions.length === 0) return sql<boolean>`true`;
  return sql<boolean>`(${sql.join(conditions, sql` and `)})`;
}
