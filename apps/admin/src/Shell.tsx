/* Оболочка панели вошедшего сотрудника: навигация по разделам роли, заголовок экрана,
   аккаунт и другие приложения того же аккаунта, содержимое экрана.

   Раскладка (layout.ts):
     · телефон — шапка (назад, заголовок, аккаунт), нижняя панель с частыми разделами и
       «Ещё» с остальными; действия экрана — в панели над ней (ActionBar);
     · планшет — та же шапка и узкая колонка разделов слева;
     · компьютер — шапка с разделами в строку, как раньше.
   В Telegram «назад» — кнопка Telegram (BackButton), своя в шапке не рисуется. */

import type { MetricsOverview, OpsQueues, StaffDictionaries } from "@bayramm/shared/api/staff";
import { getWebApp } from "@bayramm/tg/webapp";
import { Dialog, useOnReconnect } from "@bayramm/ui/react";
import {
  type ReactNode,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLoad, useSession } from "./api";
import { Icon, type IconName } from "./icons";
import { type Layout, useLayout } from "./layout";
import {
  goBack,
  HOME,
  isNested,
  NAV,
  pathOf,
  SECTION_PERMISSION,
  type Section,
  sectionOf,
  tabsFor,
  useRoute,
  type View,
} from "./router";
import {
  AuditPage,
  ClientPage,
  ClientsPage,
  ListingNewPage,
  ListingPage,
  MetricsPage,
  ModerationPage,
  NotificationsPage,
  preloadSections,
  RequestPage,
  RequestsPage,
  RevisionPage,
  SettingsPage,
  TeamPage,
  VendorNewPage,
  VendorPage,
  VendorsPage,
} from "./screens";
import { fetchAccount, fetchMethods, SIGNIN_PARAM, type Staff } from "./session";
import { hasNativeBack, useBackButton } from "./telegram";
import { t } from "./texts";
import { ActionSlotContext, Link, NavigateContext, SheetClose, Skeleton, TitleContext } from "./ui";
import { UnsavedContext, useUnsavedGuard } from "./unsaved";

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

const SECTION_ICON: Readonly<Record<Section, { readonly icon: IconName; readonly active: IconName }>> = {
  vendors: { icon: "vendors", active: "vendorsFill" },
  moderation: { icon: "moderation", active: "moderationFill" },
  requests: { icon: "requests", active: "requestsFill" },
  metrics: { icon: "metrics", active: "metricsFill" },
  clients: { icon: "clients", active: "clientsFill" },
  notifications: { icon: "notifications", active: "notificationsFill" },
  audit: { icon: "audit", active: "auditFill" },
  team: { icon: "team", active: "teamFill" },
  settings: { icon: "settings", active: "settingsFill" },
};

// ── содержимое экрана ──────────────────────────────────────────────────────

interface PageProps {
  view: View | null;
  title: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  dictionaries: StaffDictionaries | null;
  /** Разделы роли: чужой раздел (старая ссылка, ссылка из бота) — «нет доступа», а не 403 */
  sections: readonly Section[];
}

function Page({ view, title, headingRef, dictionaries, sections }: PageProps) {
  // Место под панель действий — последним в странице (ActionBar на телефоне)
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
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
  if (!sections.includes(sectionOf(view))) {
    // Раздела у роли нет: сервер всё равно ответит 403 — не грузим и не предлагаем «Повторить»
    const home = sections[0] ?? HOME;
    return (
      <section className="page" aria-labelledby="page-title">
        {heading}
        <p className="lead">{t.noAccess}</p>
        <Link to={{ name: home }} className="action">
          {t.toSection(t[home])}
        </Link>
      </section>
    );
  }

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
    case "metrics":
      content = <MetricsPage />;
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
  const nested = view.name !== section;
  const lead = nested ? null : t[`${section}Lead`];
  return (
    <section className={`page${nested ? " page-wide" : ""}`} aria-labelledby="page-title">
      {heading}
      {lead && <p className="lead">{lead}</p>}
      <ActionSlotContext.Provider value={slot}>
        {/* Кусок экрана ещё грузится (первый заход в раздел) — заготовка его формы */}
        <Suspense fallback={<Skeleton kind={nested ? "detail" : "list"} />}>{content}</Suspense>
      </ActionSlotContext.Provider>
      <div ref={setSlot} className="actionbar-slot" />
    </section>
  );
}

// ── другие приложения аккаунта ─────────────────────────────────────────────

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

