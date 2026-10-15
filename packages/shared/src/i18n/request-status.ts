import type { RequestStatus } from "../api/client";
import type { Lang } from "./dict";

/* Статусы заявки — одним словом на статус и одинаково в клиенте, кабинете и панели: что видит
   клиент, то же видят партнёр и команда. С заглавной: это подпись чипа или строки истории.
   Кто сделал шаг, говорит не статус, а строка рядом («вы», «менеджер», «клиент»).
   Узбекский — латиница, ʻ (U+02BB) после o/g. */
export const REQUEST_STATUS_NAMES: Readonly<Record<Lang, Readonly<Record<RequestStatus, string>>>> = {
  ru: {
    new: "Новая",
    viewed: "Просмотрена",
    contacted: "Связались",
    deal: "Договорились",
    declined: "Отказ",
    withdrawn: "Отозвана",
    expired: "Дата прошла",
  },
  uz: {
    new: "Yangi",
    viewed: "Koʻrildi",
    contacted: "Bogʻlanildi",
    deal: "Kelishildi",
    declined: "Rad etildi",
    withdrawn: "Qaytarib olindi",
    expired: "Sana oʻtdi",
  },
};

/** Название статуса; неизвестный (новее сборки) — сам код, а не undefined */
export function requestStatusName(lang: Lang, status: string): string {
  const names: Readonly<Record<string, string>> = REQUEST_STATUS_NAMES[lang];
  return Object.hasOwn(names, status) ? (names[status] ?? status) : status;
}
