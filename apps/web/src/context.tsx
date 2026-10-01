import type { MediaEnv } from "@bayramm/media";
import { type Dict, LANGS, type Lang } from "@bayramm/shared";
import type { Dictionaries, Localized } from "@bayramm/shared/api";
import type { Me } from "@bayramm/shared/api/me";
import type { TelegramWebApp } from "@bayramm/tg/webapp";
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ClientApi } from "./api/types";
import { type AsyncResult, useAsync } from "./hooks";
import { dictionary, loadDictionary } from "./i18n";
import { localGet, localSet, sessionGet, sessionSet } from "./storage";

/**
 * Кто открыл приложение: telegram — Mini App с входом по initData; site — обычный браузер
 * со входом в хабе (/auth); guest — обычный браузер без входа: каталог есть, заявок нет,
 * войти можно в хабе; demo — демо-API в разработке, заявки можно отправлять
 */
export type Identity = "telegram" | "site" | "guest" | "demo";

export interface Services {
  readonly api: ClientApi;
  readonly identity: Identity;
  readonly webApp: TelegramWebApp | null;
  readonly mediaEnv: MediaEnv;
  readonly now: () => number;
}

const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("ServicesContext не задан");
  return services;
}

/** Можно ли отправлять заявки и смотреть свои: нужен вход (Telegram или хаб на сайте) */
export const canSignIn = (identity: Identity) => identity !== "guest";

/* ---------- язык ---------- */

export const LANG_KEY = "bayramm.web.lang";
const isLang = (value: unknown): value is Lang => LANGS.includes(value as Lang);

/* Язык: выбор в этой вкладке → выбор в прошлые визиты (localStorage: гость без входа
   сохраняет язык между визитами) → язык Telegram → язык браузера → узбекский (умолчание
   базы). У вошедшего язык живёт ещё и в профиле (PATCH /me): по нему пишет бот, и при
   следующем открытии приложение возьмёт его оттуда — если в этой вкладке язык не выбирали */
export function initialLang(webApp: TelegramWebApp | null): Lang {
  const saved = sessionGet(LANG_KEY) ?? localGet(LANG_KEY);
  if (isLang(saved)) return saved;
  const candidates = [
    webApp?.initDataUnsafe.user?.language_code,
    ...(window.navigator.languages ?? [window.navigator.language]),
  ];
  for (const tag of candidates) {
    const code = tag?.slice(0, 2).toLowerCase();
    if (isLang(code)) return code;
  }
  return "uz";
}

/** Параметр языка в адресе: у языковых версий страниц для поисковиков (?lang=ru, ?lang=uz) */
export const LANG_PARAM = "lang";

/**
 * Язык из адреса (?lang=ru) — как выбор в переключателе: в эту вкладку и между визитами.
 * Параметр из адреса убирается (url меняется на месте); true — адрес изменился
 */
export function takeLangParam(url: URL): boolean {
  const value = url.searchParams.get(LANG_PARAM);
  if (value === null) return false;
  if (isLang(value)) {
    sessionSet(LANG_KEY, value);
    localSet(LANG_KEY, value);
  }
  url.searchParams.delete(LANG_PARAM);
  return true;
}

interface LangValue {
  readonly lang: Lang;
  readonly t: Dict;
  /** Сменить язык: его словарь ещё не загружен — сначала он, до того прежний язык */
  readonly setLang: (lang: Lang) => void;
  /** Язык, чей словарь сейчас грузится (выбрали в переключателе); null — ничего не ждём */
  readonly pendingLang: Lang | null;
}

const LangContext = createContext<LangValue | null>(null);

export function useLang(): LangValue {
  const value = useContext(LangContext);
  if (!value) throw new Error("LangContext не задан");
  return value;
}

/** Текст на текущем языке; пустой — на другом (описание могли заполнить только на одном) */
export function pick(value: Localized, lang: Lang): string {
  return value[lang] || value[lang === "ru" ? "uz" : "ru"];
}

/* ---------- справочники ---------- */

export interface DictionaryHelpers {
  readonly state: AsyncResult<Dictionaries>;
  districtName(code: string | null): string | null;
  occasionName(code: string): string | null;
}

const DictionariesContext = createContext<DictionaryHelpers | null>(null);

export function useDictionaries(): DictionaryHelpers {
  const value = useContext(DictionariesContext);
  if (!value) throw new Error("DictionariesContext не задан");
  return value;
}

/* ---------- свой аккаунт ---------- */

