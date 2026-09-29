import type { AuthMethods } from "@bayramm/shared/api/account";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/errors";
import { saveSiteSession } from "../api/session";
import { authErrorText, PhoneCode } from "../components/PhoneCode";
import { Loading } from "../components/States";
import { telegramLink } from "../components/TelegramCta";
import { TelegramLogin } from "../components/TelegramLogin";
import { useLang, useServices } from "../context";
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
     · «Подключить Telegram» из профиля (link=telegram): только виджет.
   Уже вошли (Mini App или сессия сайта) — сразу дальше, без второго входа. Панели нужен
   свежий вход (не старше 12 часов): иначе API отвечает reauth_required, и хаб просит
   войти ещё раз. После входа страница загружается заново — сессия есть у всего сайта. */

type Phase =
  | { readonly kind: "form"; readonly notice: string | null }
  | { readonly kind: "continuing" }
  | { readonly kind: "badLink" };

/** Дальше после входа: код хаба и уход в приложение или назад на сайт */
function useContinue(setPhase: (phase: Phase) => void) {
  const { api, identity } = useServices();
  const { t } = useLang();
  const retried = useRef(false);

  return useCallback(async () => {
    const request = loadHubRequest();
    if (request === null) {
      browser.replace(takeReturn());
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
  }, [api, identity, t, setPhase]);
}

function TelegramBlock({ methods, link }: { methods: AuthMethods; link: boolean }) {
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
          <p className="muted small">{t.authTelegramHint}</p>
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
  const { api, identity } = useServices();
  const { t, lang } = useLang();
  const { query } = useNav();
  useDocumentTitle(t.authTitle);
  const [phase, setPhase] = useState<Phase>({ kind: "continuing" });
  const methods = useAsync("auth-methods", (signal) => api.authMethods(signal));
  const proceed = useContinue(setPhase);
  const link = query.get("link") === "telegram";
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
    if (signedIn && !link && query.get("fresh") !== "1") void proceed();
    else setPhase({ kind: "form", notice: query.get("fresh") === "1" ? t.authAgain : null });
  }, [query, identity, link, proceed, t]);

  const onPhoneCode = async (phone: string, code: string) => {
    const session = await api.verifyPhoneCode(phone, code, lang);
    saveSiteSession(session);
    // Страница — заново: у всего сайта теперь есть сессия; дальше — useContinue
    browser.replace(AUTH_PATH);
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
  return (
    <div className="screen auth">
      <h1 className="screen-title" tabIndex={-1}>
        {link ? t.authLinkTitle : t.authTitle}
      </h1>
      {phase.kind === "continuing" ? (
        <p className="muted" role="status">
          {t.authContinuing}
        </p>
      ) : (
        <>
          <p className="auth-lead">
            {hub?.app === "vendor" ? t.authForVendor : hub?.app === "admin" ? t.authForAdmin : t.authLead}
          </p>
          {phase.notice ? (
            <div className="callout" role="alert">
              <Icon name="info" size={17} />
              <span>{phase.notice}</span>
            </div>
          ) : null}
          {methods.status === "loading" ? <Loading /> : null}
          {methods.status === "ready" ? (
            <>
              <TelegramBlock methods={methods.data} link={link} />
              {methods.data.phone && !link ? (
                <section className="section auth-block" aria-labelledby="auth-phone">
                  <h2 className="section-title" id="auth-phone">
                    {t.authPhone}
                  </h2>
                  <PhoneCode onCode={onPhoneCode} submitLabel={t.authSignIn} />
                </section>
              ) : null}
            </>
          ) : null}
          {methods.status === "error" ? (
            <p className="fld-error" role="alert">
              {t.authErr}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** /auth/telegram — сюда возвращает виджет: войти или подключить Telegram к аккаунту */
export function TelegramCallback() {
  const { api } = useServices();
  const { t, lang } = useLang();
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
      ? api.linkTelegram({ widget: fields }).then(() => browser.replace(takeReturn()))
      : api.signInWidget(fields, lang).then((session) => {
          saveSiteSession(session);
          browser.replace(AUTH_PATH);
        });
    run.catch((err: unknown) => setError(authErrorText(t, err)));
  }, [api, lang, t]);

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