function OtherAppLinks({ apps, className }: { apps: OtherApps | null; className: string }) {
  if (!apps) return null;
  return (
    <>
      <a
        className={className}
        href={apps.web}
        onClick={viaBot(apps.bot ? `https://t.me/${apps.bot}?startapp` : null)}
      >
        {className === "menu-item" ? <Icon name="external" size={20} /> : null}
        <span>{t.toClientApp}</span>
      </a>
      {apps.cabinet ? (
        <a
          className={className}
          href={apps.cabinet}
          onClick={viaBot(apps.bot ? `https://t.me/${apps.bot}?start=cabinet` : null)}
        >
          {className === "menu-item" ? <Icon name="external" size={20} /> : null}
          <span>{t.toCabinet}</span>
        </a>
      ) : null}
    </>
  );
}

// ── счётчики у разделов ────────────────────────────────────────────────────

export type Badges = Partial<Record<Section, number>>;

/** Что ждёт команду — из очередей метрик: просроченные заявки, решения модерации, недоставленное */
export function badgesOf(queues: OpsQueues): Badges {
  return {
    requests: queues.overdue,
    moderation: queues.listingsReview + queues.revisionsPending + queues.photosPending,
    notifications: queues.deadTotal,
  };
}

/** Раз в минуту, не чаще: при смене раздела и когда вернулась связь. Без права метрик — нет */
const BADGES_TTL_MS = 60_000;

function useBadges(enabled: boolean, section: Section | null): Badges {
  const { api } = useSession();
  const [badges, setBadges] = useState<Badges>({});
  const fetched = useRef<number | null>(null);
  const refresh = useCallback(
    (force: boolean) => {
      if (!enabled) return;
      const now = Date.now();
      if (!force && fetched.current !== null && now - fetched.current < BADGES_TTL_MS) return;
      fetched.current = now;
      void api.get<MetricsOverview>("/staff/metrics?weeks=1").then((result) => {
        if (result.ok) setBadges(badgesOf(result.data.queues));
      });
    },
    [api, enabled],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: section — повод перечитать
  useEffect(() => refresh(false), [refresh, section]);
  useOnReconnect(() => refresh(true));
  return badges;
}

function Badge({ section, count }: { section: Section; count: number | undefined }) {
  if (!count) return null;
  const label = t.badges[section as keyof typeof t.badges];
  return (
    <>
      <span className="badge" aria-hidden="true">
        {count > 99 ? "99+" : count}
      </span>
      {label ? <span className="visually-hidden">, {label(count)}</span> : null}
    </>
  );
}

// ── шапка и навигация телефона и планшета ──────────────────────────────────

/** Инициалы для кружка аккаунта: две первые буквы имени и фамилии */
export function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase());
  return letters.join("") || "•";
}

/** Заголовок страницы ушёл под шапку — шапка показывает его сама */
function useScrolledPast(target: RefObject<HTMLElement | null>, key: string | null, enabled: boolean) {
  const [past, setPast] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key — новый экран, наблюдать заново
  useEffect(() => {
    setPast(false);
    const node = target.current;
    if (!enabled || !node) return;
    // Нет IntersectionObserver (старый вебвью) — заголовок в шапке виден всегда
    if (typeof IntersectionObserver !== "function") {
      setPast(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setPast(!entry.isIntersecting && entry.boundingClientRect.top < 0);
      },
      { rootMargin: "-64px 0px 0px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [target, key, enabled]);
  return past;
}

/** Поле ввода в фокусе: на телефоне открыта клавиатура — нижняя панель прячется */
function isTextEntry(element: EventTarget | null): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement)
    return !["checkbox", "radio", "file", "button", "submit", "reset", "range", "color"].includes(
      element.type,
    );
  return element instanceof HTMLElement && element.isContentEditable;
}

function useTyping(enabled: boolean): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setTyping(false);
      return;
    }
    const onIn = (event: FocusEvent) => setTyping(isTextEntry(event.target));
    const onOut = (event: FocusEvent) => setTyping(isTextEntry(event.relatedTarget));
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, [enabled]);
  return typing;
}

interface BarProps {
  staff: Staff;
  view: View | null;
  title: string;
  showTitle: boolean;
  onBack: (() => void) | null;
  accountRef: RefObject<HTMLButtonElement | null>;
  accountOpen: boolean;
  onAccount: () => void;
}