export interface AccountValue {
  /** Свой профиль (GET /me); у гостя без входа — null */
  readonly me: AsyncResult<Me | null>;
  /** Аккаунт удалён в этой вкладке: дальше приложение работает без входа */
  readonly deleted: boolean;
  readonly markDeleted: () => void;
}

const AccountContext = createContext<AccountValue | null>(null);

export function useAccount(): AccountValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error("AccountContext не задан");
  return value;
}

/* ---------- всё вместе ---------- */

export function AppProviders({
  services,
  lang: fixedLang,
  children,
}: {
  services: Services;
  /** Язык первого показа вместо выбранного в браузере: пререндер при сборке (prerender.tsx) */
  lang?: Lang;
  children: ReactNode;
}) {
  const [lang, setLangState] = useState<Lang>(() => fixedLang ?? initialLang(services.webApp));
  const [pendingLang, setPendingLang] = useState<Lang | null>(null);
  // Последний запрошенный язык: словарь, пришедший позже другого выбора, язык не меняет
  const wanted = useRef(lang);
  const [deleted, setDeleted] = useState(false);
  const signedIn = canSignIn(services.identity) && !deleted;
  const me = useAsync(signedIn ? "me" : "me:none", (signal) =>
    signedIn ? services.api.me(signal) : Promise.resolve(null),
  );
  const { replace: replaceMe } = me;
  const profile = me.status === "ready" ? me.data : null;

  /* Показать язык, когда его словарь на месте: уже загружен — сразу, иначе прежний язык
     остаётся, пока грузится второй (pendingLang), и только потом — после (done). Не
     загрузился (нет сети) — язык прежний, ничего не сломано; выбор можно повторить */
  const showLang = useCallback((next: Lang, done?: () => void) => {
    wanted.current = next;
    if (dictionary(next)) {
      setPendingLang(null);
      setLangState(next);
      done?.();
      return;
    }
    setPendingLang(next);
    loadDictionary(next).then(
      () => {
        if (wanted.current !== next) return;
        setPendingLang(null);
        setLangState(next);
        done?.();
      },
      () => {
        if (wanted.current === next) setPendingLang(null);
      },
    );
  }, []);

  // Язык из профиля — если в этой вкладке его не выбирали (выбор здесь главнее)
  useEffect(() => {
    if (profile && sessionGet(LANG_KEY) === null) showLang(profile.locale);
  }, [profile, showLang]);

  const setLang = useCallback(
    (next: Lang) => {
      showLang(next, () => {
        sessionSet(LANG_KEY, next);
        // Между визитами — и гостю, и вошедшему (после выхода язык останется тем же)
        localSet(LANG_KEY, next);
        if (!signedIn) return;
        // Не сохранилось — язык в этой вкладке всё равно сменился; бот пишет на прежнем
        services.api.updateMe({ locale: next }).then(replaceMe, () => {});
      });
    },
    [showLang, services.api, signedIn, replaceMe],
  );

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // Словарь первого языка загружает bootstrap до первого показа (тесты — test-setup.ts);
  // если всё же нет — ждём его здесь (use), а не показываем пустые строки
  const t = dictionary(lang) ?? use(loadDictionary(lang));
  const langValue = useMemo(() => ({ lang, t, setLang, pendingLang }), [lang, t, setLang, pendingLang]);

  const state = useAsync("dictionaries", (signal) => services.api.dictionaries(signal));
  const data = state.status === "ready" ? state.data : null;
  const dictValue = useMemo<DictionaryHelpers>(
    () => ({
      state,
      districtName: (code) => {
        const item = code ? data?.districts.find((d) => d.code === code) : undefined;
        return item ? pick(item.name, lang) : null;
      },
      occasionName: (code) => {
        const item = data?.occasions.find((o) => o.code === code);
        return item ? pick(item.name, lang) : null;
      },
    }),
    [state, data, lang],
  );

  const markDeleted = useCallback(() => setDeleted(true), []);
  const accountValue = useMemo<AccountValue>(
    () => ({ me, deleted, markDeleted }),
    [me, deleted, markDeleted],
  );

  return (
    <ServicesContext.Provider value={services}>
      <LangContext.Provider value={langValue}>
        <DictionariesContext.Provider value={dictValue}>
          <AccountContext.Provider value={accountValue}>{children}</AccountContext.Provider>
        </DictionariesContext.Provider>
      </LangContext.Provider>
    </ServicesContext.Provider>
  );
}
