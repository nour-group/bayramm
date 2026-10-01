import type { Lang } from "@bayramm/shared";
import { parseStartParam } from "@bayramm/tg";
import { ConnectivityProvider, OfflineBanner, ToastProvider, UiTextsProvider } from "@bayramm/ui/react";
import { Suspense, useEffect, useMemo, useRef } from "react";
import { LangSwitch } from "./components/LangSwitch";
import { Link } from "./components/Link";
import { SiteFooter } from "./components/SiteFooter";
import { EmptyState, Loading } from "./components/States";
import { AppProviders, type Services, useAccount, useLang, useServices } from "./context";
import { FavoritesProvider } from "./favorites";
import { useDocumentTitle } from "./hooks";
import { authHref } from "./hub";
import { Icon, type IconName } from "./icons";
import {
  hrefFor,
  isAuth,
  isInner,
  type Match,
  type Router,
  RouterContext,
  screenOf,
  TABS,
  type Tab,
  tabOf,
  useNav,
  useRouter,
  widthOf,
} from "./router";
import {
  Catalog,
  Docs,
  Favorites,
  Landing,
  MyRequests,
  Profile,
  preloadScreens,
  RequestForm,
  type ScreenChunk,
  SignIn,
  TelegramCallback,
  Venue,
} from "./screens";
import { hasNativeBack, useBackButton } from "./telegram";

/* Вкладки: подпись и иконки (обычная и активная) — в одной карте с маршрутами (ловушка №9).
   Первая вкладка в Telegram — «Главная» (стартовый экран Mini App — каталог), на сайте —
   «Каталог»: главная сайта — лендинг, на неё ведёт логотип */
const TAB_VIEW = {
  catalog: { label: "navHome", site: "navCatalog", icon: "home", active: "homeFill" },
  // Подпись — как у экрана и уведомления «Список во вкладке «Сохранённое»» (прототип)
  favorites: { label: "svTitle", site: "svTitle", icon: "heart", active: "heartFill" },
  requests: { label: "navRequests", site: "navRequests", icon: "notepad", active: "notepadFill" },
  profile: { label: "navProfile", site: "navProfile", icon: "user", active: "userFill" },
} as const satisfies Record<Tab, { label: string; site: string; icon: IconName; active: IconName }>;

/** Уведомления — над нижней панелью вкладок (её высота с запасом), px */
const TABS_HEIGHT = 80;

/** Что подгрузить заранее, пока человек смотрит первый экран: соседние экраны вкладок */
const PRELOAD: Readonly<Record<"site" | "telegram", readonly ScreenChunk[]>> = {
  site: ["catalog", "venue", "favorites"],
  telegram: ["venue", "request", "favorites", "requests", "profile"],
};

function NotFound() {
  const { t } = useLang();
  useDocumentTitle(t.notFoundH);
  return (
    <EmptyState
      headingLevel={1}
      title={t.notFoundH}
      text={t.notFoundP}
      action={
        <Link className="btn btn-secondary" href={hrefFor({ name: "catalog" })}>
          {t.toCatalog}
        </Link>
      }
    />
  );
}

function Screen({ match }: { match: Match | null }) {
  switch (match?.name) {
    case "home":
      return <Landing />;
    case "catalog":
      return <Catalog />;
    case "venue":
      return <Venue key={match.slug} slug={match.slug} />;
    case "favorites":
      return <Favorites />;
    case "request":
      return <RequestForm key={match.slug} slug={match.slug} />;
    case "requests":
      return <MyRequests />;
    case "profile":
      return <Profile />;
    case "docs":
      return <Docs />;
    case "auth":
      return <SignIn />;
    case "authTelegram":
      return <TelegramCallback />;
    default:
      return <NotFound />;
  }
}

