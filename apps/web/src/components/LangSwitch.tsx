import { LANGS, type Lang } from "@bayramm/shared";
import { Tooltip } from "@bayramm/ui/react";
import { useLang } from "../context";
import { prefetchDictionary } from "../i18n";

/** Название языка на нём самом — подсказка в переключателе */
export const LANG_NAMES: Readonly<Record<Lang, string>> = { ru: "Русский", uz: "Oʻzbekcha" };

/* Словарь второго языка грузится по требованию (i18n.ts): заранее — когда к кнопке потянулись
   (мышь над ней, фокус, касание), чтобы смена была мгновенной; пока грузится — кнопка занята */
export function LangSwitch({ className = "lang" }: { className?: string }) {
  const { lang, setLang, t, pendingLang } = useLang();
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
              aria-busy={code === pendingLang || undefined}
              onPointerEnter={(event) => {
                tip.onPointerEnter(event);
                prefetchDictionary(code);
              }}
              onFocus={(event) => {
                tip.onFocus(event);
                prefetchDictionary(code);
              }}
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
