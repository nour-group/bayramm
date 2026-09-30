/* Связь: есть ли сеть и когда она вернулась. Общая для трёх приложений.

   Источник — события online и offline окна: браузер шлёт их, когда теряет и находит сеть.
   navigator.onLine — только начальное значение, и то если оно есть (в старых вебвью его
   нет — считаем, что сеть есть); по нему одному не решаем. Событий нет — баннер просто
   не появится, а экраны покажут свои ошибки с «Повторить».

   returns — сколько раз связь вернулась: загрузчики экранов (useAsync, useLoad) по нему
   повторяют запрос, который упал без сети. Баннер — живая область role="status": она есть
   на странице всегда, пустая, поэтому диктор замечает появившийся текст. Слов в наборе нет:
   тексты — пропсами. */

import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

export interface Connectivity {
  /** Сеть есть (по последнему событию; без событий — есть) */
  readonly online: boolean;
  /** Сколько раз за жизнь страницы связь вернулась: повод повторить упавшую загрузку */
  readonly returns: number;
}

const ALWAYS_ONLINE: Connectivity = { online: true, returns: 0 };

const ConnectivityContext = createContext<Connectivity>(ALWAYS_ONLINE);

function initiallyOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return typeof navigator.onLine === "boolean" ? navigator.onLine : true;
}

/** Слушает online и offline окна; без провайдера useConnectivity — «сеть есть» */
export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Connectivity>(() => ({ online: initiallyOnline(), returns: 0 }));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const offline = () => setState((prev) => (prev.online ? { ...prev, online: false } : prev));
    const online = () =>
      setState((prev) => (prev.online ? prev : { online: true, returns: prev.returns + 1 }));
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, []);

  return <ConnectivityContext.Provider value={state}>{children}</ConnectivityContext.Provider>;
}

export function useConnectivity(): Connectivity {
  return useContext(ConnectivityContext);
}

/**
 * Вызвать retry, когда связь вернулась (не при первом показе). Загрузчик сам решает,
 * повторять ли: обычно — только если прошлый запрос упал
 */
export function useOnReconnect(retry: () => void): void {
  const { returns } = useConnectivity();
  const latest = useRef(retry);
  latest.current = retry;
  const seen = useRef(returns);
  useEffect(() => {
    if (returns === seen.current) return;
    seen.current = returns;
    latest.current();
  }, [returns]);
}

export interface OfflineBannerProps {
  /** Нет связи */
  readonly offline: string;
  /** Связь вернулась: показывается ненадолго */
  readonly back: string;
  /** Сколько висит «связь вернулась», мс */
  readonly backMs?: number;
}

/** Полоса под шапкой: «нет связи», пока её нет, и коротко «связь вернулась» */
export function OfflineBanner({ offline, back, backMs = 4000 }: OfflineBannerProps) {
  const { online, returns } = useConnectivity();
  const [showBack, setShowBack] = useState(false);

  useEffect(() => {
    if (returns === 0) return;
    setShowBack(true);
    const timer = setTimeout(() => setShowBack(false), backMs);
    return () => clearTimeout(timer);
  }, [returns, backMs]);

  const text = online ? (showBack ? back : null) : offline;
  return (
    <div className="ui-net" role="status">
      {text ? <p className={online ? "ui-net-banner" : "ui-net-banner ui-net-off"}>{text}</p> : null}
    </div>
  );
}
