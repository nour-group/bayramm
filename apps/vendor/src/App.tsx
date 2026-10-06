import { LANGS, type Lang } from "@bayramm/shared";
import type { VendorMembership } from "@bayramm/shared/api/account";
import type { RequestTab, VendorMe } from "@bayramm/shared/api/vendor";
import {
  ConnectivityProvider,
  OfflineBanner,
  Tooltip,
  UiTextsProvider,
  useOnReconnect,
} from "@bayramm/ui/react";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VendorChooser } from "./Account";
import { ApiFailure, accountMe, api, setUnauthorizedHandler, signIn, tokenStore } from "./api";
import { type AttentionMark, attentionTotals, mergeListings } from "./attention";
import { Gate, type GateKind } from "./Gate";
import { CALLBACK_PATH, chooseVendor, finishHub, SIGNIN_PARAM, startHub } from "./hub";
import { fill, LANG_NAMES, type VendorDict, vendorDict } from "./i18n";
import { Icon, type IconName } from "./icons";
import { initialLang, saveLang } from "./lang";
import { type Layout, useLayout } from "./layout";
import {
  HOME,
  type Location,
  matchRoute,
  NAV,
  type Navigate,
  pathOf,
  SECTION_OF,
  type Section,
  useRoute,
} from "./router";
import { SideVitrinas } from "./SideVitrinas";
import { Lazy, preloadScreens, SCREENS, warmInbox } from "./screens";
import { announceReady, launchedFromTelegram, loadTelegramWebApp } from "./telegram";
import { Heading } from "./ui";
import { UnsavedContext, useUnsavedGuard } from "./unsaved";
import { Welcome } from "./Welcome";

/* Оболочка кабинета: вход, раскладка и разделы.
     · телефон (Mini App) — шапка с языком, нижняя панель из пяти разделов;
     · планшет — шапка и узкая колонка разделов слева;
     · компьютер — боковая панель: название, разделы, витрины, кабинет (код), язык.
   Раскладку выбирает layout.ts; те же границы — в @media styles.css. Заявки на компьютере —
   списком и карточкой рядом (Inbox.tsx). Все разделы, и заявки тоже, — свои части сборки
   (screens.tsx): заявки грузятся параллельно со входом, остальное — после него.

   Витрина (страница вендора в одной категории; их бывает несколько) выбрана одна на весь
   кабинет — listingId: её показывают календарь, витрина и услуги. Выбор — в боковой панели
   компьютера (там же на входящих — «Все витрины»), на телефоне и планшете — вверху экранов.
   Заявки — все витрины сразу или одна (scope): выбор одной витрины во входящих делает её
   выбранной и в остальных разделах. */

type Auth =
  | { readonly kind: GateKind; readonly back?: string }
  | { readonly kind: "choose"; readonly vendors: readonly VendorMembership[] }
  | { readonly kind: "ready"; readonly me: VendorMe; readonly back?: string };

const NAV_ICON: Readonly<Record<Section, IconName>> = {
  requests: "requests",
  calendar: "calendar",
  card: "hall",
  services: "services",
  account: "user",
};

/** Кабинет по сессии: партнёр одного вендора — сразу, нескольких — выбор */
async function openCabinet(back?: string): Promise<Auth> {
  try {
    return { kind: "ready", me: await api.me(), back };
  } catch (err) {
    if (!(err instanceof ApiFailure)) return { kind: "error" };
    if (err.code === "vendor_not_linked") return { kind: "not_linked" };
    if (err.code === "vendor_disabled") return { kind: "disabled" };
    if (err.code === "vendor_choice_required") {
      try {
        return { kind: "choose", vendors: (await accountMe()).roles.vendors };
      } catch {
        return { kind: "error" };
      }
    }
    if (err.code === "forbidden") {
      // Выбранный раньше вендор больше не наш — выбор заново
      chooseVendor(null);
      return openCabinet(back);
    }
    return { kind: err.status === 401 ? "expired" : "error" };
  }
}

/**
 * Вход: внутри Telegram — по свежей initData из кнопки бота; сессия (7 дней) — на
 * случай, если Mini App перезагрузили позже часа. Вне Telegram — через хаб входа на
 * сайте: /auth/callback меняет одноразовый код на сессию, ?signin=1 (пришли из другого
 * приложения Bayramm) сразу уводит в хаб, иначе — экран «что это и как войти». Открыт из
 * Telegram, а SDK не загрузился — ошибка с повтором.
 */
