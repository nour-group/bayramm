import type { MediaEnv } from "@bayramm/media";
import { type Dict, dictionaries, LANGS, type Lang } from "@bayramm/shared";
import type { Dictionaries, Localized } from "@bayramm/shared/api";
import type { TelegramWebApp } from "@bayramm/tg/webapp";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ClientApi } from "./api/types";
import { type AsyncResult, useAsync } from "./hooks";
import { sessionGet, sessionSet } from "./storage";

/**
 * Кто открыл приложение: telegram — Mini App с входом по initData; guest — обычный браузер,
 * каталог без заявок; demo — демо-API в разработке, заявки можно отправлять
 */
export type Identity = "telegram" | "guest" | "demo";

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

/** Можно ли отправлять заявки и смотреть свои: нужен вход через Telegram */
export const canSignIn = (identity: Identity) => identity !== "guest";

/* ---------- язык ---------- */

export const LANG_KEY = "bayramm.web.lang";
const isLang = (value: unknown): value is Lang => LANGS.includes(value as Lang);

/* Язык: выбор в этой вкладке → язык Telegram → язык браузера → узбекский (умолчание базы).
   Выбор живёт в sessionStorage; в профиль на сервере уйдёт, когда в API появится запись языка */
export function initialLang(webApp: TelegramWebApp | null): Lang {
  const saved = sessionGet(LANG_KEY);
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

interface LangValue {
  readonly lang: Lang;
  readonly t: Dict;
  readonly setLang: (lang: Lang) => void;
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

/* ---------- всё вместе ---------- */

export function AppProviders({ services, children }: { services: Services; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => initialLang(services.webApp));

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    sessionSet(LANG_KEY, next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const langValue = useMemo(() => ({ lang, t: dictionaries[lang], setLang }), [lang, setLang]);

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

  return (
    <ServicesContext.Provider value={services}>
      <LangContext.Provider value={langValue}>
        <DictionariesContext.Provider value={dictValue}>{children}</DictionariesContext.Provider>
      </LangContext.Provider>
    </ServicesContext.Provider>
  );
}
