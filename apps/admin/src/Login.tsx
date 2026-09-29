import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMethods, type SignInError } from "./session";
import { t } from "./texts";

/* Страница входа в панель. Вход — аккаунтом Bayramm через хаб входа на сайте (Telegram
   или телефон): панель уводит туда браузер с PKCE и получает назад одноразовый код. В
   Telegram панель открывается кнопкой «Панель оператора» в боте — там вход сам, по
   initData. Здесь — кнопка хаба и ссылка на бота окружения (его имя — у API). */

// Имя бота: 5–32 символа латиницы, цифр и _, в конце — bot (правила @BotFather)
const BOT_USERNAME_RE = /^[A-Za-z0-9_]{2,29}bot$/i;

function BotLink() {
  const [bot, setBot] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetchMethods().then((methods) => {
      const name = methods?.telegram.bot;
      if (active && name && BOT_USERNAME_RE.test(name)) setBot(name);
    });
    return () => {
      active = false;
    };
  }, []);
  if (bot === null) return null;
  return (
    <p className="login-bot">
      {t.loginMiniApp}{" "}
      <a href={`https://t.me/${bot}?start=admin`} target="_blank" rel="noopener noreferrer">
        {t.loginOpenBot}
      </a>
    </p>
  );
}

interface LoginProps {
  /** Идёт проверка: сохранённый токен, возврат из хаба или вход Mini App */
  checking: boolean;
  error: SignInError | null;
  /** В хаб входа; false — адрес сайта не узнать (API не ответило) */
  onSignIn: () => Promise<boolean>;
}

export function Login({ checking, error, onSignIn }: LoginProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    document.title = `${t.login} · Bayramm`;
  }, []);

  // Отказ во входе — фокус на заголовок, чтобы диктор прочёл страницу с ошибкой заново
  useEffect(() => {
    if (error) heading.current?.focus({ preventScroll: true });
  }, [error]);

  const signIn = useCallback(async () => {
    setStarting(true);
    setFailed(false);
    const started = await onSignIn();
    if (!started) {
      setStarting(false);
      setFailed(true);
    }
  }, [onSignIn]);

  const shown = failed ? "unavailable" : error;
  return (
    <div className="app">
      <main id="main" className="login" tabIndex={-1}>
        <section className="login-card" aria-labelledby="login-title">
          <p className="brand">
            Bayramm <span className="brand-area">{t.area}</span>
          </p>
          <h1 id="login-title" className="page-title" ref={heading} tabIndex={-1}>
            {t.login}
          </h1>
          <p className="lead">{t.loginLead}</p>
          {shown && (
            <p className="login-error" role="alert">
              {t.errors[shown]}
            </p>
          )}
          {checking ? (
            <p className="login-status" role="status">
              {t.loginChecking}
            </p>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-primary login-hub"
                disabled={starting}
                onClick={signIn}
              >
                {starting ? t.loginStarting : t.loginHub}
              </button>
              <BotLink />
            </>
          )}
        </section>
      </main>
    </div>
  );
}
