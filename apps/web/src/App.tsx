import { parseStartParam } from "@bayramm/tg";
import { useEffect, useRef } from "react";
import { LangSwitch } from "./components/LangSwitch";
import { Link } from "./components/Link";
import { EmptyState } from "./components/States";
import { AppProviders, type Services, useLang, useServices } from "./context";
import { useDocumentTitle } from "./hooks";
import { Icon, type IconName } from "./icons";
import { hrefFor, type Match, RouterContext, TABS, type Tab, tabOf, useNav, useRouter } from "./router";
import { Catalog } from "./screens/Catalog";
import { MyRequests } from "./screens/MyRequests";
import { Profile } from "./screens/Profile";
import { RequestForm } from "./screens/RequestForm";
import { Venue } from "./screens/Venue";
import { hasNativeBack, useBackButton } from "./telegram";

/* Вкладки: подпись и иконки (обычная и активная) — в одной карте с маршрутами (ловушка №9) */
const TAB_VIEW = {
  catalog: { label: "navHome", icon: "home", active: "homeFill" },
  requests: { label: "navRequests", icon: "notepad", active: "notepadFill" },
  profile: { label: "navProfile", icon: "user", active: "userFill" },
} as const satisfies Record<Tab, { label: string; icon: IconName; active: IconName }>;

/** Внутренние экраны: без нижней панели, с «назад» */
const isInner = (match: Match | null) => match?.name === "venue" || match?.name === "request";

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
    case "catalog":
      return <Catalog />;
    case "venue":
      return <Venue key={match.slug} slug={match.slug} />;
    case "request":
      return <RequestForm key={match.slug} slug={match.slug} />;
    case "requests":
      return <MyRequests />;
    case "profile":
      return <Profile />;
    default:
      return <NotFound />;
  }
}

function Tabs({ current }: { current: Tab | null }) {
  const { t } = useLang();
  return (
    <nav className="tabs" aria-label={t.sections}>
      {TABS.map((tab) => {
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

function Shell() {
  const router = useNav();
  const { api, webApp } = useServices();
  const { t } = useLang();
  const { match, navigate, back } = router;
  const inner = isInner(match);
  const main = useRef<HTMLElement>(null);
  const shown = useRef<string | null>(null);
  const started = useRef(false);

  useBackButton(webApp, inner, back);

  // Ссылка t.me/<бот>?startapp=vendor_<slug> открывает площадку. Один раз, только с главной:
  // перезагрузка на другом экране его не перебивает; «назад» вернёт в каталог
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const route = parseStartParam(webApp?.initDataUnsafe.start_param);
    if (route?.kind === "vendor" && match?.name === "catalog")
      navigate(hrefFor({ name: "venue", slug: route.id }));
  }, [webApp, match, navigate]);

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

  return (
    <div className={inner ? "app inner" : "app"}>
      <a className="skip" href="#main">
        {t.skipToMain}
      </a>
      <header className="top">
        {inner && !hasNativeBack(webApp) ? (
          <button type="button" className="icon-btn back" aria-label={t.back} onClick={back}>
            <Icon name="back" size={17} />
          </button>
        ) : null}
        <Link className="brand" href={hrefFor({ name: "catalog" })}>
          Bayramm
        </Link>
        <LangSwitch />
      </header>
      {api.mode === "mock" ? (
        <p className="demo-ribbon" role="note">
          {t.demoData}
        </p>
      ) : null}
      <main id="main" className="main" tabIndex={-1} ref={main}>
        <Screen match={match} />
      </main>
      {inner ? null : <Tabs current={tabOf(match)} />}
    </div>
  );
}

export function App({ services }: { services: Services }) {
  const router = useRouter();
  return (
    <AppProviders services={services}>
      <RouterContext.Provider value={router}>
        <Shell />
      </RouterContext.Provider>
    </AppProviders>
  );
}
