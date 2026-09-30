import { loadTelegramWebApp } from "@bayramm/tg/webapp";
import { ConnectivityProvider, OfflineBanner, UiTextsProvider } from "@bayramm/ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApi, type Session, SessionContext } from "./api";
import { Login } from "./Login";
import { matchRoute, ROUTES } from "./router";
import { Shell } from "./Shell";
import {
  CALLBACK_PATH,
  fetchStaff,
  finishHub,
  SIGNIN_PARAM,
  type SignInError,
  type Staff,
  signInWebApp,
  signOut,
  startHub,
  tokenStore,
} from "./session";
import { initTelegram } from "./telegram";
import { t } from "./texts";

type Auth =
  | { kind: "checking" }
  | { kind: "signedOut"; error: SignInError | null }
  | { kind: "signedIn"; staff: Staff; token: string };

/**
 * Сессия при открытии панели:
 *   · /auth/callback — возврат из хаба входа: код → сессия сотрудника;
 *   · панель открыта в Telegram (кнопка бота) — SDK: готовность, во весь экран, цвета; без
 *     сохранённого токена — вход по initData;
 *   · сохранённый токен;
 *   · ?signin=1 (пришли из другого приложения Bayramm) — сразу в хаб.
 */
async function restore(): Promise<Auth> {
  if (window.location.pathname === CALLBACK_PATH) {
    const search = window.location.search;
    // Одноразовый код и state — не в истории: убираем до запросов
    window.history.replaceState(null, "", ROUTES.login);
    const result = await finishHub(search);
    if (!result.ok) return { kind: "signedOut", error: result.error };
    tokenStore.set(result.token);
    if (result.back && matchRoute(new URL(result.back, window.location.origin).pathname)) {
      window.history.replaceState(null, "", result.back);
    }
  } else {
    // SDK — только если панель открыл Telegram (кнопка бота): обычный браузер его не грузит.
    // И с сохранённым токеном: «назад», цвета и безопасные зоны нужны Mini App всегда
    const webApp = await loadTelegramWebApp();
    if (webApp?.initData) initTelegram(webApp);
    if (tokenStore.get() === null) {
      if (webApp?.initData) {
        const result = await signInWebApp(webApp.initData);
        if (!result.ok) return { kind: "signedOut", error: result.error };
        tokenStore.set(result.token);
      } else if (new URLSearchParams(window.location.search).has(SIGNIN_PARAM)) {
        if (await startHub(backPath())) return { kind: "checking" };
      }
    }
  }

  const token = tokenStore.get();
  if (!token) return { kind: "signedOut", error: null };
  const staff = await fetchStaff(token);
  if (staff === "unavailable") return { kind: "signedOut", error: "unavailable" };
  if (staff === null) {
    tokenStore.clear();
    return { kind: "signedOut", error: null };
  }
  return { kind: "signedIn", staff, token };
}

export function App() {
  const [auth, setAuth] = useState<Auth>({ kind: "checking" });
  // StrictMode в разработке запускает эффект дважды: второй раз ждём тот же вход, а не шлём
  // данные виджета повторно (ref переживает этот перезапуск эффекта)
  const restoring = useRef<Promise<Auth> | null>(null);

  useEffect(() => {
    let active = true;
    restoring.current ??= restore();
    restoring.current.then((next) => {
      if (!active) return;
      // Не вошли — адрес страницы входа, чтобы после «Войти» и обновления было понятно, где мы
      if (next.kind === "signedOut" && window.location.pathname !== ROUTES.login) {
        window.history.replaceState(null, "", ROUTES.login);
      }
      setAuth(next);
    });
    return () => {
      active = false;
    };
  }, []);

  const onSignIn = useCallback(() => startHub(backPath()), []);

  const onSignOut = useCallback(() => {
    if (auth.kind !== "signedIn") return;
    tokenStore.clear();
    void signOut(auth.token);
    window.history.replaceState(null, "", ROUTES.login);
    setAuth({ kind: "signedOut", error: null });
  }, [auth]);

  // Сессия кончилась посреди работы (401) — на страницу входа, токен стираем
  const onExpired = useCallback(() => {
    tokenStore.clear();
    window.history.replaceState(null, "", ROUTES.login);
    setAuth({ kind: "signedOut", error: null });
  }, []);

  const token = auth.kind === "signedIn" ? auth.token : null;
  const staff = auth.kind === "signedIn" ? auth.staff : null;
  const session = useMemo<Session | null>(
    () => (token && staff ? { api: createApi(token, onExpired), staff } : null),
    [token, staff, onExpired],
  );

  return (
    <ConnectivityProvider>
      <UiTextsProvider texts={UI_TEXTS}>
        {/* Нет связи — полоса над панелью; упавшие загрузки повторятся, когда она вернётся */}
        <OfflineBanner offline={t.offline} back={t.backOnline} />
        {session && staff ? (
          <SessionContext.Provider value={session}>
            <Shell staff={staff} token={token ?? ""} onSignOut={onSignOut} />
          </SessionContext.Provider>
        ) : (
          <Login
            checking={auth.kind === "checking"}
            error={auth.kind === "signedOut" ? auth.error : null}
            onSignIn={onSignIn}
          />
        )}
      </UiTextsProvider>
    </ConnectivityProvider>
  );
}

/** Куда вернуться после входа: экран, с которого ушли (не страница входа) */
function backPath(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete(SIGNIN_PARAM);
  const route = matchRoute(url.pathname);
  return route && route !== "login" && route !== "authCallback" ? `${url.pathname}${url.search}` : "/";
}

/** Подписи кнопок своих контролов: крестик шторки, очистка поиска */
const UI_TEXTS = { close: t.close, clear: t.clear };
