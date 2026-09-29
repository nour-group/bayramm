import { LANGS, type Lang } from "@bayramm/shared";
import { useLang } from "../context";

/** Название языка на нём самом — подсказка в переключателе */
export const LANG_NAMES: Readonly<Record<Lang, string>> = { ru: "Русский", uz: "Oʻzbekcha" };

export function LangSwitch({ className = "lang" }: { className?: string }) {
  const { lang, setLang, t } = useLang();
  return (
    // biome-ignore lint/a11y/useSemanticElements: группа кнопок-переключателей, fieldset здесь не форма
    <div className={className} role="group" aria-label={t.language}>
      {LANGS.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          title={LANG_NAMES[code]}
          aria-pressed={code === lang}
          onClick={() => setLang(code)}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
