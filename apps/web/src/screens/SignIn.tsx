import type { AuthMethods } from "@bayramm/shared/api/account";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/errors";
import { saveSiteSession } from "../api/session";
import { authErrorText, humanProofFor, PhoneCode } from "../components/PhoneCode";
import { ErrorState, Loading } from "../components/States";
import { telegramLink } from "../components/TelegramCta";
import { TelegramLogin } from "../components/TelegramLogin";
import { useAccount, useLang, useServices } from "../context";
import { useAsync, useDocumentTitle } from "../hooks";
import {
  AUTH_PATH,
  browser,
  clearHubRequest,
  clearTelegramLink,
  isTelegramLink,
  loadHubRequest,
  parseHubRequest,
  readWidgetFields,
  saveHubRequest,
  saveReturn,
  startTelegramLink,
  takeReturn,
} from "../hub";
import { Icon } from "../icons";
import { useNav } from "../router";

/* Хаб входа — /auth. Один вход для всего Bayramm:
     · вход на сайт: виджет Telegram (только на домене бота) или код из сообщения;
     · вход в кабинет и панель: они присылают app, state и challenge (PKCE) — после входа
       API выдаёт одноразовый код, и браузер уходит на <приложение>/auth/callback;
     · «Подключить Telegram» из профиля (link=telegram): только виджет;
     · «Добавить телефон» из профиля на сайте (link=phone): только код — здесь, потому что
       проверка «не робот» (Turnstile) разрешена CSP только на страницах /auth.
   Уже вошли (Mini App или сессия сайта) — сразу дальше, без второго входа. Панели нужен
   свежий вход (не старше 12 часов): иначе API отвечает reauth_required, и хаб просит
   войти ещё раз. После входа страница загружается заново — сессия есть у всего сайта. */

type Phase =
  | { readonly kind: "form"; readonly notice: string | null }
  | { readonly kind: "continuing" }
  | { readonly kind: "badLink" };

/**
 * Дальше после входа: код хаба и уход в приложение (адрес строит API) или назад на сайт —
 * переходом внутри приложения: сессия у этой загрузки страницы уже есть, а путь возврата
 * пришёл из адреса и уводит только на свой экран
 */
function useContinue(setPhase: (phase: Phase) => void) {
  const { api, identity } = useServices();
  const { t } = useLang();
  const { navigate } = useNav();
  const retried = useRef(false);

  return useCallback(async () => {
    const request = loadHubRequest();
    if (request === null) {
      navigate(takeReturn(), { replace: true });
      return;
    }
    setPhase({ kind: "continuing" });
    try {
      const { redirectUrl } = await api.hubCode(request);
      clearHubRequest();
      browser.replace(redirectUrl);
    } catch (error) {
      // Внутри Telegram токен вкладки мог остаться от давнего входа: забыть и войти заново по initData
      if (
        error instanceof ApiError &&
        error.code === "reauth_required" &&
        identity === "telegram" &&
        !retried.current
      ) {
        retried.current = true;
        api.forgetSession();
        return void (await api.hubCode(request).then(
          ({ redirectUrl }) => {
            clearHubRequest();
            browser.replace(redirectUrl);
          },
          (again: unknown) => setPhase({ kind: "form", notice: authErrorText(t, again) }),
        ));
      }
      setPhase({ kind: "form", notice: authErrorText(t, error) });
    }
  }, [api, identity, t, setPhase, navigate]);
}

/**
 * Вход через Telegram: виджет (только на домене бота) и ссылка на бота. Подсказка под
 * виджетом — на случай, когда он сам показывает ошибку (домен боту ещё не задан): тогда
 * выход — Bayramm в Telegram, а телефон упоминается, только если вход по нему здесь есть
 */
function TelegramBlock({ methods, link, phone }: { methods: AuthMethods; link: boolean; phone: boolean }) {
  const { t } = useLang();
  const [failed, setFailed] = useState(false);
  const onError = useCallback(() => setFailed(true), []);
  const bot = methods.telegram.bot;
  const here =
    methods.telegram.loginDomain !== null && methods.telegram.loginDomain === window.location.hostname;
  const botHref = bot ? telegramLink(bot) : null;

  return (
    <section className="section auth-block" aria-labelledby="auth-telegram">
      <h2 className="section-title" id="auth-telegram">
        {link ? t.authLinkTitle : t.authTelegram}
      </h2>
      {here && bot && !failed ? (
        <>
          <TelegramLogin bot={bot} onLoadError={onError} />
          {link ? null : <p className="muted small">{phone ? t.authTelegramHint : t.authTelegramHintBot}</p>}
        </>
      ) : (
        <p className="muted small">{t.authTelegramOff}</p>
      )}
      {botHref && !link ? (
        <a className="btn btn-secondary wide" href={botHref} target="_blank" rel="noopener noreferrer">
          <Icon name="tg" size={20} />
          {t.authOpenBot}
        </a>
      ) : null}
    </section>
  );
}

