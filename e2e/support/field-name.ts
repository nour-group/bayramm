/** Имя поля целиком: подпись и, если есть, пометка у неё («обязательно», «по желанию») — для
   getByLabel и `name` у getByRole. Подпись и пометки — из словарей приложений, спецсимволы
   экранированы. */
export function fieldName(label: string, marks: readonly string[]): RegExp {
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = `^${literal(label)}(?: (?:${marks.map(literal).join("|")}))?$`;
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(source);
}
