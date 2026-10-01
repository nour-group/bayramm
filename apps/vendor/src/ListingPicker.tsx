/* Витрины вендора. У вендора их может быть несколько — по одной в каждой категории (зал и
   кортеж, студия и фото-видео): у каждой свои заявки, календарь, карточка и услуги. Выбранная
   витрина — одна на весь кабинет (App.tsx): её показывают календарь, площадка и услуги.

     · ListingPicker — переключатель на экране (телефон и планшет): пилюли с названием и
       категорией. Витрина одна или переключатель уже в боковой панели (компьютер) — вместо
       него строка «какая это витрина»;
     · VitrinaSwitch — тот же выбор в боковой панели компьютера. */

import type { VendorListingRef } from "@bayramm/shared/api/vendor";
import { categoryName } from "./category";
import type { VendorDict } from "./i18n";
import { Icon } from "./icons";

interface ListingPickerProps {
  readonly listings: readonly VendorListingRef[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
  /** Выбор — в боковой панели (компьютер): здесь только строка с витриной */
  readonly inSidebar?: boolean;
  /** Строка «какая это витрина» не нужна: экран сам называет витрину (площадка) */
  readonly line?: boolean;
}

export function ListingPicker({
  listings,
  value,
  onChange,
  t,
  lang,
  inSidebar = false,
  line = true,
}: ListingPickerProps) {
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
  return (
    // biome-ignore lint/a11y/useSemanticElements: переключатель витрин — группа кнопок, не форма
    <div className="pills vitrina-pills" role="group" aria-label={t.listingPicker}>
      {listings.map((listing) => (
        <button
          key={listing.id}
          type="button"
          className="pill vitrina-pill"
          aria-pressed={listing.id === value}
          onClick={() => onChange(listing.id)}
        >
          <span className="vitrina-name">{listing.name}</span>
          <span className="vitrina-cat">{categoryName(lang, listing.categoryCode)}</span>
        </button>
      ))}
    </div>
  );
}

interface VitrinaSwitchProps {
  readonly listings: readonly VendorListingRef[];
  readonly value: string | null;
  readonly onChange: (id: string) => void;
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
}

/** Витрины в боковой панели компьютера: одна — выбирать нечего, блока нет */
export function VitrinaSwitch({ listings, value, onChange, t, lang }: VitrinaSwitchProps) {
  if (listings.length < 2) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: переключатель витрин — группа кнопок, не форма
    <div className="side-vitrinas" role="group" aria-labelledby="side-vitrinas-title">
      <p className="side-title" id="side-vitrinas-title">
        {t.vitrinas}
      </p>
      {listings.map((listing) => (
        <button
          key={listing.id}
          type="button"
          className="side-vitrina"
          aria-pressed={listing.id === value}
          onClick={() => onChange(listing.id)}
        >
          <span className="vitrina-name">{listing.name}</span>
          <span className="vitrina-cat">{categoryName(lang, listing.categoryCode)}</span>
        </button>
      ))}
    </div>
  );
}
