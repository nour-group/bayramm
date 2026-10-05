/* Выбор витрины на экране (телефон и планшет). У вендора витрин бывает несколько — по одной в
   каждой категории (зал и кортеж, студия и фото-видео): у каждой свои заявки, календарь,
   данные и услуги. Выбранная витрина — одна на весь кабинет (App.tsx): её показывают
   календарь, витрина и услуги; во входящих есть ещё «Все витрины».

   Два варианта — две пилюли на всю ширину, оба видны сразу. Больше — список выбора
   (Select набора: на телефоне — шторка): пилюли уходили за край экрана, и о третьей витрине
   никто не догадывался. Витрина одна или выбор — в боковой панели (компьютер, SideVitrinas.tsx) —
   вместо выбора строка «какая это витрина». */

import type { VendorListingRef } from "@bayramm/shared/api/vendor";
import { Select } from "@bayramm/ui/react";
import { useId } from "react";
import { categoryName } from "./category";
import type { VendorDict } from "./i18n";
import { Icon } from "./icons";

/** Значение «все витрины» во входящих (у Select значение — строка) */
const ALL = "all";

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
  /** Подпись выбора и имя группы для диктора: «Выберите витрину», «Заявки какой витрины» */
  readonly label?: string;
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
    ...(allLabel ? [{ value: ALL, name: allLabel, category: null }] : []),
    ...listings.map((listing) => ({
      value: listing.id,
      name: listing.name,
      category: categoryName(lang, listing.categoryCode),
    })),
  ];
  const selected = value ?? (allLabel ? ALL : null);

  if (options.length === 2) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: переключатель витрин — группа кнопок, не форма
      <div className="pills vitrina-pills vitrina-pills-two" role="group" aria-label={label}>
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
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="vitrina-select">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <Select
        id={id}
        label={label}
        value={selected}
        icon={<Icon name="hall" size={17} />}
        options={options.map((option) => ({
          value: option.value,
          label: option.category ? `${option.name} · ${option.category}` : option.name,
        }))}
        onChange={(picked) => onChange(picked === ALL ? null : picked)}
      />
    </div>
  );
}