/** Разделы: нижняя панель на телефоне и планшете (.tabs), в шапке — на компьютере (.site-nav) */
function Sections({ current, className }: { current: Tab | null; className: "tabs" | "site-nav" }) {
  const { webApp } = useServices();
  const { t } = useLang();
  return (
    <nav className={className} aria-label={t.sections}>
      {TABS.map((tab) => {
        const view = TAB_VIEW[tab];
        const on = tab === current;
        return (
          <Link key={tab} href={hrefFor({ name: tab })} aria-current={on ? "page" : undefined}>
            <Icon name={on ? view.active : view.icon} size={20} />
            <span>{t[webApp ? view.label : view.site]}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Оболочка: шапка, экран, подвал, вкладки. prerender — разметка для пререндера при сборке:
 * без уведомлений и избранного (уведомления — портал в body, его нет при рендере в строку;
 * экрану лендинга до данных API ни то ни другое не нужно)
 */
function Shell({ prerender = false }: { prerender?: boolean }) {
  const router = useNav();
  const { api, webApp, identity } = useServices();
  const { deleted } = useAccount();
  const { t } = useLang();
  const { match: route, query, navigate, back } = router;
  // Корень внутри Telegram — каталог, в браузере — лендинг
  const match = screenOf(route, webApp !== null);
  const inner = isInner(match);
  const auth = isAuth(match);
  const main = useRef<HTMLElement>(null);
  const shown = useRef<string | null>(null);
  const started = useRef(false);
  // Подписи кнопок своих контролов (@bayramm/ui/react) — на языке клиента
  const uiTexts = useMemo(() => ({ close: t.infoClose, clear: t.clearField }), [t]);

  useBackButton(webApp, inner, back);

  // Ссылка t.me/<бот>?startapp=vendor_<slug> открывает площадку. Один раз, только с главной:
  // перезагрузка на другом экране его не перебивает; «назад» вернёт в каталог
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const start = parseStartParam(webApp?.initDataUnsafe.start_param);
    if (start?.kind === "vendor" && match?.name === "catalog")
      navigate(hrefFor({ name: "venue", slug: start.id }));
  }, [webApp, match, navigate]);

  // Соседние экраны — заранее, когда первый уже на месте (не мешаем его загрузке)
  useEffect(() => {
    const timer = setTimeout(() => preloadScreens(PRELOAD[webApp ? "telegram" : "site"]), 1500);
    return () => clearTimeout(timer);
  }, [webApp]);

  // Новый экран: фокус на его заголовок (для диктора) без прокрутки — ловушка №3;
  // scrollTo есть не везде — ловушка №5. Первый показ фокус не трогает. Экран ещё
  // грузится — фокус на main, а на заголовок — когда он появится (если фокус не увели)
  const screenKey = match ? JSON.stringify(match) : "none";
  useEffect(() => {
    if (shown.current === null) {
      shown.current = screenKey;
      return;
    }
    if (shown.current === screenKey) return;
    shown.current = screenKey;
    window.scrollTo?.(0, 0);
    const area = main.current;
    if (!area) return;
    const focusHeading = () => {
      const heading = area.querySelector<HTMLElement>("h1");
      heading?.focus({ preventScroll: true });
      return heading !== null;
    };
    if (focusHeading()) return;
    area.focus({ preventScroll: true });
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(() => {
      if (document.activeElement !== area) observer.disconnect();
      else if (focusHeading()) observer.disconnect();
    });
    observer.observe(area, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [screenKey]);

  // Адрес страницы для поисковиков — без фильтров и прочих параметров. Первую загрузку
  // размечает воркер (с ?lang= у языковых версий), здесь — только переходы внутри приложения
  const path = route ? hrefFor(route) : null;
  const firstPath = useRef(path);
  useEffect(() => {
    if (path === firstPath.current) return;
    firstPath.current = null;
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical && path) canonical.setAttribute("href", new URL(path, window.location.origin).href);
  }, [path]);

  // Вход в шапке сайта (на компьютере): гостю — в хаб и назад на этот же экран
  const search = query.toString();
  const here = `${path ?? "/"}${search ? `?${search}` : ""}`;
  const guest = identity === "guest" || deleted;
  // Сайт (не Mini App): под экраном — подвал
  const site = webApp === null && !auth;

  const page = (
    <div className={["app", inner ? "inner" : "", site ? "site" : ""].filter(Boolean).join(" ")}>
      <a className="skip" href="#main">
        {t.skipToMain}
      </a>
      <header className="top">
        {inner && !hasNativeBack(webApp) ? (
          <button type="button" className="icon-btn back" aria-label={t.back} onClick={back}>
            <Icon name="back" size={17} />
          </button>
        ) : null}
        <Link className="brand" href={hrefFor({ name: "home" })}>
          Bayramm
        </Link>
        {auth ? null : <Sections current={tabOf(match)} className="site-nav" />}
        <LangSwitch />
        {guest && !auth && !webApp ? (
          <a className="btn btn-secondary top-signin" href={authHref({ return: here })}>
            {t.accSignIn}
          </a>
        ) : null}
      </header>
      {api.mode === "mock" ? (
        <p className="demo-ribbon" role="note">
          {t.demoData}
        </p>
      ) : null}
      <OfflineBanner offline={t.offline} back={t.backOnline} />
      <main id="main" className={`main main-${widthOf(match)}`} tabIndex={-1} ref={main}>
        {/* Пока грузится кусок экрана — место во весь экран: подвал не прыгает вниз */}
        <Suspense
          fallback={
            <div className="screen-fallback">
              <Loading />
            </div>
          }
        >
          <Screen match={match} />
        </Suspense>
      </main>
      {/* Подвал — у сайта; в Mini App его место — нижняя панель */}
      {site ? <SiteFooter /> : null}
      {inner || auth ? null : <Sections current={tabOf(match)} className="tabs" />}
    </div>
  );

  return (
    <UiTextsProvider texts={uiTexts}>
      {prerender ? (
        page
      ) : (
        <ToastProvider offset={inner || auth ? 16 : TABS_HEIGHT}>
          <FavoritesProvider>{page}</FavoritesProvider>
        </ToastProvider>
      )}
    </UiTextsProvider>
  );
}

/**
 * Провайдеры и оболочка с экраном. У приложения адрес живой (App), у пререндера при
 * сборке (prerender.tsx) — неподвижный, язык задан (prerenderLang): одна и та же разметка
 */
export function AppFrame({
  services,
  router,
  prerenderLang,
}: {
  services: Services;
  router: Router;
  prerenderLang?: Lang;
}) {
  return (
    <ConnectivityProvider>
      <AppProviders services={services} lang={prerenderLang}>
        <RouterContext.Provider value={router}>
          <Shell prerender={prerenderLang !== undefined} />
        </RouterContext.Provider>
      </AppProviders>
    </ConnectivityProvider>
  );
}

export function App({ services }: { services: Services }) {
  const router = useRouter();
  return <AppFrame services={services} router={router} />;
}
