import type { VendorAttention, VendorListingRef } from "@bayramm/shared/api/vendor";

/* Значки «что ждёт партнёра»: числа приходят с GET /vendor/me по каждой витрине
   (VendorListingRef.attention), здесь они собираются под разделы кабинета.
     «Витрина»  — отклонённые фото и отклонённое предложение изменений;
     «Услуги»   — отклонённые услуги.
   У сотрудника площадки числа нулевые: исправляет владелец. */

/** Разделы кабинета, у которых бывает значок «требует внимания» */
export type AttentionMark = "card" | "services";

export const ATTENTION_MARKS: readonly AttentionMark[] = ["card", "services"];

/** Сколько на этой витрине ждёт партнёра в разделе */
export const attentionOf = (attention: VendorAttention, mark: AttentionMark): number =>
  mark === "card" ? attention.photos + attention.proposals : attention.services;

/** Всего в разделе по всем витринам: значок раздела, как значок «Заявок» — по всем витринам */
export function attentionTotals(
  listings: readonly VendorListingRef[],
): Readonly<Record<AttentionMark, number>> {
  const total = { card: 0, services: 0 };
  for (const listing of listings) {
    for (const mark of ATTENTION_MARKS) total[mark] += attentionOf(listing.attention, mark);
  }
  return total;
}

/**
 * Свежий ответ GET /vendor/me → витрины для экрана. Ничего не изменилось (имя, статус,
 * значки) — прежний массив: экраны не перерисовываются и не перечитывают данные зря
 */
export function mergeListings(
  current: readonly VendorListingRef[],
  fresh: readonly VendorListingRef[],
): readonly VendorListingRef[] {
  const same =
    current.length === fresh.length &&
    current.every((listing, i) => {
      const next = fresh[i];
      return (
        next !== undefined &&
        listing.id === next.id &&
        listing.name === next.name &&
        listing.status === next.status &&
        listing.categoryCode === next.categoryCode &&
        listing.attention.services === next.attention.services &&
        listing.attention.photos === next.attention.photos &&
        listing.attention.proposals === next.attention.proposals
      );
    });
  return same ? current : fresh;
}
