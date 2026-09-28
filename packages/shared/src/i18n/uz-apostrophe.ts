/* Узбекские апострофы.

   ОЖИДАЕТ ПОДТВЕРЖДЕНИЯ владельцем текстов. Пока реализован вариант по умолчанию —
   официальная орфография:
   - oʻ и gʻ пишутся с U+02BB (MODIFIER LETTER TURNED COMMA);
   - тутук белгиси (maʼlumot, eʼlon) — U+02BC (MODIFIER LETTER APOSTROPHE).
   Если решение изменится, править только этот файл и перезапустить перенос словаря.

   Файл без импортов и только со стираемым синтаксисом TS: его подключает
   scripts/extract-client-dict.mjs напрямую через Node (снятие типов). */

/** Знак для oʻ и gʻ — U+02BB */
export const UZ_OKINA = "\u02BB";

/** Тутук белгиси (разделительный знак) — U+02BC */
export const UZ_TUTUQ = "\u02BC";

/* Всё, что люди набирают вместо апострофа: прямой ', типографские ‘ ’ ‛,
   обратный `, акут ´, штрих ′, а также правильные ʻ ʼ и похожий ʹ */
const VARIANTS = "'\u2018\u2019\u201B`\u00B4\u2032\u02B9\u02BB\u02BC";

// Апостроф считается буквенным знаком, только если стоит сразу после латинской буквы
const AFTER_LETTER = new RegExp(`([A-Za-z])[${VARIANTS}]`, "g");

/**
 * Приводит узбекский текст к одному написанию апострофов: после o/g — U+02BB,
 * после остальных букв — U+02BC. Апостроф не после латинской буквы не трогает.
 * Для поиска: нормализовать и запрос, и то, по чему ищем, — тогда «Navro'z»
 * находит «Navroʻz». Регистр не меняет.
 */
export function normalizeUz(text: string): string {
  return text
    .normalize("NFC")
    .replace(AFTER_LETTER, (_, letter: string) => letter + ("OoGg".includes(letter) ? UZ_OKINA : UZ_TUTUQ));
}

/** Есть ли в тексте апостроф, отличный от U+02BB и U+02BC */
export function hasNonCanonicalApostrophe(text: string): boolean {
  return /['\u2018\u2019\u201B`\u00B4\u2032\u02B9]/.test(text);
}
