import type { StaffDictionaries } from "@bayramm/shared/api/staff";
import { getWebApp, loadTelegramWebApp } from "@bayramm/tg/webapp";
import { ConnectivityProvider, OfflineBanner, UiTextsProvider } from "@bayramm/ui/react";
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApi, type Session, SessionContext, useLoad } from "./api";
import { Login } from "./Login";
import { AuditPage } from "./pages/Audit";
import { ClientPage, ClientsPage } from "./pages/Clients";
import { ListingNewPage, ListingPage } from "./pages/Listing";
import { ModerationPage } from "./pages/Moderation";
import { NotificationsPage } from "./pages/Notifications";
import { RequestPage, RequestsPage } from "./pages/Requests";
import { RevisionPage } from "./pages/Revision";
import { SettingsPage } from "./pages/Settings";
import { TeamPage } from "./pages/Team";
import { VendorNewPage, VendorPage } from "./pages/Vendor";
import { VendorsPage } from "./pages/Vendors";
import {
  HOME,
  matchRoute,
  NAV,
  pathOf,
  ROUTES,
  SECTION_PERMISSION,
  sectionOf,
  useRoute,
  type View,
} from "./router";
import {
  CALLBACK_PATH,
  fetchAccount,
  fetchMethods,
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
import { t } from "./texts";
import { Link, NavigateContext, TitleContext } from "./ui";

/** Заголовок экрана: раздел — его название, страница объекта — вид объекта */
export function titleOf(view: View | null): string {
  if (!view) return t.notFound;
  switch (view.name) {
    case "vendorNew":
    case "vendor":
    case "listingNew":
    case "listing":
    case "request":
    case "client":
    case "revision":
      return t.views[view.name];
    default:
      return t[view.name];
  }
}

interface PageProps {
  view: View | null;
  title: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  dictionaries: StaffDictionaries | null;
}

function Page({ view, title, headingRef, dictionaries }: PageProps) {
  const heading = (
    <h1 id="page-title" className="page-title" ref={headingRef} tabIndex={-1}>
      {title}
    </h1>
  );
  if (!view)
    return (
      <section className="page" aria-labelledby="page-title">
        {heading}
        <p className="lead">{t.notFoundLead}</p>
        <Link to={{ name: HOME }} className="action">
          {t.toHome}
        </Link>
      </section>
    );

  let content: ReactNode;
  switch (view.name) {
    case "vendors":
      content = <VendorsPage />;
      break;
    case "vendorNew":
      content = <VendorNewPage dictionaries={dictionaries} />;
      break;
    case "vendor":
      content = <VendorPage key={view.id} id={view.id} dictionaries={dictionaries} />;
      break;
    case "listingNew":
      content = <ListingNewPage key={view.vendorId} vendorId={view.vendorId} dictionaries={dictionaries} />;
      break;
    case "listing":
      content = <ListingPage key={view.id} id={view.id} dictionaries={dictionaries} />;
      break;
    case "moderation":
      content = <ModerationPage minPhotos={dictionaries?.settings.minPhotos ?? 3} />;
      break;
    case "requests":
      content = <RequestsPage dictionaries={dictionaries} />;
      break;
    case "request":
      content = <RequestPage key={view.id} id={view.id} dictionaries={dictionaries} />;
      break;
    case "clients":
      content = <ClientsPage />;
      break;
    case "client":
      content = <ClientPage key={view.id} id={view.id} />;
      break;
    case "revision":
      content = <RevisionPage key={view.id} id={view.id} />;
      break;
    case "notifications":
      content = <NotificationsPage />;
      break;
    case "audit":
      content = <AuditPage dictionaries={dictionaries} />;
      break;
    case "team":
      content = <TeamPage />;
      break;
    case "settings":
      content = <SettingsPage />;
      break;
  }

  const section = sectionOf(view);
  const lead = view.name === section ? t[`${section}Lead`] : null;
  return (
    <section className={`page${view.name === section ? "" : " page-wide"}`} aria-labelledby="page-title">
      {heading}
      {lead && <p className="lead">{lead}</p>}
      {content}
    </section>
  );
}

interface ShellProps {
  staff: Staff;
  token: string;
  onSignOut: () => void;
}

// Имя бота: 5–32 символа латиницы, цифр и _, в конце — bot (правила @BotFather)
const BOT_USERNAME_RE = /^[A-Za-z0-9_]{2,29}bot$/i;

interface OtherApps {
  readonly web: string;
  readonly cabinet: string | null;
  readonly bot: string | null;
}

/**
 * Другие роли того же аккаунта: клиентское приложение и кабинет партнёра (если он
 * партнёр). Вне Telegram — ссылки (без сессии приложение само уйдёт в хаб и вернётся),
 * в Telegram — через бота: Mini App с initData
 */
function useOtherApps(token: string): OtherApps | null {
  const [apps, setApps] = useState<OtherApps | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([fetchMethods(), fetchAccount(token)]).then(([methods, me]) => {
      if (!active || methods === null) return;
      const bot = methods.telegram.bot;
      setApps({
        web: methods.apps.web,
        cabinet: me && me.roles.vendors.length > 0 ? `${methods.apps.vendor}/?${SIGNIN_PARAM}=1` : null,
        bot: bot && BOT_USERNAME_RE.test(bot) ? bot : null,
      });
    });
    return () => {
      active = false;
    };
  }, [token]);
  return apps;
}

