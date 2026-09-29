import { LANGS, type Lang } from "@bayramm/shared";
import type { RequestTab, VendorMe } from "@bayramm/shared/api/vendor";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, api, setUnauthorizedHandler, signIn, tokenStore } from "./api";
import { Calendar } from "./Calendar";
import { Gate, type GateKind } from "./Gate";
import { LANG_NAMES, vendorDict } from "./i18n";
import { Icon, type IconName } from "./icons";
import { initialLang, saveLang } from "./lang";
import { RequestDetail } from "./RequestDetail";
import { Requests } from "./Requests";
import {
  HOME,
  type Location,
  NAV,
  type Navigate,
  pathOf,
  SECTION_OF,
  type Section,
  useRoute,
} from "./router";
import { announceReady, getWebApp } from "./telegram";
import { Heading } from "./ui";
import { Venue } from "./Venue";

type Auth = { readonly kind: GateKind } | { readonly kind: "ready"; readonly me: VendorMe };

const NAV_ICON: Readonly<Record<Section, IconName>> = {
  requests: "requests",
  calendar: "calendar",
  card: "hall",
};

/**
 * Вход: внутри Telegram — по свежей initData. initData живёт час; если Mini App
 * перезагрузили позже, а сессия (12 часов) ещё жива — работаем по ней. Вне Telegram
 * кабинета нет: экран «откройте из бота».
 */
async function startSession(): Promise<Auth> {
  const webApp = getWebApp();
  if (!webApp) return { kind: "outside" };
  announceReady(webApp);
  try {
    await signIn(webApp.initData);
  } catch (err) {
    if (!(err instanceof ApiFailure)) return { kind: "error" };
    if (err.code === "vendor_not_linked") return { kind: "not_linked" };
    if (err.code === "vendor_disabled") return { kind: "disabled" };
    if (err.status !== 401 || tokenStore.get() === null)
      return { kind: err.status === 401 ? "expired" : "error" };
  }
  try {
    return { kind: "ready", me: await api.me() };
  } catch (err) {
    return { kind: err instanceof ApiFailure && err.status === 401 ? "expired" : "error" };
  }
}

interface NavLinkProps {
  readonly to: Location;
  readonly current: boolean;
  readonly navigate: Navigate;
  readonly className?: string;
  readonly children: ReactNode;
}

function NavLink({ to, current, navigate, className, children }: NavLinkProps) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // Новая вкладка, окно, скачивание — пусть решает браузер
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={pathOf(to)} className={className} aria-current={current ? "page" : undefined} onClick={onClick}>
      {children}
    </a>
  );
}

export function App() {
  const [location, navigate] = useRoute();
  const [lang, setLang] = useState<Lang>(initialLang);
  const [auth, setAuth] = useState<Auth>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [inboxTab, setInboxTab] = useState<RequestTab>("new");
  const [listingId, setListingId] = useState<string | null>(null);
  const t = vendorDict[lang];
  const heading = useRef<HTMLHeadingElement>(null);
  const shownPath = useRef(location ? pathOf(location) : null);

  // Вход при открытии и по «Повторить»
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt — повтор входа по «Повторить»
  useEffect(() => {
    let active = true;
    setAuth({ kind: "loading" });
    void startSession().then((result) => {
      if (!active) return;
      setAuth(result);
      if (result.kind === "ready") {
        // После входа язык — из профиля вендора (его же видит бот)
        setLang(result.me.user.locale);
        saveLang(result.me.user.locale);
        setListingId((current) => current ?? result.me.listings[0]?.id ?? null);
      }
    });
    return () => {
      active = false;
    };
  }, [attempt]);

  // Сессия кончилась посреди работы — «откройте из бота заново»
  useEffect(() => {
    setUnauthorizedHandler(() => setAuth({ kind: "expired" }));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const chooseLang = (code: Lang) => {
    setLang(code);
    saveLang(code);
    if (auth.kind === "ready") {
      void api
        .setLocale(code)
        .then((me) => setAuth({ kind: "ready", me }))
        .catch(() => {});
    }
  };

  const section = location ? SECTION_OF[location.route] : null;
  useEffect(() => {
    document.title = `${section ? t[section] : t.notFound} · Bayramm`;
  }, [section, t]);

  // После перехода фокус — на заголовок нового экрана, чтобы экранный диктор его прочёл.
  // При первом показе фокус не трогаем. Без прокрутки (ловушка №3); scrollTo есть не везде (ловушка №5)
  const path = location ? pathOf(location) : null;
  useEffect(() => {
    if (shownPath.current === path) return;
    shownPath.current = path;
    heading.current?.focus({ preventScroll: true });
    window.scrollTo?.(0, 0);
  }, [path]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const screenProps = { t, lang, headingRef: heading } as const;

  let screen: ReactNode;
  if (auth.kind !== "ready") {
    screen = <Gate kind={auth.kind} t={t} headingRef={heading} onRetry={retry} />;
  } else if (!location) {
    screen = (
      <section className="page" aria-labelledby="page-title">
        <Heading headingRef={heading}>{t.notFound}</Heading>
        <p className="lead">{t.notFoundLead}</p>
        <NavLink to={{ route: HOME }} current={false} navigate={navigate} className="btn btn-ghost">
          {t.toHome}
        </NavLink>
      </section>
    );
  } else if (location.route === "request" && location.id) {
    screen = <RequestDetail key={location.id} id={location.id} navigate={navigate} {...screenProps} />;
  } else if (location.route === "calendar") {
    screen = (
      <Calendar
        t={t}
        headingRef={heading}
        listings={auth.me.listings}
        listingId={listingId}
        onListing={setListingId}
      />
    );
  } else if (location.route === "card") {
    screen = (
      <Venue
        {...screenProps}
        listings={auth.me.listings}
        listingId={listingId}
        onListing={setListingId}
        vendorCode={auth.me.vendor.code}
      />
    );
  } else {
    screen = (
      <Requests
        {...screenProps}
        tab={inboxTab}
        onTab={setInboxTab}
        navigate={navigate}
        listingCount={auth.me.listings.length}
      />
    );
  }

  return (
    <div className={`app${auth.kind === "ready" ? " app-tabs" : ""}`}>
      <a className="skip" href="#main">
        {t.skip}
      </a>
      <header className="top">
        <p className="brand">
          Bayramm <span className="brand-area">{t.area}</span>
        </p>
        {/* biome-ignore lint/a11y/useSemanticElements: группа кнопок-переключателей, fieldset здесь не форма */}
        <div className="lang" role="group" aria-label={t.language}>
          {LANGS.map((code) => (
            <button
              key={code}
              type="button"
              lang={code}
              title={LANG_NAMES[code]}
              aria-pressed={code === lang}
              onClick={() => chooseLang(code)}
            >
              {code.toUpperCase()}
            </button>
          ))}
        </div>
      </header>
      <main id="main" className="main" tabIndex={-1}>
        {screen}
      </main>
      {auth.kind === "ready" ? (
        <nav className="tabbar" aria-label={t.sections}>
          {NAV.map((item) => (
            <NavLink
              key={item}
              to={{ route: item }}
              current={section === item}
              navigate={navigate}
              className="tab"
            >
              <Icon name={NAV_ICON[item]} size={24} />
              <span>{t[item]}</span>
            </NavLink>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
