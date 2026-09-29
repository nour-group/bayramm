import type { ConsentText, CreateRequest, ListingDetail } from "@bayramm/shared/api";
import { isIsoDate, isPhoneDigits, PHONE_PREFIX, phoneDigits } from "../format";
import { sessionGetJson, sessionRemove, sessionSetJson } from "../storage";
import { parseGuests } from "./catalog-feed";

/* Черновик заявки. Живёт в хранилище вкладки, пока заявка не ушла: ни одно поле, включая
   комментарий, не теряется при уходе на другой экран и возврате (в прототипе комментарий
   пропадал). Согласия в черновик не пишутся — их отмечают заново, осознанно. */

export interface Draft {
  readonly occasion: string | null;
  readonly date: string | null;
  readonly guests: string;
  /** Индекс диапазона из BUDGETS; null — не указан */
  readonly budget: number | null;
  readonly name: string;
  readonly phone: string;
  readonly comment: string;
}

export const EMPTY_DRAFT: Draft = {
  occasion: null,
  date: null,
  guests: "",
  budget: null,
  name: "",
  phone: "",
  comment: "",
};

/** Диапазоны бюджета в порядке t.budgets; последний — «пока не знаю» (без бюджета) */
export const BUDGETS: readonly ({ readonly min?: number; readonly max?: number } | null)[] = [
  { max: 30_000_000 },
  { min: 30_000_000, max: 50_000_000 },
  { min: 50_000_000, max: 80_000_000 },
  { min: 80_000_000 },
  null,
];

/** Как у API (CONTACT_NAME_MAX) */
export const NAME_MAX = 80;
export const COMMENT_MAX = 1000;

const draftKey = (slug: string) => `bayramm.web.draft.${slug}`;

function isDraft(value: unknown): value is Draft {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  const optString = (v: unknown) => v === null || typeof v === "string";
  return (
    optString(d.occasion) &&
    optString(d.date) &&
    typeof d.guests === "string" &&
    (d.budget === null || (typeof d.budget === "number" && Number.isInteger(d.budget))) &&
    typeof d.name === "string" &&
    typeof d.phone === "string" &&
    typeof d.comment === "string"
  );
}

export const loadDraft = (slug: string): Draft | null => sessionGetJson(draftKey(slug), isDraft);
export const saveDraft = (slug: string, draft: Draft) => sessionSetJson(draftKey(slug), draft);
export const clearDraft = (slug: string) => sessionRemove(draftKey(slug));

export type Field = "occasion" | "date" | "guests" | "name" | "phone" | "consent";

/** Поля в порядке формы: к первой ошибке переводим фокус */
export const FIELDS: readonly Field[] = ["occasion", "date", "guests", "name", "phone", "consent"];

export interface ErrorTexts {
  readonly errOcc: string;
  readonly errDate: string;
  readonly errGuests: string;
  readonly errGuestsMax: (n: number) => string;
  readonly errRequired: string;
  readonly errPhone: string;
  readonly errConsent: string;
}

export function validate(
  draft: Draft,
  context: {
    readonly listing: Pick<ListingDetail, "capMax">;
    readonly busy: ReadonlySet<string>;
    readonly today: string;
    readonly transferChecked: boolean;
  },
  t: ErrorTexts,
): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  if (!draft.occasion) errors.occasion = t.errOcc;
  if (!isIsoDate(draft.date) || draft.date < context.today || context.busy.has(draft.date))
    errors.date = t.errDate;
  const guests = parseGuests(draft.guests);
  if (guests === null) errors.guests = t.errGuests;
  else if (guests > context.listing.capMax) errors.guests = t.errGuestsMax(context.listing.capMax);
  if (draft.name.trim().length === 0) errors.name = t.errRequired;
  if (!isPhoneDigits(phoneDigits(draft.phone))) errors.phone = t.errPhone;
  if (!context.transferChecked) errors.consent = t.errConsent;
  return errors;
}

/** Тело POST /requests из проверенного черновика */
export function toCreateRequest(
  draft: Draft,
  listing: Pick<ListingDetail, "id">,
  consents: { readonly transfer: ConsentText; readonly notify: ConsentText | null },
): CreateRequest {
  const budget = draft.budget === null ? null : (BUDGETS[draft.budget] ?? null);
  const comment = draft.comment.trim();
  return {
    listingId: listing.id,
    occasionCode: draft.occasion ?? "",
    eventDate: draft.date ?? "",
    guests: parseGuests(draft.guests) ?? 0,
    ...(budget?.min !== undefined ? { budgetMinUzs: budget.min } : {}),
    ...(budget?.max !== undefined ? { budgetMaxUzs: budget.max } : {}),
    contactName: draft.name.trim().slice(0, NAME_MAX),
    contactPhone: `${PHONE_PREFIX}${phoneDigits(draft.phone)}`,
    ...(comment ? { comment: comment.slice(0, COMMENT_MAX) } : {}),
    requestTransferConsentId: consents.transfer.id,
    ...(consents.notify ? { notifyConsentId: consents.notify.id } : {}),
  };
}