function viaBot(url: string | null) {
  return (event: { preventDefault(): void }) => {
    const webApp = getWebApp();
    if (url && webApp?.initData && webApp.openTelegramLink) {
      event.preventDefault();
      webApp.openTelegramLink(url);
    }
  };
}

/** Панель вошедшего сотрудника: шапка с разделами и именем, содержимое экрана */
function Shell({ staff, token, onSignOut }: ShellProps) {
  const [view, navigate] = useRoute();
  const apps = useOtherApps(token);
  const heading = useRef<HTMLHeadingElement>(null);
  const shownPath = useRef(view ? pathOf(view) : null);
  const path = view ? pathOf(view) : null;
  // Справочники — один раз на сессию: районы, сотрудники, настройки
  const { loaded: dict } = useLoad<StaffDictionaries>("/staff/dictionaries");
  const dictionaries = dict.state === "ready" ? dict.data : null;
  // Страница объекта называет себя сама, когда данные загрузились; новый экран — сброс
  const [entityTitle, setEntityTitle] = useState<{ path: string | null; title: string | null }>({
    path: null,
    title: null,
  });
  const setTitle = useCallback(
    (title: string | null) => setEntityTitle({ path: window.location.pathname, title }),
    [],
  );
  const title = (entityTitle.path === window.location.pathname ? entityTitle.title : null) ?? titleOf(view);

  useEffect(() => {
    document.title = `${title} · Bayramm`;
  }, [title]);

  // После перехода фокус — на заголовок нового экрана, чтобы экранный диктор его прочёл.
  // При первом показе фокус не трогаем. Без прокрутки (ловушка №3); scrollTo есть не везде (ловушка №5)
  useEffect(() => {
    if (shownPath.current === path) return;
    shownPath.current = path;
    heading.current?.focus({ preventScroll: true });
    window.scrollTo?.(0, 0);
  }, [path]);

  const current = view ? sectionOf(view) : null;
  return (
    <NavigateContext.Provider value={navigate}>
      <div className="app">
        <a className="skip" href="#main">
          {t.skip}
        </a>
        <header className="top">
          <Link to={{ name: HOME }} className="brand">
            Bayramm <span className="brand-area">{t.area}</span>
          </Link>
          <nav className="nav" aria-label={t.sections}>
            {NAV.filter((item) => staff.permissions.includes(SECTION_PERMISSION[item])).map((item) => (
              <Link key={item} to={{ name: item }} current={current === item}>
                {t[item]}
              </Link>
            ))}
          </nav>
          <div className="who">
            <p className="who-name">
              <span className="visually-hidden">{t.signedInAs} </span>
              {staff.displayName}
              <span className="who-role">{t.roles[staff.role]}</span>
            </p>
            {apps ? (
              <a
                className="action"
                href={apps.web}
                onClick={viaBot(apps.bot ? `https://t.me/${apps.bot}?startapp` : null)}
              >
                {t.toClientApp}
              </a>
            ) : null}
            {apps?.cabinet ? (
              <a
                className="action"
                href={apps.cabinet}
                onClick={viaBot(apps.bot ? `https://t.me/${apps.bot}?start=cabinet` : null)}
              >
                {t.toCabinet}
              </a>
            ) : null}
            <button type="button" className="action" onClick={onSignOut}>
              {t.signOut}
            </button>
          </div>
        </header>
        <main id="main" className="main" tabIndex={-1}>
          <TitleContext.Provider value={setTitle}>
            <Page view={view} title={title} headingRef={heading} dictionaries={dictionaries} />
          </TitleContext.Provider>
        </main>
      </div>
    </NavigateContext.Provider>
  );
}

type Auth =
  | { kind: "checking" }
  | { kind: "signedOut"; error: SignInError | null }
  | { kind: "signedIn"; staff: Staff; token: string };

/**
 * Сессия при открытии панели:
 *   · /auth/callback — возврат из хаба входа: код → сессия сотрудника;
 *   · панель открыта в Telegram (кнопка бота) — вход по initData;
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
  } else if (tokenStore.get() === null) {
    // SDK — только если панель открыл Telegram (кнопка бота): обычный браузер его не грузит
    const webApp = await loadTelegramWebApp();
    if (webApp?.initData) {
      webApp.ready?.();
      webApp.expand?.();
      const result = await signInWebApp(webApp.initData);
      if (!result.ok) return { kind: "signedOut", error: result.error };
      tokenStore.set(result.token);
    } else if (new URLSearchParams(window.location.search).has(SIGNIN_PARAM)) {
      if (await startHub(backPath())) return { kind: "checking" };
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