// Возврат из хаба обрабатывается один раз: обмен сразу убирает код из адреса, а вход
// запускается повторно (StrictMode в разработке) — повтор ждёт тот же обмен
let hubReturn: ReturnType<typeof finishHub> | null = null;

async function startSession(): Promise<Auth> {
  if (window.location.pathname === CALLBACK_PATH) hubReturn = finishHub(window.location.search);
  if (hubReturn) {
    // Вход будет: заявки — первый экран, их часть сборки грузится вместе с обменом кода
    warmInbox();
    const running = hubReturn;
    const result = await running;
    if (hubReturn === running) hubReturn = null;
    if (result.kind === "bad") return { kind: "hub_failed", back: "/" };
    tokenStore.set(result.token);
    return openCabinet(result.back);
  }
  const webApp = await loadTelegramWebApp();
  if (!webApp) {
    if (launchedFromTelegram()) return { kind: "error" };
    if (tokenStore.get() !== null) {
      warmInbox();
      return openCabinet();
    }
    if (new URLSearchParams(window.location.search).has(SIGNIN_PARAM) && (await startHub())) {
      return { kind: "loading" };
    }
    return { kind: "outside" };
  }
  announceReady(webApp);
  warmInbox();
  try {
    await signIn(webApp.initData);
  } catch (err) {
    if (!(err instanceof ApiFailure)) return { kind: "error" };
    if (err.code === "vendor_not_linked") return { kind: "not_linked" };
    if (err.code === "vendor_disabled") return { kind: "disabled" };
    if (err.status !== 401 || tokenStore.get() === null)
      return { kind: err.status === 401 ? "expired" : "error" };
  }
  return openCabinet();
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

function LangSwitch({ lang, t, onChange }: { lang: Lang; t: VendorDict; onChange: (code: Lang) => void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: группа кнопок-переключателей, fieldset здесь не форма
    <div className="lang" role="group" aria-label={t.language}>
      {LANGS.map((code) => (
        <Tooltip key={code} text={LANG_NAMES[code]}>
          {(tip) => (
            <button
              {...tip}
              type="button"
              lang={code}
              aria-pressed={code === lang}
              onClick={() => onChange(code)}
            >
              {code.toUpperCase()}
            </button>
          )}
        </Tooltip>
      ))}
    </div>
  );
}

function Brand({ t }: { t: VendorDict }) {
  return (
    <p className="brand">
      Bayramm <span className="brand-area">{t.area}</span>
    </p>
  );
}

interface SectionsProps {
  readonly t: VendorDict;
  readonly section: Section | null;
  readonly navigate: Navigate;
  /** Новых заявок (из последнего ответа списка); null — ещё не знаем */
  readonly fresh: number | null;
  /** Что ждёт партнёра в «Витрине» и «Услугах»: отказы команды по всем витринам (GET /vendor/me) */
  readonly attention: Readonly<Record<AttentionMark, number>>;
  readonly className: string;
  readonly linkClass: string;
}

/**
 * Значок у раздела: число (на глаз) и слова для диктора — число одно и то же, цвет не
 * единственный признак. «Заявки» — новые, «Витрина» и «Услуги» — отказы, которые партнёру
 * нужно исправить
 */
function sectionBadge(
  item: Section,
  t: VendorDict,
  fresh: number | null,
  attention: SectionsProps["attention"],
): { readonly count: number; readonly words: string } | null {
  if (item === "requests") return fresh ? { count: fresh, words: fill(t.newCount, { n: fresh }) } : null;
  if (item === "card" || item === "services") {
    const count = attention[item];
    return count > 0 ? { count, words: fill(t.attentionCount, { n: count }) } : null;
  }
  return null;
}

/** Разделы кабинета: нижняя панель телефона, колонка планшета, боковая панель компьютера */
function Sections({ t, section, navigate, fresh, attention, className, linkClass }: SectionsProps) {
  return (
    <nav className={className} aria-label={t.sections}>
      {NAV.map((item) => {
        const badge = sectionBadge(item, t, fresh, attention);
        return (
          <NavLink
            key={item}
            to={{ route: item }}
            current={section === item}
            navigate={navigate}
            className={linkClass}
          >
            <span className="nav-icon">
              <Icon name={NAV_ICON[item]} size={24} />
              {badge ? (
                <span className="nav-count" aria-hidden="true">
                  {badge.count > 99 ? "99+" : badge.count}
                </span>
              ) : null}
            </span>
            <span className="nav-label">{t[item]}</span>
            {badge ? <span className="sr-only">{badge.words}</span> : null}
          </NavLink>
        );
      })}
    </nav>
  );
}

/** Кабинет со связью: баннер «нет связи» и повтор упавших загрузок, когда она вернётся */
export function App() {
  return (
    <ConnectivityProvider>
      <Cabinet />
    </ConnectivityProvider>
  );
}

function Cabinet() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const t = vendorDict[lang];
  // Несохранённое в формах экрана: уход (раздел, витрина, «назад») сначала спрашивает
  const unsaved = useUnsavedGuard(t);
  const [location, navigate] = useRoute(unsaved.guard);
  const layout: Layout = useLayout();
  const [auth, setAuth] = useState<Auth>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [inboxTab, setInboxTab] = useState<RequestTab>("new");
  const [listingId, setListingId] = useState<string | null>(null);
  // Входящие: все витрины или только выбранная
  const [scope, setScope] = useState<"all" | "listing">("all");
  const [fresh, setFresh] = useState<number | null>(null);
  const ready = auth.kind === "ready" ? auth : null;
  const { confirmLeave } = unsaved.registry;
  // Другая витрина — формы прежней закрываются: с правками — сначала вопрос
  const chooseListing = useCallback((id: string) => confirmLeave(() => setListingId(id)), [confirmLeave]);

  // Вход при открытии и по «Повторить»
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt — повтор входа по «Повторить»
  useEffect(() => {
    let active = true;
    setAuth({ kind: "loading" });
    void startSession().then((result) => {
      if (!active) return;
      setAuth(result);
      // Вернулись из хаба: экран — тот, с которого уходили
      if ("back" in result && result.back !== undefined) {
        navigate(matchRoute(new URL(result.back, window.location.origin).pathname) ?? { route: HOME }, {
          replace: true,
        });
      }
      if (result.kind === "ready") {
        // После входа язык — из профиля вендора (его же видит бот)
        setLang(result.me.user.locale);
        saveLang(result.me.user.locale);
        // Выбранная витрина остаётся, если она есть у этого кабинета (сменили кабинет — первая)
        setListingId((current) =>
          current !== null && result.me.listings.some((listing) => listing.id === current)
            ? current
            : (result.me.listings[0]?.id ?? null),
        );
      }
    });
    return () => {
      active = false;
    };
  }, [attempt]);

  // Вошли — остальные разделы подгружаются, пока человек смотрит на первый экран
  useEffect(() => {
    if (auth.kind === "ready") preloadScreens();
  }, [auth.kind]);

  // Сессия кончилась посреди работы — «откройте из бота заново»
  useEffect(() => {
    setUnauthorizedHandler(() => setAuth({ kind: "expired" }));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const chooseLang = useCallback(
    (code: Lang) => {
      setLang(code);
      saveLang(code);
      if (auth.kind === "ready") {
        void api
          .setLocale(code)
          .then((me) => setAuth({ kind: "ready", me }))
          .catch(() => {});
      }
    },
    [auth.kind],
  );

  const section = location ? SECTION_OF[location.route] : null;
  useEffect(() => {
    // До входа — просто кабинет: разделов ещё нет
    const name = auth.kind !== "ready" ? t.area : section ? t[section] : t.notFound;
    document.title = `${name} · Bayramm`;
  }, [auth.kind, section, t]);

  // После перехода фокус — на заголовок нового экрана, чтобы экранный диктор его прочёл.
  // Экран ещё грузится (данные, часть сборки) — фокус получит заголовок, когда появится.
  // При первом показе фокус не трогаем. Без прокрутки (ловушка №3); scrollTo есть не везде (ловушка №5)
  const path = location ? pathOf(location) : null;
  const shownPath = useRef(path);
  const headingEl = useRef<HTMLHeadingElement | null>(null);
  const focusPending = useRef(false);
  const headingRef = useCallback((el: HTMLHeadingElement | null) => {
    headingEl.current = el;
    if (el && focusPending.current) {
      focusPending.current = false;
      el.focus({ preventScroll: true });
    }
  }, []);
  useEffect(() => {
    if (shownPath.current === path) return;
    shownPath.current = path;
    const el = headingEl.current;
    if (el?.isConnected) {
      focusPending.current = false;
      el.focus({ preventScroll: true });
    } else focusPending.current = true;
    window.scrollTo?.(0, 0);
  }, [path]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // Вход упал без сети — связь вернулась, пробуем снова сами
  useOnReconnect(() => {
    if (auth.kind === "error") retry();
  });
  const uiTexts = useMemo(() => ({ close: t.close, clear: t.clear }), [t]);
  const screenProps = { t, lang, headingRef } as const;
  const onCounts = useCallback((counts: Readonly<Record<RequestTab, number>>) => setFresh(counts.new), []);
  // Значки «Витрины» и «Услуг» — из GET /vendor/me. Партнёр что-то исправил (удалил фото, отправил
  // услугу или предложение) или зашёл в раздел, где команда могла решить, — перечитываем тихо:
  // не вышло — значки прежние, экран на месте
  const refreshAttention = useCallback(() => {
    void api
      .me()
      .then((fresh) =>
        setAuth((current) => {
          if (current.kind !== "ready") return current;
          const listings = mergeListings(current.me.listings, fresh.listings);
          return listings === current.me.listings ? current : { ...current, me: { ...current.me, listings } };
        }),
      )
      .catch(() => {});
  }, []);
  const lastSection = useRef(section);
  const signedIn = auth.kind === "ready";
  useEffect(() => {
    if (lastSection.current === section) return;
    lastSection.current = section;
    if (signedIn && (section === "card" || section === "services")) refreshAttention();
  }, [section, signedIn, refreshAttention]);
  // Заявки одной витрины — только когда витрин несколько и выбрана одна
  const listings = ready?.me.listings ?? [];
  const attention = useMemo(() => attentionTotals(listings), [listings]);
  const inboxFilter = scope === "listing" && listings.length > 1 ? listingId : null;
  const filterInbox = useCallback(
    (id: string | null) =>
      confirmLeave(() => {
        if (id === null) setScope("all");
        else {
          setListingId(id);
          setScope("listing");
        }
      }),
    [confirmLeave],
  );

  // Витрина ещё не на сайте: из входящих — к её чек-листу готовности
  const openListing = useCallback(
    (id: string) =>
      confirmLeave(() => {
        setListingId(id);
        navigate({ route: "card" }, { force: true });
      }),
    [confirmLeave, navigate],
  );

  const signInHub = useCallback(() => {
    // Токен этого аккаунта не подошёл (не партнёр) — войти другим: старый забыть
    tokenStore.clear();
    chooseVendor(null);
    void startHub().then((started) => {
      if (!started) setAuth({ kind: "error" });
    });
  }, []);
  const switchVendor = useCallback(() => {
    chooseVendor(null);
    setFresh(null);
    retry();
  }, [retry]);

  let screen: ReactNode;
  if (auth.kind === "choose") {
    screen = <VendorChooser vendors={auth.vendors} t={t} headingRef={headingRef} onChosen={retry} />;
  } else if (auth.kind === "outside") {
    screen = <Welcome t={t} headingRef={headingRef} onSignIn={signInHub} />;
  } else if (auth.kind !== "ready") {
    screen = <Gate kind={auth.kind} t={t} headingRef={headingRef} onRetry={retry} onSignIn={signInHub} />;
  } else if (!location) {
    screen = (
      <section className="page page-narrow" aria-labelledby="page-title">
        <Heading headingRef={headingRef}>{t.notFound}</Heading>
        <p className="lead">{t.notFoundLead}</p>
        <NavLink to={{ route: HOME }} current={false} navigate={navigate} className="btn btn-ghost">
          {t.toHome}
        </NavLink>
      </section>
    );
  } else if (location.route === "calendar") {
    screen = (
      <Lazy part={SCREENS.calendar} t={t}>
        {({ Calendar }) => (
          <Calendar
            {...screenProps}
            listings={auth.me.listings}
            listingId={listingId}
            onListing={chooseListing}
            inSidebar={layout === "desktop"}
            navigate={navigate}
          />
        )}
      </Lazy>
    );
  } else if (location.route === "card") {
    screen = (
      <Lazy part={SCREENS.venue} t={t}>
        {({ Venue }) => (
          <Venue
            {...screenProps}
            listings={auth.me.listings}
            listingId={listingId}
            onListing={chooseListing}
            vendorCode={auth.me.vendor.code}
            role={auth.me.user.role}
            inSidebar={layout === "desktop"}
            navigate={navigate}
            onChanged={refreshAttention}
          />
        )}
      </Lazy>
    );
  } else if (location.route === "services") {
    screen = (
      <Lazy part={SCREENS.services} t={t}>
        {({ Services }) => (
          <Services
            {...screenProps}
            listings={auth.me.listings}
            listingId={listingId}
            onListing={chooseListing}
            role={auth.me.user.role}
            inSidebar={layout === "desktop"}
            onChanged={refreshAttention}
          />
        )}
      </Lazy>
    );
  } else if (location.route === "account") {
    screen = (
      <Lazy part={SCREENS.account} t={t}>
        {({ AccountPage }) => (
          <AccountPage {...screenProps} me={auth.me} onLang={chooseLang} onSwitch={switchVendor} />
        )}
      </Lazy>
    );
  } else {
    screen = (
      <Lazy part={SCREENS.inbox} t={t}>
        {({ Inbox }) => (
          <Inbox
            {...screenProps}
            id={location.route === "request" ? (location.id ?? null) : null}
            split={layout === "desktop"}
            tab={inboxTab}
            onTab={setInboxTab}
            navigate={navigate}
            listings={auth.me.listings}
            filter={inboxFilter}
            onFilter={filterInbox}
            // Выбор витрины на компьютере — в боковой панели, над списком его нет
            inSidebar={layout === "desktop"}
            onOpenListing={openListing}
            // Значок у раздела — новые всех витрин: счётчики одной витрины его не меняют
            onCounts={inboxFilter === null ? onCounts : undefined}
          />
        )}
      </Lazy>
    );
  }

  // Разделы — только в кабинете; до входа на любой ширине — шапка и экран по центру
  const shell = ready ? layout : "gate";
  return (
    <UiTextsProvider texts={uiTexts}>
      <UnsavedContext.Provider value={unsaved.registry}>
        <div className={`app app-${shell}`}>
          <a className="skip" href="#main">
            {t.skip}
          </a>
          {shell === "desktop" && ready ? (
            <aside className="side">
              <Brand t={t} />
              <Sections
                t={t}
                section={section}
                navigate={navigate}
                fresh={fresh}
                attention={attention}
                className="side-nav"
                linkClass="side-link"
              />
              <SideVitrinas
                listings={ready.me.listings}
                value={section === "requests" ? inboxFilter : listingId}
                onChange={section === "requests" ? filterInbox : (id) => id && chooseListing(id)}
                allLabel={section === "requests" ? t.allListings : undefined}
                mark={section === "card" || section === "services" ? section : undefined}
                t={t}
                lang={lang}
              />
              <div className="side-foot">
                <p className="side-vendor">
                  <span className="side-vendor-name">{ready.me.vendor.name || ready.me.vendor.code}</span>
                  <span className="side-vendor-code">
                    {fill(t.vendorCode, { code: ready.me.vendor.code })}
                  </span>
                </p>
                <LangSwitch lang={lang} t={t} onChange={chooseLang} />
              </div>
            </aside>
          ) : (
            <header className="top">
              <Brand t={t} />
              <LangSwitch lang={lang} t={t} onChange={chooseLang} />
            </header>
          )}
          {shell === "tablet" ? (
            <Sections
              t={t}
              section={section}
              navigate={navigate}
              fresh={fresh}
              attention={attention}
              className="rail"
              linkClass="rail-link"
            />
          ) : null}
          <div className="frame">
            <OfflineBanner offline={t.offline} back={t.backOnline} />
            <main id="main" className="main" tabIndex={-1}>
              {screen}
            </main>
          </div>
          {shell === "phone" ? (
            <Sections
              t={t}
              section={section}
              navigate={navigate}
              fresh={fresh}
              attention={attention}
              className="tabbar"
              linkClass="tab"
            />
          ) : null}
        </div>
        {unsaved.sheet}
      </UnsavedContext.Provider>
    </UiTextsProvider>
  );
}
