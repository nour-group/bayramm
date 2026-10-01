import type {
  CatalogCategories,
  CatalogPage,
  CatalogQuery,
  ConsentTexts,
  Dictionaries,
  ListingDetail,
} from "@bayramm/shared/api";
import type { AuthMethods } from "@bayramm/shared/api/account";
import type { ApiPeek, BotInfo, ClientApi } from "./types";

/* Кэш публичных GET во вкладке, поверх любого ClientApi (bootstrap: настоящий и демо).

   · Один запрос на всех: экран спрашивает одно и то же из нескольких мест (категории —
     сетка и витрины лендинга, бот — меню и подвал, способы входа — меню и блок партнёра),
     пока ответ в пути, второй вызов получает тот же промис.
   · Повтор в пределах срока — без запроса: «назад» из витрины в каталог, витрина → форма
     заявки (та же карточка), наведение на карточку в каталоге (её витрина грузится заранее).
     peek отдаёт уже готовый ответ без промиса — экран рисуется сразу, без заглушки.

   Сроки короткие: занятость и цены меняются, но не за минуту. Личное — заявки, профиль,
   избранное — не кэшируется. Тексты согласий — на пять минут (витрина просит их заранее для
   формы заявки): их версию сервер всё равно сверяет при отправке, а на «текст сменился»
   форма забывает их (forgetConsentTexts) и перечитывает. Ошибка в кэше не остаётся:
   «Повторить» спросит заново. Отмена одного из ждущих (экран ушёл) не отменяет общий
   запрос — его ответ нужен остальным и следующему заходу. */

const MINUTE = 60_000;

/** Сколько живёт ответ, мс */
export const CACHE_TTL = {
  dictionaries: 30 * MINUTE,
  catalogCategories: 5 * MINUTE,
  bot: 60 * MINUTE,
  authMethods: 10 * MINUTE,
  listing: MINUTE,
  catalog: MINUTE,
  consentTexts: 5 * MINUTE,
} as const;

/** Больше записей не держим: старые вытесняются (выдача по разным фильтрам копится) */
const MAX_ENTRIES = 60;

interface Entry {
  readonly at: number;
  readonly promise: Promise<unknown>;
  settled: boolean;
  value?: unknown;
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/** Ждать общий промис, но отпустить этого ждущего по его сигналу отмены */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Ключ выдачи: одинаковые параметры в любом порядке — один ключ, пустые не в счёт */
export function catalogKey(query: CatalogQuery): string {
  const flat: Record<string, unknown> = { ...query, filters: undefined, ...query.filters };
  const keys = Object.keys(flat)
    .filter((key) => flat[key] !== undefined && flat[key] !== null && flat[key] !== "")
    .sort();
  return `catalog:${keys.map((key) => `${key}=${String(flat[key])}`).join("&")}`;
}

export function withCache(api: ClientApi, now: () => number = Date.now): ClientApi {
  const entries = new Map<string, Entry>();

  const fresh = (key: string, ttl: number): Entry | undefined => {
    const entry = entries.get(key);
    return entry && now() - entry.at <= ttl ? entry : undefined;
  };

  function cached<T>(key: string, ttl: number, load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let entry = fresh(key, ttl);
    if (!entry) {
      const promise = load();
      const created: Entry = { at: now(), promise, settled: false };
      entry = created;
      promise.then(
        (value) => {
          created.settled = true;
          created.value = value;
        },
        () => {
          if (entries.get(key) === created) entries.delete(key);
        },
      );
      entries.delete(key);
      entries.set(key, created);
      if (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    }
    return abortable(entry.promise as Promise<T>, signal);
  }

  function peekValue<T>(key: string, ttl: number): T | undefined {
    const entry = fresh(key, ttl);
    return entry?.settled ? (entry.value as T) : undefined;
  }

  const peek: ApiPeek = {
    listing: (slug) => peekValue<ListingDetail>(`listing:${slug}`, CACHE_TTL.listing),
    catalog: (query) => peekValue<CatalogPage>(catalogKey(query), CACHE_TTL.catalog),
    catalogCategories: () => peekValue<CatalogCategories>("categories", CACHE_TTL.catalogCategories),
    consentTexts: (locale) => peekValue<ConsentTexts>(`consents:${locale}`, CACHE_TTL.consentTexts),
    forgetConsentTexts: () => {
      for (const key of [...entries.keys()]) if (key.startsWith("consents:")) entries.delete(key);
    },
  };

  return {
    ...api,
    peek,
    dictionaries: (signal) =>
      cached<Dictionaries>("dictionaries", CACHE_TTL.dictionaries, () => api.dictionaries(), signal),
    catalogCategories: (signal) =>
      cached<CatalogCategories>(
        "categories",
        CACHE_TTL.catalogCategories,
        () => api.catalogCategories(),
        signal,
      ),
    bot: (signal) => cached<BotInfo>("bot", CACHE_TTL.bot, () => api.bot(), signal),
    authMethods: (signal) =>
      cached<AuthMethods>("auth-methods", CACHE_TTL.authMethods, () => api.authMethods(), signal),
    listing: (slug, signal) =>
      cached<ListingDetail>(`listing:${slug}`, CACHE_TTL.listing, () => api.listing(slug), signal),
    catalog: (query, signal) =>
      cached<CatalogPage>(catalogKey(query), CACHE_TTL.catalog, () => api.catalog(query), signal),
    consentTexts: (locale, signal) =>
      cached<ConsentTexts>(
        `consents:${locale}`,
        CACHE_TTL.consentTexts,
        () => api.consentTexts(locale),
        signal,
      ),
  };
}
