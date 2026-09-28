/**
 * Русское склонение по числу: 1 день, 2 дня, 5 дней, 11 дней, 21 день.
 * Перенос `plural(n, a, b, c)` из прототипа как есть. Ожидает целое n;
 * отрицательные числа склоняются по модулю.
 */
export function ruPlural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n));
  const lastTwo = abs % 100;
  const last = abs % 10;
  if (lastTwo > 10 && lastTwo < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
