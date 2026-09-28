/* Размеченный текст без HTML.

   В словаре нет разметки: абзацы, списки, предупреждения и выделение описаны данными.
   Отрисовывает их компонент обычными текстовыми узлами, строки словаря никогда
   не вставляются как HTML. */

/** Фрагмент строки: обычный текст или выделенный (в прототипе был <b>) */
export type Inline = string | { readonly strong: string };

/** Блок справочного текста: абзац, предупреждение (<p class="warn">) или список (<ul>) */
export type Block =
  | { readonly kind: "p"; readonly text: readonly Inline[] }
  | { readonly kind: "warn"; readonly text: readonly Inline[] }
  | { readonly kind: "list"; readonly items: readonly string[] };

/** Несколько блоков подряд — тело справочного окна */
export type RichText = readonly Block[];

/** Выделенный фрагмент */
export const strong = (text: string): Inline => ({ strong: text });

/** Абзац */
export const p = (...text: Inline[]): Block => ({ kind: "p", text });

/** Абзац-предупреждение */
export const warn = (...text: Inline[]): Block => ({ kind: "warn", text });

/** Маркированный список */
export const list = (...items: string[]): Block => ({ kind: "list", items });

/** Строка из фрагментов без выделения — для aria-label, уведомлений и тестов */
export function inlineText(parts: readonly Inline[]): string {
  return parts.map((part) => (typeof part === "string" ? part : part.strong)).join("");
}

/** Весь текст блоков одной строкой, блоки через перевод строки */
export function richText(blocks: RichText): string {
  return blocks
    .map((block) => (block.kind === "list" ? block.items.join("\n") : inlineText(block.text)))
    .join("\n");
}
