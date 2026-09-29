/* Выбор площадки, если их у вендора несколько. Одна — выбирать нечего, ничего не показываем. */

import type { VendorListingRef } from "@bayramm/shared/api/vendor";
import type { VendorDict } from "./i18n";

interface ListingPickerProps {
  readonly listings: readonly VendorListingRef[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  readonly t: VendorDict;
}

export function ListingPicker({ listings, value, onChange, t }: ListingPickerProps) {
  if (listings.length < 2) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: переключатель площадок — группа кнопок, не форма
    <div className="pills" role="group" aria-label={t.listingPicker}>
      {listings.map((listing) => (
        <button
          key={listing.id}
          type="button"
          className="pill"
          aria-pressed={listing.id === value}
          onClick={() => onChange(listing.id)}
        >
          {listing.name}
        </button>
      ))}
    </div>
  );
}
