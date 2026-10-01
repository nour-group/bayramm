/* Ошибка API словами. У каждого кода, который кабинет может получить от API, — свой текст на
   обоих языках (err_<код> в словаре; список сверяет i18n.test.ts), чтобы человек видел, что
   случилось и что делать, а не «не удалось». Код без текста (новый в API, старая сборка) —
   общий «не удалось сохранить», сбой сервера — «ошибка на сервере». Коды загрузки фото —
   свои, короче (up_*, Venue.tsx). */

import { ApiFailure } from "./api";
import { textOf, type VendorDict } from "./i18n";

/** Коды ошибок API кабинета (errors.ts и BUSINESS_RULES API) — у каждого есть текст */
export const API_ERROR_CODES = [
  "network",
  "internal_error",
  "service_unavailable",
  "rate_limited",
  "unauthorized",
  "forbidden",
  "forbidden_for_actor",
  "vendor_owner_required",
  "vendor_disabled",
  "not_found",
  "invalid_input",
  "invalid_request",
  "payload_too_large",
  "illegal_transition",
  "moderated_field_requires_revision",
  "publish_blocked",
  "no_changes",
  "revision_pending",
  "too_many_services",
  "service_invalid",
  "service_not_allowed",
  "calendar_conflict",
  "date_out_of_range",
  "version_required",
  "listing_not_active",
  "reason_required",
  "immutable_column",
  "conflict",
  "rule_violation",
  "photo_ack_required",
] as const;

/** Текст ошибки действия: нет связи, код API или общий «не удалось» */
export function errorText(err: unknown, t: VendorDict): string {
  if (!(err instanceof ApiFailure)) return t.actionFailed;
  if (err.status === 0) return t.err_network;
  const key = `err_${err.code}`;
  const text = textOf(t, key);
  if (text !== key) return text;
  return err.status >= 500 ? t.err_internal_error : t.actionFailed;
}

/** Повторить, когда вернётся связь или чуть позже: запрос не дошёл, сбой сервера, лимит частоты */
export function isRetryable(error: unknown): boolean {
  return error instanceof ApiFailure
    ? error.status === 0 || error.status === 429 || error.status >= 500
    : true;
}
