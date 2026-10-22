import { isIsoDate, isPhoneDigits, phoneDigits } from "../format";
import { matchRoute } from "../routes";
import { sessionGet, sessionGetJson, sessionRemove, sessionSet, sessionSetJson } from "../storage";

/* Следующая заявка — без повторного ввода: имя, телефон и повод из последней заявки, ушедшей в
   этой вкладке. Живут, как черновик, только во вкладке (sessionStorage): ключ — под префиксом
   черновиков, поэтому удаление аккаунта (clearDrafts) стирает и его. Дата и гости приходят
   из адреса (каталог → витрина → форма), а без них в адресе — тоже из прошлой заявки (зал
   выбирают несколькими заявками на один день). Согласия не подставляются никогда — их отмечают
   заново, осознанно.

   Гость сайта заполняет форму до входа: «Отправить» проверяет поля и уводит во вход, а метка
   «отправить после входа» (тоже во вкладке) говорит форме, вернувшись, что остался один шаг —
   согласие и «Отправить». */

/** Под префиксом черновиков (request-draft.ts, «bayramm.web.draft.»): «_» в slug не бывает */
const LAST_KEY = "bayramm.web.draft._last";
const PENDING_PREFIX = "bayramm.web.draft._send.";
/** Черновик формы витрины (request-draft.ts): хабу из него нужен только телефон */
const DRAFT_PREFIX = "bayramm.web.draft.";

const hasPhone = (value: unknown): value is { readonly phone: string } =>
  typeof value === "object" && value !== null && typeof (value as { phone?: unknown }).phone === "string";

export interface LastRequest {
  readonly name: string;
  /** 9 цифр после +998 */
  readonly phone: string;
  readonly occasion: string | null;
  /** День мероприятия, ГГГГ-ММ-ДД; у записей старой вкладки нет */
  readonly date?: string | null;
  readonly guests?: number | null;
}

const optional = (v: unknown, type: "string" | "number") =>
  v === undefined || v === null || typeof v === type;

const isLastRequest = (value: unknown): value is LastRequest => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.phone === "string" &&
    (v.occasion === null || typeof v.occasion === "string") &&
    optional(v.date, "string") &&
    optional(v.guests, "number")
  );
};

/** Запомнить контакты, повод, день и гостей ушедшей заявки — для следующей в этой вкладке */
export function rememberLastRequest(last: LastRequest): void {
  sessionSetJson(LAST_KEY, {
    name: last.name.trim(),
    phone: isPhoneDigits(phoneDigits(last.phone)) ? phoneDigits(last.phone) : "",
    occasion: last.occasion,
    date: isIsoDate(last.date) ? last.date : null,
    guests: Number.isInteger(last.guests) && (last.guests ?? 0) > 0 ? (last.guests ?? null) : null,
  } satisfies LastRequest);
}

/** Контакты и повод последней заявки этой вкладки; не было — null */
export const lastRequest = (): LastRequest | null => sessionGetJson(LAST_KEY, isLastRequest);

/**
 * Гость нажал «Отправить»: после входа форма этой витрины скажет, что остался один шаг. В метке —
 * имя витрины: хаб входа говорит, какая заявка ждёт («Отправка заявки в «…»»)
 */
export const markSendAfterSignIn = (slug: string, name: string): void =>
  sessionSet(`${PENDING_PREFIX}${slug}`, name.trim() || slug);

/** Вернулись из входа с неотправленной заявкой? Метка — одноразовая */
export function takeSendAfterSignIn(slug: string): boolean {
  const key = `${PENDING_PREFIX}${slug}`;
  const pending = sessionGet(key) !== null;
  if (pending) sessionRemove(key);
  return pending;
}

/** Заявка, которая ждёт входа: витрина, её имя, телефон из черновика и путь назад к форме */
export interface PendingSend {
  readonly slug: string;
  /** null — метка прежней вкладки, без имени */
  readonly name: string | null;
  /** 9 цифр после +998 из черновика; нет — "" */
  readonly phone: string;
  /** Форма заявки — куда хаб вернёт после входа */
  readonly href: string;
}

/** Хаб входа: путь возврата — форма заявки, у её витрины метка «отправить после входа» */
export function pendingSend(returnPath: string | null): PendingSend | null {
  if (!returnPath) return null;
  const pathname = returnPath.split("?")[0] ?? "";
  const match = matchRoute(pathname);
  if (match?.name !== "request") return null;
  const name = sessionGet(`${PENDING_PREFIX}${match.slug}`);
  if (name === null) return null;
  const draftPhone = phoneDigits(sessionGetJson(`${DRAFT_PREFIX}${match.slug}`, hasPhone)?.phone ?? "");
  return {
    slug: match.slug,
    name: name === "1" ? null : name,
    phone: isPhoneDigits(draftPhone) ? draftPhone : "",
    href: returnPath,
  };
}
