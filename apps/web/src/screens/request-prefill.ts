import { isPhoneDigits, phoneDigits } from "../format";
import { sessionGet, sessionGetJson, sessionRemove, sessionSet, sessionSetJson } from "../storage";

/* Следующая заявка — без повторного ввода: имя, телефон и повод из последней заявки, ушедшей в
   этой вкладке. Живут, как черновик, только во вкладке (sessionStorage): ключ — под префиксом
   черновиков, поэтому удаление аккаунта (clearDrafts) стирает и его. Дата и гости приходят
   из адреса (каталог → витрина → форма). Согласия не подставляются никогда — их отмечают
   заново, осознанно.

   Гость сайта заполняет форму до входа: «Отправить» проверяет поля и уводит во вход, а метка
   «отправить после входа» (тоже во вкладке) говорит форме, вернувшись, что остался один шаг —
   согласие и «Отправить». */

/** Под префиксом черновиков (request-draft.ts, «bayramm.web.draft.»): «_» в slug не бывает */
const LAST_KEY = "bayramm.web.draft._last";
const PENDING_PREFIX = "bayramm.web.draft._send.";

export interface LastRequest {
  readonly name: string;
  /** 9 цифр после +998 */
  readonly phone: string;
  readonly occasion: string | null;
}

const isLastRequest = (value: unknown): value is LastRequest => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.phone === "string" &&
    (v.occasion === null || typeof v.occasion === "string")
  );
};

/** Запомнить контакты и повод ушедшей заявки — для следующей в этой вкладке */
export function rememberLastRequest(last: LastRequest): void {
  sessionSetJson(LAST_KEY, {
    name: last.name.trim(),
    phone: isPhoneDigits(phoneDigits(last.phone)) ? phoneDigits(last.phone) : "",
    occasion: last.occasion,
  } satisfies LastRequest);
}

/** Контакты и повод последней заявки этой вкладки; не было — null */
export const lastRequest = (): LastRequest | null => sessionGetJson(LAST_KEY, isLastRequest);

/** Гость нажал «Отправить»: после входа форма этой витрины скажет, что остался один шаг */
export const markSendAfterSignIn = (slug: string): void => sessionSet(`${PENDING_PREFIX}${slug}`, "1");

/** Вернулись из входа с неотправленной заявкой? Метка — одноразовая */
export function takeSendAfterSignIn(slug: string): boolean {
  const key = `${PENDING_PREFIX}${slug}`;
  const pending = sessionGet(key) === "1";
  if (pending) sessionRemove(key);
  return pending;
}
