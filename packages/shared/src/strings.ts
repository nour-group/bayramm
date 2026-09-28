/**
 * Убирает завершающие «/» за линейное время.
 * Не регулярным выражением: /\/+$/ на строке из множества «/» работает квадратично (ReDoS).
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}
