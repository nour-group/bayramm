import type { Lang } from "@bayramm/shared";
import { parseStartParam } from "@bayramm/tg";
import { ConnectivityProvider, OfflineBanner, ToastProvider, UiTextsProvider } from "@bayramm/ui/react";
import { Suspense, useEffect, useMemo, useRef } from "react";
import { LangSwitch } from "./components/LangSwitch";
import { Link } from "./components/Link";
import { SiteFooter } from "./components/SiteFooter";
import { SiteMenu } from "./components/SiteMenu";
import { SiteSearch } from "./components/SiteSearch";
import { EmptyState, Loading } from "./components/States";
import { AppProviders, type Services, useAccount, useLang, useServices } from "./context";
import { FavoritesProvider } from "./favorites";
import { useDocumentTitle, useStickyPanel } from "./hooks";
import { authHref, browser } from "./hub";
import { Icon, type IconName } from "./icons";
import { chromeOf, sectionsOf, signInGate } from "./nav";
import {
  canonicalHref,
  hrefFor,
  isAuth,
  isInner,
  type Match,
  type Router,
  RouterContext,
  screenOf,
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
import { scrollWhenReady } from "./scroll";
import { hasNativeBack, useBackButton } from "./telegram";

/* Вкладки: подпись и иконки (обычная и активная) — в одной карте с маршрутами (ловушка №9).
   Первая вкладка — «Каталог» и в Telegram, и на сайте: так называется и её экран */
const TAB_VIEW = {
  catalog: { label: "navCatalog", icon: "home", active: "homeFill" },
  // Подпись — как у экрана и уведомления «Список во вкладке «Сохранённое»» (прототип)
  favorites: { label: "svTitle", icon: "heart", active: "heartFill" },
  requests: { label: "navRequests", icon: "notepad", active: "notepadFill" },
  profile: { label: "navProfile", icon: "user", active: "userFill" },
} as const satisfies Record<Tab, { label: string; icon: IconName; active: IconName }>;

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

/**
 * Разделы: нижняя панель на телефоне и планшете (.tabs), в шапке — на компьютере (.site-nav).
 * Какие — решает оболочка (nav.ts): гостю — каталог и сохранённое, после входа — все
 */
function Sections({
  tabs,
  current,
  className,
}: {
  tabs: readonly Tab[];
  current: Tab | null;
  className: "tabs" | "site-nav";
}) {
  const { t } = useLang();
  // Нижняя панель (телефон и планшет) прилипает к низу: её высота — в запас прокрутки
  const nav = useRef<HTMLElement>(null);
  useStickyPanel(nav, className === "tabs" ? "bottom" : "top");
  return (
    <nav className={className} aria-label={t.sections} ref={nav}>
      {tabs.map((tab) => {
        const view = TAB_VIEW[tab];
        const on = tab === current;
        return (
          <Link key={tab} href={hrefFor({ name: tab })} aria-current={on ? "page" : undefined}>
            <Icon name={on ? view.active : view.icon} size={20} />
            <span>{t[view.label]}</span>
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
  // грузится — фокус на main, а на заголовок — когда он появится (если фокус не увели).
  // Вернулись «назад» (кнопка браузера, «назад» Telegram) — прокрутка туда, где человек был
  // (router.ts запомнил её у записи истории), иначе — наверх
  const screenKey = match ? JSON.stringify(match) : "none";
  const { restoreScroll } = router;
  const restoreRef = useRef(restoreScroll);
  restoreRef.current = restoreScroll;
  useEffect(() => {
    if (shown.current === null) {
      shown.current = screenKey;
      return;
    }
    if (shown.current === screenKey) return;
    shown.current = screenKey;
    const area = main.current;
    const restore = restoreRef.current;
    let stopScroll = () => {};
    if (restore !== null && area) stopScroll = scrollWhenReady(restore, area);
    else window.scrollTo?.(0, 0);
    if (!area) return stopScroll;
    // Экран сам поставил фокус внутрь себя (поле поиска, открытое значком в шапке) — не отбираем
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== area && area.contains(focused)) return stopScroll;
    const focusHeading = () => {
      const heading = area.querySelector<HTMLElement>("h1");
      heading?.focus({ preventScroll: true });
      return heading !== null;
    };
    if (focusHeading()) return stopScroll;
    area.focus({ preventScroll: true });
    if (typeof MutationObserver !== "function") return stopScroll;
    const observer = new MutationObserver(() => {
      if (document.activeElement !== area) observer.disconnect();
      else if (focusHeading()) observer.disconnect();
    });
    observer.observe(area, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      stopScroll();
    };
  }, [screenKey]);

  // Адрес страницы для поисковиков — без фильтров и прочих параметров (у каталога — с
  // категорией). Первую загрузку размечает воркер (с ?lang= у языковых версий), здесь —
  // только переходы внутри приложения
  const path = route ? hrefFor(route) : null;
  const canonicalPath = route ? canonicalHref(route, query) : null;
  const firstPath = useRef(canonicalPath);
  useEffect(() => {
    if (canonicalPath === firstPath.current) return;
    firstPath.current = null;
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical && canonicalPath)
      canonical.setAttribute("href", new URL(canonicalPath, window.location.origin).href);
  }, [canonicalPath]);

  // Вход в шапке и в меню сайта: гостю — в хаб и назад на этот же экран
  const search = query.toString();
  const here = `${path ?? "/"}${search ? `?${search}` : ""}`;
  // Оболочка гостя или приложения (nav.ts): гостю — сайт без нижней панели, с меню и входом
  const chrome = chromeOf(identity, webApp !== null, deleted);
  const guest = chrome === "guest";
  const tabs = sectionsOf(chrome);
  // Шапка и нижняя панель разделов прилипают: их высота — в запас прокрутки (фокус не под ними)
  const top = useRef<HTMLElement>(null);
  useStickyPanel(top, "top");
  const signInHref = authHref({ return: here });
  // Сайт (не Mini App): под экраном — подвал
  const site = webApp === null && !auth;
  // Личный экран без входа — в хаб и назад сюда: адрес хаба — полной загрузкой (у /auth свой CSP)
  const gate = webApp ? null : signInGate(match, identity, here);
  useEffect(() => {
    if (gate) browser.replace(gate);
  }, [gate]);

  const page = (
    <div
      className={["app", inner ? "inner" : "", site ? "site" : "", guest ? "guest" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <a className="skip" href="#main">
        {t.skipToMain}
      </a>
      <header className="top" ref={top}>
        {inner && !hasNativeBack(webApp) ? (
          <button type="button" className="icon-btn back" aria-label={t.back} onClick={back}>
            <Icon name="back" size={17} />
          </button>
        ) : null}
        <Link className="brand" href={hrefFor({ name: "home" })}>
          Bayramm
        </Link>
        {auth ? null : <Sections tabs={tabs} current={tabOf(match)} className="site-nav" />}
        {/* Поиск в шапке — у сайта; на каталоге его поле уже есть, в Telegram — во вкладке каталога */}
        {webApp === null && !auth && match?.name !== "catalog" ? <SiteSearch /> : null}
        {/* Язык — в шапке; в профиле он своим разделом (и в подвале сайта) — третий раз не нужен */}
        {match?.name === "profile" ? null : <LangSwitch />}
        {guest && !auth ? (
          <>
            <a className="btn btn-secondary top-signin" href={signInHref}>
              {t.accSignIn}
            </a>
            <SiteMenu current={tabOf(match)} signInHref={signInHref} />
          </>
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
          {gate ? (
            <div className="screen-fallback">
              <Loading />
            </div>
          ) : (
            <Screen match={match} />
          )}
        </Suspense>
      </main>
      {/* Подвал — у сайта; в Mini App его место — нижняя панель. Нижней панели нет у гостя
          сайта (разделы — в шапке и в меню), на внутренних экранах и во входе */}
      {site ? <SiteFooter /> : null}
      {inner || auth || guest ? null : <Sections tabs={tabs} current={tabOf(match)} className="tabs" />}
    </div>
  );

  return (
    <UiTextsProvider texts={uiTexts}>
      {prerender ? (
        page
      ) : (
        <ToastProvider offset={inner || auth || guest ? 16 : TABS_HEIGHT}>
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
