/**
 * Первая буква — строчная, если слово не сокращение: «Тойханы» → «тойханы», «Foto va video» →
 * «foto va video», а «ЗАГС» и «FHDYo» — как есть (вторая буква заглавная). Для подписей вида
 * «Toshkentdagi toʻyxonalar», «Чиланзар — тойханы»
 */
export function lowerFirst(text: string): string {
  const [first = "", second = ""] = [...text];
  if (second !== "" && second === second.toUpperCase() && second !== second.toLowerCase()) return text;
  return first.toLowerCase() + text.slice(first.length);
}
