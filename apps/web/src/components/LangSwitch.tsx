import { LANGS, type Lang } from "@bayramm/shared";
import { Tooltip } from "@bayramm/ui/react";
import { useLang } from "../context";

/** Название языка на нём самом — подсказка в переключателе */
export const LANG_NAMES: Readonly<Record<Lang, string>> = { ru: "Русский", uz: "Oʻzbekcha" };

export function LangSwitch({ className = "lang" }: { className?: string }) {
  const { lang, setLang, t } = useLang();
  return (
    // biome-ignore lint/a11y/useSemanticElements: группа кнопок-переключателей, fieldset здесь не форма
    <div className={className} role="group" aria-label={t.language}>
      {LANGS.map((code) => (
        <Tooltip key={code} text={LANG_NAMES[code]}>
          {(tip) => (
            <button
              {...tip}
              type="button"
              lang={code}
              aria-pressed={code === lang}
              onClick={() => setLang(code)}
            >
              {code.toUpperCase()}
            </button>
          )}
        </Tooltip>
      ))}
    </div>
  );
}