export function SignIn() {
  const { api, identity, webApp } = useServices();
  const { t, lang } = useLang();
  const { me } = useAccount();
  const { query, navigate } = useNav();
  const replaceMe = me.replace;
  const [phase, setPhase] = useState<Phase>({ kind: "continuing" });
  const methods = useAsync("auth-methods", (signal) => api.authMethods(signal));
  const proceed = useContinue(setPhase);
  const link = query.get("link") === "telegram";
  // Добавить телефон — только вошедшему; гостю хаб показывает обычный вход
  const linkPhone = query.get("link") === "phone" && identity !== "guest";
  useDocumentTitle(linkPhone ? t.authLinkPhoneTitle : t.authTitle);
  const started = useRef(false);

  // Один раз при открытии: запомнить запрос хаба и путь возврата, вошедшего — дальше
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const request = parseHubRequest(query);
    if (request === "invalid") {
      clearHubRequest();
      setPhase({ kind: "badLink" });
      return;
    }
    if (request) saveHubRequest(request);
    saveReturn(query.get("return"));
    if (link) startTelegramLink();
    else clearTelegramLink();
    // Адрес без параметров: state и challenge не остаются в истории вкладки
    if (window.location.search) window.history.replaceState(window.history.state, "", AUTH_PATH);
    const signedIn = identity !== "guest";
    if (signedIn && !link && !linkPhone && query.get("fresh") !== "1") void proceed();
    else setPhase({ kind: "form", notice: query.get("fresh") === "1" ? t.authAgain : null });
  }, [query, identity, link, linkPhone, proceed, t]);

  const onPhoneCode = async (phone: string, code: string) => {
    const session = await api.verifyPhoneCode(phone, code, lang);
    saveSiteSession(session);
    // Страница — заново: у всего сайта теперь есть сессия; дальше — useContinue
    browser.replace(AUTH_PATH);
  };

  // Профиль → «Добавить телефон»: код — к своему аккаунту, и назад в профиль
  const onLinkPhone = async (phone: string, code: string) => {
    replaceMe(await api.linkPhone(phone, code));
    navigate(takeReturn(), { replace: true });
  };

  if (phase.kind === "badLink") {
    return (
      <div className="screen auth">
        <h1 className="screen-title" tabIndex={-1}>
          {t.authTitle}
        </h1>
        <div className="callout callout-warn" role="alert">
          <Icon name="warnD" size={17} />
          <span>{t.authBadLink}</span>
        </div>
      </div>
    );
  }

  const hub = loadHubRequest();
  const ready = methods.status === "ready" ? methods.data : null;
  const human = ready ? humanProofFor(ready, webApp?.initData) : null;
  const title = linkPhone ? t.authLinkPhoneTitle : link ? t.authLinkTitle : t.authTitle;
  return (
    <div className="screen auth">
      <h1 className="screen-title" tabIndex={-1}>
        {title}
      </h1>
      {phase.kind === "continuing" ? (
        <p className="muted" role="status">
          {t.authContinuing}
        </p>
      ) : (
        <>
          {linkPhone ? null : (
            <p className="auth-lead">
              {hub?.app === "vendor" ? t.authForVendor : hub?.app === "admin" ? t.authForAdmin : t.authLead}
            </p>
          )}
          {phase.notice ? (
            <div className="callout" role="alert">
              <Icon name="info" size={17} />
              <span>{phase.notice}</span>
            </div>
          ) : null}
          {methods.status === "loading" ? <Loading /> : null}
          {ready && linkPhone ? (
            ready.phone ? (
              <section className="section auth-block" aria-labelledby="auth-phone">
                <h2 className="section-title" id="auth-phone">
                  {t.authPhone}
                </h2>
                <PhoneCode onCode={onLinkPhone} submitLabel={t.accAddPhone} human={human} />
              </section>
            ) : (
              <p className="muted">{t.authErrPhoneOff}</p>
            )
          ) : null}
          {ready && !linkPhone ? (
            <>
              <TelegramBlock methods={ready} link={link} phone={ready.phone && !link} />
              {ready.phone && !link ? (
                <section className="section auth-block" aria-labelledby="auth-phone">
                  <h2 className="section-title" id="auth-phone">
                    {t.authPhone}
                  </h2>
                  <PhoneCode onCode={onPhoneCode} submitLabel={t.authSignIn} human={human} />
                </section>
              ) : null}
            </>
          ) : null}
          {/* Способы входа не загрузились — «Повторить» (и сам повтор, когда вернётся связь) */}
          {methods.status === "error" ? <ErrorState message={t.errLoad} onRetry={methods.reload} /> : null}
        </>
      )}
    </div>
  );
}

/** /auth/telegram — сюда возвращает виджет: войти или подключить Telegram к аккаунту */
export function TelegramCallback() {
  const { api } = useServices();
  const { t, lang } = useLang();
  const { me } = useAccount();
  const { navigate } = useNav();
  const replaceMe = me.replace;
  useDocumentTitle(t.authTitle);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const fields = readWidgetFields(window.location.search);
    // Подписанные данные — не в истории вкладки
    window.history.replaceState(window.history.state, "", AUTH_PATH);
    if (fields === null) {
      setError(t.authBadLink);
      return;
    }
    const linking = isTelegramLink();
    clearTelegramLink();
    const run = linking
      ? api.linkTelegram({ widget: fields }).then((next) => {
          replaceMe(next);
          navigate(takeReturn(), { replace: true });
        })
      : api.signInWidget(fields, lang).then((session) => {
          saveSiteSession(session);
          browser.replace(AUTH_PATH);
        });
    run.catch((err: unknown) => setError(authErrorText(t, err)));
  }, [api, lang, t, replaceMe, navigate]);

  return (
    <div className="screen auth">
      <h1 className="screen-title" tabIndex={-1}>
        {t.authTitle}
      </h1>
      {error ? (
        <>
          <div className="callout callout-warn" role="alert">
            <Icon name="warnD" size={17} />
            <span>{error}</span>
          </div>
          <a className="btn btn-secondary wide" href={AUTH_PATH}>
            {t.authSignIn}
          </a>
        </>
      ) : (
        <p className="muted" role="status">
          {t.authContinuing}
        </p>
      )}
    </div>
  );
}
