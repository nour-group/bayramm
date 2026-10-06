/* Витрины в боковой панели компьютера — единственный выбор витрины на этой ширине. На
   входящих сверху ещё «Все витрины»: список заявок фильтруется здесь же, второго выбора над
   списком нет. На остальных разделах — витрина, которую показывают календарь, витрина и услуги.

   Подпись категории — из своей части сборки (CATEGORY_KIT): конфигурация категорий в
   основную часть не попадает. Пока она грузится (обычно уже загружена вместе с заявками),
   место под подпись занято — список не прыгает. */

import type { VendorListingRef } from "@bayramm/shared/api/vendor";
import { AttentionLine, attentionLine } from "./AttentionLine";
import type { AttentionMark } from "./attention";
import type { VendorDict } from "./i18n";
import { CATEGORY_KIT, usePart } from "./screens";

interface SideVitrinasProps {
  readonly listings: readonly VendorListingRef[];
  /** Выбранная витрина; null — все (только с allLabel) */
  readonly value: string | null;
  readonly onChange: (id: string | null) => void;
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
  /** Входящие: вариант «все витрины» сверху */
  readonly allLabel?: string;
  /** Раздел со значком: у витрин, где партнёра ждут отказы команды, — «требует внимания: N» */
  readonly mark?: AttentionMark;
}

/** Витрина одна — выбирать нечего, блока нет */
export function SideVitrinas({ listings, value, onChange, t, lang, allLabel, mark }: SideVitrinasProps) {
  const kit = usePart(CATEGORY_KIT);
  if (listings.length < 2) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: переключатель витрин — группа кнопок, не форма
    <div className="side-vitrinas" role="group" aria-labelledby="side-vitrinas-title">
      <p className="side-title" id="side-vitrinas-title">
        {allLabel ? t.inboxFilter : t.vitrinas}
      </p>
      {allLabel ? (
        <button
          type="button"
          className="side-vitrina side-vitrina-all"
          aria-pressed={value === null}
          onClick={() => onChange(null)}
        >
          <span className="vitrina-name">{allLabel}</span>
        </button>
      ) : null}
      {listings.map((listing) => (
        <button
          key={listing.id}
          type="button"
          className="side-vitrina"
          aria-pressed={listing.id === value}
          onClick={() => onChange(listing.id)}
        >
          <span className="vitrina-name">{listing.name}</span>
          <span className="vitrina-cat">{kit ? kit.categoryName(lang, listing.categoryCode) : ""}</span>
          <AttentionLine text={attentionLine(listing, mark, t)} />
        </button>
      ))}
    </div>
  );
}
