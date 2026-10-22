/* Почему уведомление не дошло — словами и что делать. Причина в очереди — код отправителя
   (apps/api/src/notify/outbox.ts): «api 403: …» — ответ Telegram, «attempts_exhausted: …» —
   попытки кончились, «skipped: <причина>» — отправлять было некому. Повтор помогает, только
   когда сбой был временным (сеть, Telegram не отвечал) или сотрудник с тех пор написал боту;
   бот заблокирован, чата нет, получатель отключён — повтор не поможет, нужен звонок. */

import { t } from "./texts";

export interface DeliveryProblem {
  /** Что случилось и что делать — одной строкой */
  readonly text: string;
  /** Повтор может помочь */
  readonly retry: boolean;
  /** Повтор не поможет — дозвониться: кому (у пользователя кабинета — вендору) */
  readonly call: boolean;
}

const SKIPPED: Readonly<Record<string, { text: string; retry: boolean; call: boolean }>> = {
  vendor_user_unlinked: { text: t.delivery.unlinked, retry: false, call: true },
  client_not_notifiable: { text: t.delivery.clientOff, retry: false, call: false },
  staff_no_chat: { text: t.delivery.staffNoChat, retry: true, call: false },
  staff_inactive: { text: t.delivery.staffInactive, retry: false, call: false },
  not_found: { text: t.delivery.gone, retry: false, call: false },
  no_recipient: { text: t.delivery.gone, retry: false, call: false },
};

export function deliveryProblem(error: string | null): DeliveryProblem {
  if (error === null || error.trim() === "") return { text: t.delivery.unknown, retry: true, call: false };
  const skipped = /^skipped: ([a-z_]+)/.exec(error);
  if (skipped) return SKIPPED[skipped[1] ?? ""] ?? { text: t.delivery.notSent, retry: false, call: false };
  const exhausted = error.startsWith("attempts_exhausted");
  const api = /\bapi (\d{3})(?::\s*(.*))?/.exec(error);
  const status = api ? Number(api[1]) : 0;
  const description = (api?.[2] ?? "").toLowerCase();
  if (status === 403)
    return description.includes("deactivated")
      ? { text: t.delivery.deactivated, retry: false, call: true }
      : { text: t.delivery.blocked, retry: false, call: true };
  if (status === 400)
    return description.includes("chat not found")
      ? { text: t.delivery.noChat, retry: false, call: true }
      : { text: t.delivery.rejected, retry: false, call: false };
  if (exhausted || status >= 500 || /\b(network|timeout|bad_response)\b/.test(error))
    return { text: t.delivery.unreachable, retry: true, call: false };
  return { text: t.delivery.unknown, retry: true, call: false };
}
