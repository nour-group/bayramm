import { type MouseEvent, type ReactNode, type RefObject, useEffect, useRef } from "react";
import { HOME, NAV, ROUTES, type Route, useRoute } from "./router";
import { t } from "./texts";

interface NavLinkProps {
  to: Route;
  current: boolean;
  onNavigate: (route: Route) => void;
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
  route: Route | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onNavigate: (route: Route) => void;
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

export function App() {
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
      </header>
      <main id="main" className="main" tabIndex={-1}>
        <Page route={route} headingRef={heading} onNavigate={navigate} />
      </main>
    </div>
  );
}