/** Шапка телефона и планшета: «назад» или название панели, заголовок экрана, аккаунт */
function TopBar({ staff, view, title, showTitle, onBack, accountRef, accountOpen, onAccount }: BarProps) {
  const section = view ? sectionOf(view) : null;
  // Экран объекта, пока его заголовок на виду, — название раздела; ушёл под шапку — сам заголовок
  const barTitle = showTitle ? title : view && isNested(view) && section ? t[section] : null;
  return (
    <header className="appbar">
      {onBack ? (
        <button type="button" className="appbar-btn" aria-label={t.back} onClick={onBack}>
          <Icon name="back" size={24} />
        </button>
      ) : null}
      {!onBack && !barTitle ? (
        <Link to={{ name: HOME }} className="appbar-brand">
          Bayramm <span className="brand-area">{t.area}</span>
        </Link>
      ) : null}
      {barTitle ? (
        <p className="appbar-title" aria-hidden="true">
          {barTitle}
        </p>
      ) : (
        <span className="appbar-spacer" />
      )}
      <button
        ref={accountRef}
        type="button"
        className="appbar-account"
        aria-label={t.accountOf(staff.displayName, t.roles[staff.role])}
        aria-haspopup="dialog"
        aria-expanded={accountOpen}
        onClick={onAccount}
      >
        <span className="avatar" aria-hidden="true">
          {initialsOf(staff.displayName)}
        </span>
      </button>
    </header>
  );
}

interface NavProps {
  sections: readonly Section[];
  current: Section | null;
  badges: Badges;
}

/** Узкая колонка разделов планшета: иконка и подпись */
function Rail({ sections, current, badges }: NavProps) {
  return (
    <nav className="rail" aria-label={t.sections}>
      {sections.map((section) => {
        const on = current === section;
        return (
          <Link
            key={section}
            to={{ name: section }}
            current={on}
            className="rail-link"
            onPrefetch={() => preloadSections([section])}
          >
            <span className="rail-icon">
              <Icon name={on ? SECTION_ICON[section].active : SECTION_ICON[section].icon} size={24} />
              <Badge section={section} count={badges[section]} />
            </span>
            <span className="rail-label">{t[section]}</span>
          </Link>
        );
      })}
    </nav>
  );
}

interface TabBarProps extends NavProps {
  moreRef: RefObject<HTMLButtonElement | null>;
  moreOpen: boolean;
  onMore: () => void;
}

