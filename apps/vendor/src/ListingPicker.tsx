/* Выбор витрины на экране (телефон и планшет). У вендора витрин бывает несколько — по одной в
   каждой категории (зал и кортеж, студия и фото-видео): у каждой свои заявки, календарь,
   данные и услуги. Выбранная витрина — одна на весь кабинет (App.tsx): её показывают
   календарь, витрина и услуги; во входящих есть ещё «Все витрины».

   До двух витрин — пилюли в строку с переносом (PILLS_MAX): выбор — одно нажатие, без
   шторки, и все витрины видны сразу. Больше — список выбора (Select набора: на телефоне —
   шторка): столько пилюль заняло бы пол-экрана. Подписи у выбора нет — экран уже называет
   себя заголовком; имя («Выберите витрину», «Заявки какой витрины») — только для диктора.
   Витрина одна или выбор — в боковой панели (компьютер, SideVitrinas.tsx) — вместо выбора
   строка «какая это витрина». */

import type { VendorListingRef } from "@bayramm/shared/api/vendor";
import { Select } from "@bayramm/ui/react";
import { useId } from "react";
import { AttentionLine, attentionLine } from "./AttentionLine";
import type { AttentionMark } from "./attention";
import { categoryName } from "./category";
import type { VendorDict } from "./i18n";
import { Icon } from "./icons";

/** Значение «все витрины» во входящих (у Select значение — строка) */
const ALL = "all";

/** Витрин не больше стольких — пилюли, больше — список выбора: три пилюли с «Все витрины» на
   телефоне — уже две строки над списком */
export const PILLS_MAX = 2;

interface ListingPickerProps {
  readonly listings: readonly VendorListingRef[];
  /** Выбранная витрина; null — все (только с allLabel) */
  readonly value: string | null;
  readonly onChange: (id: string | null) => void;
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
  /** Выбор — в боковой панели (компьютер): здесь только строка с витриной */
  readonly inSidebar?: boolean;
  /** Строка «какая это витрина» не нужна: экран сам называет витрину */
  readonly line?: boolean;
  /** Подпись варианта «все витрины» (входящие); нет — выбрать можно только одну */
  readonly allLabel?: string;
  /** Имя выбора для диктора: «Выберите витрину», «Заявки какой витрины» (на экране подписи нет) */
  readonly label?: string;
  /** Раздел со значком: у витрин, где партнёра ждут отказы команды, — «требует внимания: N» */
  readonly mark?: AttentionMark;
}

export function ListingPicker({
  listings,
  value,
  onChange,
  t,
  lang,
  inSidebar = false,
  line = true,
  allLabel,
  label = t.pickListing,
  mark,
}: ListingPickerProps) {
  const id = useId();
  const current = listings.find((listing) => listing.id === value);
  if (listings.length < 2 || inSidebar) {
    if (!current || !line) return null;
    return (
      <p className="vitrina-line">
        <Icon name="hall" size={14} />
        <span className="vitrina-line-name">{current.name}</span>
        <span className="chip chip-cat">{categoryName(lang, current.categoryCode)}</span>
      </p>
    );
  }

  const options = [
    ...(allLabel ? [{ value: ALL, name: allLabel, category: null, attention: null }] : []),
    ...listings.map((listing) => ({
      value: listing.id,
      name: listing.name,
      category: categoryName(lang, listing.categoryCode),
      attention: attentionLine(listing, mark, t),
    })),
  ];
  const selected = value ?? (allLabel ? ALL : null);

  if (listings.length <= PILLS_MAX) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: переключатель витрин — группа кнопок, не форма
      <div className="pills vitrina-pills" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="pill vitrina-pill"
            aria-pressed={option.value === selected}
            onClick={() => onChange(option.value === ALL ? null : option.value)}
          >
            <span className="vitrina-name">{option.name}</span>
            {option.category ? <span className="vitrina-cat">{option.category}</span> : null}
            <AttentionLine text={option.attention} />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="vitrina-select">
      <Select
        id={id}
        label={label}
        value={selected}
        icon={<Icon name="hall" size={17} />}
        options={options.map((option) => ({
          value: option.value,
          label: [option.name, option.category, option.attention].filter(Boolean).join(" · "),
        }))}
        onChange={(picked) => onChange(picked === ALL ? null : picked)}
      />
    </div>
  );
}
