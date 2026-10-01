import { getWebApp, loadTelegramWebApp, type TelegramWebApp } from "@bayramm/tg/webapp";
import { ConnectivityProvider, OfflineBanner, UiTextsProvider } from "@bayramm/ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApi, type Session, SessionContext } from "./api";
import { Login } from "./Login";
import { parseView, ROUTES } from "./router";
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
  /** back — экран, на который вернуться после входа (сессия кончилась посреди работы) */
  | { kind: "signedOut"; error: SignInError | null; back?: string }
  | { kind: "signedIn"; staff: Staff; token: string };

/**
 * Сессия сотрудника по initData Mini App — заново, без страницы входа: Telegram подписывает
 * initData при каждом открытии, а сессия панели живёт 12 часов
 */
async function viaWebApp(webApp: TelegramWebApp): Promise<Auth> {
  const result = await signInWebApp(webApp.initData);
  if (!result.ok) return { kind: "signedOut", error: result.error };
  tokenStore.set(result.token);
  const staff = await fetchStaff(result.token);
  if (staff === "unavailable") return { kind: "signedOut", error: "unavailable" };
  if (staff === null) {
    tokenStore.clear();
    return { kind: "signedOut", error: "denied" };
  }
  return { kind: "signedIn", staff, token: result.token };
}

/**
 * Сессия при открытии панели:
 *   · /auth/callback — возврат из хаба входа: код → сессия сотрудника;
 *   · панель открыта в Telegram (кнопка бота) — SDK: готовность, во весь экран, цвета; без
 *     сохранённого токена — вход по initData;
 *   · сохранённый токен;
 *   · ?signin=1 (пришли из другого приложения Bayramm) — сразу в хаб.
 */
async function restore(): Promise<Auth> {
  let webApp: TelegramWebApp | null = null;
  if (window.location.pathname === CALLBACK_PATH) {
    const search = window.location.search;
    // Одноразовый код и state — не в истории: убираем до запросов
    window.history.replaceState(null, "", ROUTES.login);
    const result = await finishHub(search);
    if (!result.ok) return { kind: "signedOut", error: result.error };
    tokenStore.set(result.token);
    // Только свой экран панели (раздел или страница объекта) — не чужой адрес
    if (result.back && parseView(new URL(result.back, window.location.origin).pathname)) {
      window.history.replaceState(null, "", result.back);
    }
  } else {
    // SDK — только если панель открыл Telegram (кнопка бота): обычный браузер его не грузит.
    // И с сохранённым токеном: «назад», цвета и безопасные зоны нужны Mini App всегда
    webApp = await loadTelegramWebApp();
    if (webApp?.initData) initTelegram(webApp);
    if (tokenStore.get() === null) {
      if (webApp?.initData) return viaWebApp(webApp);
      if (new URLSearchParams(window.location.search).has(SIGNIN_PARAM)) {
        if (await startHub(backPath())) return { kind: "checking" };
      }
    }
  }

  const token = tokenStore.get();
  if (!token) return { kind: "signedOut", error: null };
  const staff = await fetchStaff(token);
  if (staff === "unavailable") return { kind: "signedOut", error: "unavailable" };
  if (staff === null) {
    // Сохранённый вход больше не действует (12 часов прошло, сессию отозвали): в Telegram —
    // заново по initData, в браузере — страница входа с объяснением и тем же экраном после
    tokenStore.clear();
    if (webApp?.initData) return viaWebApp(webApp);
    return { kind: "signedOut", error: "expired", back: backPath() };
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

  const back = auth.kind === "signedOut" ? auth.back : undefined;
  const onSignIn = useCallback(() => startHub(back ?? backPath()), [back]);

  const onSignOut = useCallback(() => {
    if (auth.kind !== "signedIn") return;
    tokenStore.clear();
    void signOut(auth.token);
    window.history.replaceState(null, "", ROUTES.login);
    setAuth({ kind: "signedOut", error: null });
  }, [auth]);

  // Сессия кончилась посреди работы (401). В Telegram — сразу новая по initData: экран и
  // вписанное в формы остаются, повторить действие можно сразу. В браузере — страница входа
  // с объяснением; после входа — тот же экран. Ответы 401 приходят пачкой: решает первый,
  // остальные (и запоздавшие ответы на старый токен) — уже не про текущую сессию
  const onExpired = useCallback((expired: string) => {
    if (tokenStore.get() !== expired) return;
    tokenStore.clear();
    const webApp = getWebApp();
    if (webApp?.initData) {
      void viaWebApp(webApp).then((next) => {
        if (next.kind !== "signedIn") window.history.replaceState(null, "", ROUTES.login);
        setAuth(next);
      });
      return;
    }
    const back = backPath();
    window.history.replaceState(null, "", ROUTES.login);
    setAuth({ kind: "signedOut", error: "expired", back });
  }, []);

  const token = auth.kind === "signedIn" ? auth.token : null;
  const staff = auth.kind === "signedIn" ? auth.staff : null;
  const session = useMemo<Session | null>(
    () => (token && staff ? { api: createApi(token, () => onExpired(token)), staff } : null),
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

/** Куда вернуться после входа: экран, с которого ушли, — раздел или страница объекта */
function backPath(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete(SIGNIN_PARAM);
  return parseView(url.pathname) ? `${url.pathname}${url.search}` : "/";
}

/** Подписи кнопок своих контролов: крестик шторки, очистка поиска */
const UI_TEXTS = { close: t.close, clear: t.clear };
