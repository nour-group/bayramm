import {
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Login } from "./Login";
import { HOME, matchRoute, NAV, ROUTES, type Section, useRoute } from "./router";
import {
  fetchStaff,
  readWidgetCallback,
  type SignInError,
  type Staff,
  signIn,
  signOut,
  tokenStore,
} from "./session";
import { t } from "./texts";

interface NavLinkProps {
  to: Section;
  current: boolean;
  onNavigate: (section: Section) => void;
  className?: string;
  children: ReactNode;
}

function NavLink({ to, current, onNavigate, className, children }: NavLinkProps) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // Новая вкладка, окно, скачивание — пусть решает браузер
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(to);
  };
  return (
    <a href={ROUTES[to]} className={className} aria-current={current ? "page" : undefined} onClick={onClick}>
      {children}
    </a>
  );
}

interface PageProps {
  route: Section | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onNavigate: (section: Section) => void;
}

function Page({ route, headingRef, onNavigate }: PageProps) {
  if (!route)
    return (
      <section className="page" aria-labelledby="page-title">
        <h1 id="page-title" className="page-title" ref={headingRef} tabIndex={-1}>
          {t.notFound}
        </h1>
        <p className="lead">{t.notFoundLead}</p>
        <NavLink to={HOME} current={false} onNavigate={onNavigate} className="action">
          {t.toHome}
        </NavLink>
      </section>
    );

  return (
    <section className="page" aria-labelledby="page-title">
      <h1 id="page-title" className="page-title" ref={headingRef} tabIndex={-1}>
        {t[route]}
      </h1>
      <p className="lead">{t[`${route}Lead`]}</p>
      <p className="soon">{t.soon}</p>
    </section>
  );
}

interface ShellProps {
  staff: Staff;
  onSignOut: () => void;
}

/** Панель вошедшего сотрудника: шапка с разделами и именем, содержимое раздела */
function Shell({ staff, onSignOut }: ShellProps) {
  const [route, navigate] = useRoute();
  const heading = useRef<HTMLHeadingElement>(null);
  const shownRoute = useRef(route);

  useEffect(() => {
    document.title = `${route ? t[route] : t.notFound} · Bayramm`;
  }, [route]);

  // После перехода фокус — на заголовок нового раздела, чтобы экранный диктор его прочёл.
  // При первом показе фокус не трогаем. Без прокрутки (ловушка №3); scrollTo есть не везде (ловушка №5)
  useEffect(() => {
    if (shownRoute.current === route) return;
    shownRoute.current = route;
    heading.current?.focus({ preventScroll: true });
    window.scrollTo?.(0, 0);
  }, [route]);

  return (
    <div className="app">
      <a className="skip" href="#main">
        {t.skip}
      </a>
      <header className="top">
        <NavLink to={HOME} current={false} onNavigate={navigate} className="brand">
          Bayramm <span className="brand-area">{t.area}</span>
        </NavLink>
        <nav className="nav" aria-label={t.sections}>
          {NAV.map((item) => (
            <NavLink key={item} to={item} current={route === item} onNavigate={navigate}>
              {t[item]}
            </NavLink>
          ))}
        </nav>
        <div className="who">
          <p className="who-name">
            <span className="visually-hidden">{t.signedInAs} </span>
            {staff.displayName}
            <span className="who-role">{t.roles[staff.role]}</span>
          </p>
          <button type="button" className="action" onClick={onSignOut}>
            {t.signOut}
          </button>
        </div>
      </header>
      <main id="main" className="main" tabIndex={-1}>
        <Page route={route} headingRef={heading} onNavigate={navigate} />
      </main>
    </div>
  );
}

type Auth =
  | { kind: "checking" }
  | { kind: "signedOut"; error: SignInError | null }
  | { kind: "signedIn"; staff: Staff; token: string };

// Сессия при открытии панели: данные виджета из адреса возврата или сохранённый токен
async function restore(): Promise<Auth> {
  if (matchRoute(window.location.pathname) === "loginTelegram") {
    const fields = readWidgetCallback(window.location.search);
    // Подписанные данные — пропуск на вход: убираем их из адреса и истории до запроса
    window.history.replaceState(null, "", ROUTES.login);
    if (!fields) return { kind: "signedOut", error: "invalid" };
    const result = await signIn(fields);
    if (!result.ok) return { kind: "signedOut", error: result.error };
    tokenStore.set(result.token);
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

  const onSignOut = useCallback(() => {
    if (auth.kind !== "signedIn") return;
    tokenStore.clear();
    void signOut(auth.token);
    window.history.replaceState(null, "", ROUTES.login);
    setAuth({ kind: "signedOut", error: null });
  }, [auth]);

  if (auth.kind === "signedIn") return <Shell staff={auth.staff} onSignOut={onSignOut} />;
  return (
    <Login
      bot={import.meta.env.VITE_TG_BOT_USERNAME}
      checking={auth.kind === "checking"}
      error={auth.kind === "signedOut" ? auth.error : null}
    />
  );
}
