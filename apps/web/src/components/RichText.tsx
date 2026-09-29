import type { RichText as Blocks, Inline } from "@bayramm/shared";

function Inlines({ parts }: { parts: readonly Inline[] }) {
  return (
    <>
      {parts.map((part, i) =>
        typeof part === "string" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: фрагменты одной фразы, порядок постоянный
          <span key={i}>{part}</span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: фрагменты одной фразы, порядок постоянный
          <strong key={i}>{part.strong}</strong>
        ),
      )}
    </>
  );
}

/** Справочный текст из словаря: блоки данных, не HTML — только текстовые узлы */
export function RichText({ blocks }: { blocks: Blocks }) {
  return (
    <div className="rich">
      {blocks.map((block, i) => {
        if (block.kind === "list")
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: блоки статичного текста
            <ul key={i}>
              {block.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          );
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: блоки статичного текста
          <p key={i} className={block.kind === "warn" ? "warn" : undefined}>
            <Inlines parts={block.text} />
          </p>
        );
      })}
    </div>
  );
}

/** Текст с переводами строк — абзацами (описания площадок, тексты согласий) */
export function Paragraphs({ text, className }: { text: string; className?: string }) {
  const paragraphs = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    <div className={className}>
      {paragraphs.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: абзацы одного текста, порядок постоянный
        <p key={i}>{line}</p>
      ))}
    </div>
  );
}
