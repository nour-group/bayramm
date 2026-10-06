import type { VendorListingRef } from "@bayramm/shared/api/vendor";
import { type AttentionMark, attentionOf } from "./attention";
import { fill, type VendorDict } from "./i18n";
import { Icon } from "./icons";

/* «Требует внимания» у витрины в выборе витрины (список в боковой панели, пилюли, список выбора):
   партнёр видит, на какой из витрин его ждут отказы команды. */

/** «требует внимания: N» у витрины в выборе; нечего исправлять — null */
export function attentionLine(
  listing: VendorListingRef,
  mark: AttentionMark | undefined,
  t: VendorDict,
): string | null {
  const n = mark === undefined ? 0 : attentionOf(listing.attention, mark);
  return n > 0 ? fill(t.attentionCount, { n }) : null;
}

/** Строка «требует внимания» под названием витрины: иконка и слова, не только цвет */
export function AttentionLine({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <span className="vitrina-attn">
      <Icon name="warning" size={12} />
      {text}
    </span>
  );
}