/** Нижняя панель телефона: частые разделы роли и «Ещё» с остальными */
function TabBar({ sections, current, badges, moreRef, moreOpen, onMore }: TabBarProps) {
  const { tabs, more } = tabsFor(sections);
  const inMore = current !== null && more.includes(current);
  const moreCount = more.reduce((sum, section) => sum + (badges[section] ?? 0), 0);
  return (
    <nav className={`tabbar tabbar-${tabs.length + (more.length > 0 ? 1 : 0)}`} aria-label={t.sections}>
      {tabs.map((section) => {
        const on = current === section;
        return (
          <Link
            key={section}
            to={{ name: section }}
            current={on}
            className="tab"
            onPrefetch={() => preloadSections([section])}
          >
            <span className="tab-icon">
              <Icon name={on ? SECTION_ICON[section].active : SECTION_ICON[section].icon} size={24} />
              <Badge section={section} count={badges[section]} />
            </span>
            {/* Название раздела целиком: в панели только разделы с короткими названиями */}
            <span className="tab-label">{t[section]}</span>
          </Link>
        );
      })}
      {more.length > 0 ? (
        <button
          ref={moreRef}
          type="button"
          className={`tab${inMore ? " is-current" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-label={inMore && current ? t.moreCurrent(t[current]) : t.more}
          onClick={onMore}
        >
          <span className="tab-icon">
            <Icon name={inMore ? "moreFill" : "more"} size={24} />
            {moreCount > 0 ? <span className="badge badge-dot" aria-hidden="true" /> : null}
          </span>
          <span className="tab-label" aria-hidden="true">
            {t.more}
          </span>
        </button>
      ) : null}
    </nav>
  );
}

// ── оболочка ───────────────────────────────────────────────────────────────

interface ShellProps {
  staff: Staff;
  token: string;
  onSignOut: () => void;
}

/** Панель вошедшего сотрудника: навигация по разделам роли, аккаунт, содержимое экрана */
export function Shell({ staff, token, onSignOut }: ShellProps) {
  const webApp = getWebApp();
  // Несохранённые правки на экране: уход — по ссылке, «назад», выход — с вопросом
  const unsaved = useUnsavedGuard(webApp);
  const [view, navigate] = useRoute(unsaved.guard);
  const layout: Layout = useLayout();
  const compact = layout !== "desktop";
  const apps = useOtherApps(token);
  const heading = useRef<HTMLHeadingElement>(null);
  const shownPath = useRef(view ? pathOf(view) : null);
  const path = view ? pathOf(view) : null;
  const nested = isNested(view);
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
  const sections = useMemo(
    () => NAV.filter((item) => staff.permissions.includes(SECTION_PERMISSION[item])),
    [staff],
  );
  const current = view ? sectionOf(view) : null;
  const badges = useBadges(staff.permissions.includes("metrics.read"), current);
  const [sheet, setSheet] = useState<"more" | "account" | null>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const titleShown = useScrolledPast(heading, path, compact);
  const typing = useTyping(layout === "phone");

  const back = useCallback(() => goBack(view, navigate), [view, navigate]);
  useBackButton(webApp, nested, back);
  const ownBack = nested && compact && !hasNativeBack(webApp) ? back : null;

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

  // Пока человек смотрит на первый экран — подгрузить разделы нижней панели (или все)
  useEffect(() => {
    const next = layout === "phone" ? tabsFor(sections).tabs : sections;
    const run = () => preloadSections(next);
    const idle = (window as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (typeof idle === "function") idle(run);
    else setTimeout(run, 1500);
  }, [layout, sections]);

  const closeSheet = useCallback(() => setSheet(null), []);
  const { confirmLeave } = unsaved;
  const signOut = useCallback(() => {
    setSheet(null);
    confirmLeave(onSignOut);
  }, [confirmLeave, onSignOut]);

  return (
    <NavigateContext.Provider value={navigate}>
      <div className={`app app-${layout}${typing ? " app-typing" : ""}`}>
        <a className="skip" href="#main">
          {t.skip}
        </a>
        {compact ? (
          <TopBar
            staff={staff}
            view={view}
            title={title}
            showTitle={titleShown}
            onBack={ownBack}
            accountRef={accountButton}
            accountOpen={sheet === "account"}
            onAccount={() => setSheet("account")}
          />
        ) : (
          <header className="top">
            <Link to={{ name: HOME }} className="brand">
              Bayramm <span className="brand-area">{t.area}</span>
            </Link>
            <nav className="nav" aria-label={t.sections}>
              {sections.map((item) => (
                <Link
                  key={item}
                  to={{ name: item }}
                  current={current === item}
                  onPrefetch={() => preloadSections([item])}
                >
                  {t[item]}
                  <Badge section={item} count={badges[item]} />
                </Link>
              ))}
            </nav>
            <div className="who">
              <p className="who-name">
                <span className="visually-hidden">{t.signedInAs} </span>
                {staff.displayName}
                <span className="who-role">{t.roles[staff.role]}</span>
              </p>
              <OtherAppLinks apps={apps} className="action" />
              <button type="button" className="action" onClick={signOut}>
                {t.signOut}
              </button>
            </div>
          </header>
        )}
        {layout === "tablet" ? <Rail sections={sections} current={current} badges={badges} /> : null}
        <main id="main" className="main" tabIndex={-1}>
          <UnsavedContext.Provider value={unsaved.registry}>
            <TitleContext.Provider value={setTitle}>
              <Page
                view={view}
                title={title}
                headingRef={heading}
                dictionaries={dictionaries}
                sections={sections}
              />
            </TitleContext.Provider>
          </UnsavedContext.Provider>
        </main>
        {layout === "phone" ? (
          <TabBar
            sections={sections}
            current={current}
            badges={badges}
            moreRef={moreButton}
            moreOpen={sheet === "more"}
            onMore={() => setSheet("more")}
          />
        ) : null}
        <Dialog
          open={sheet === "more"}
          title={t.moreSections}
          onClose={closeSheet}
          returnFocus={moreButton}
          actions={<SheetClose onClose={closeSheet} />}
        >
          <nav aria-label={t.moreSections}>
            <ul className="menu">
              {tabsFor(sections).more.map((section) => (
                <li key={section}>
                  <Link
                    to={{ name: section }}
                    current={current === section}
                    className="menu-item"
                    onNavigate={closeSheet}
                  >
                    <Icon
                      name={current === section ? SECTION_ICON[section].active : SECTION_ICON[section].icon}
                      size={20}
                    />
                    <span>{t[section]}</span>
                    <Badge section={section} count={badges[section]} />
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </Dialog>
        <Dialog
          open={sheet === "account"}
          title={t.account}
          onClose={closeSheet}
          returnFocus={accountButton}
          actions={<SheetClose onClose={closeSheet} />}
        >
          <div className="who who-sheet">
            <span className="avatar avatar-lg" aria-hidden="true">
              {initialsOf(staff.displayName)}
            </span>
            <p className="who-name">
              <span className="visually-hidden">{t.signedInAs} </span>
              {staff.displayName}
              <span className="who-role">{t.roles[staff.role]}</span>
            </p>
          </div>
          <ul className="menu">
            {apps ? (
              <li className="menu-group">
                <OtherAppLinks apps={apps} className="menu-item" />
              </li>
            ) : null}
            <li>
              <button type="button" className="menu-item menu-danger" onClick={signOut}>
                <Icon name="signOut" size={20} />
                <span>{t.signOut}</span>
              </button>
            </li>
          </ul>
        </Dialog>
        {unsaved.sheet}
      </div>
    </NavigateContext.Provider>
  );
}
