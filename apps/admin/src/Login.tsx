import { useCallback, useEffect, useRef, useState } from "react";
import { ROUTES } from "./router";
import { fetchBotUsername, type SignInError } from "./session";
import { t } from "./texts";

/* Официальный виджет входа Telegram. Колбэк data-onauth виджет собирает через eval, а CSP
   панели eval не пропускает (packages/edge), поэтому data-auth-url: после «Войти» виджет
   уводит браузер на /login/telegram?id=…&hash=…, и App отдаёт эти поля API. */
export const TELEGRAM_WIDGET_SRC = "https://telegram.org/js/telegram-widget.js?22";

interface WidgetProps {
  bot: string;
  onLoadError: () => void;
}

function TelegramLoginWidget({ bot, onLoadError }: WidgetProps) {
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = slot.current;
    if (!host) return;
    // Скрипт ставит iframe кнопки рядом с собой; данные виджета — атрибуты data-*
    const script = document.createElement("script");
    script.async = true;
    script.src = TELEGRAM_WIDGET_SRC;
    script.dataset.telegramLogin = bot;
    script.dataset.size = "large";
    script.dataset.authUrl = new URL(ROUTES.loginTelegram, window.location.origin).href;
    script.addEventListener("error", onLoadError);
    host.append(script);
    return () => {
      script.removeEventListener("error", onLoadError);
      host.replaceChildren();
    };
  }, [bot, onLoadError]);

  return <div className="tg-login" ref={slot} />;
}

type BotState = { kind: "loading" } | { kind: "ready"; username: string } | { kind: "failed" };

interface SignInButtonProps {
  /** Попробовать ещё раз: Login монтирует кнопку заново (новый key) — с новым запросом */
  onRetry: () => void;
}

/* Кнопка входа. Имя бота берём у API при показе страницы (у каждого окружения свой бот,
   в сборке его нет), потом ставим виджет. Пока ждём — статус; API не ответило или виджет
   не загрузился — ошибка и «Повторить». */
function SignInButton({ onRetry }: SignInButtonProps) {
  const [bot, setBot] = useState<BotState>({ kind: "loading" });
  const [widgetFailed, setWidgetFailed] = useState(false);
  // Стабильная ссылка: иначе каждый рендер пересоздавал бы скрипт виджета
  const onWidgetError = useCallback(() => setWidgetFailed(true), []);

  useEffect(() => {
    let active = true;
    void fetchBotUsername().then((username) => {
      if (active) setBot(username ? { kind: "ready", username } : { kind: "failed" });
    });
    return () => {
      active = false;
    };
  }, []);

  if (bot.kind === "loading")
    return (
      <p className="login-status" role="status">
        {t.loginBotLoading}
      </p>
    );
  if (bot.kind === "failed" || widgetFailed)
    return (
      <>
        <p className="login-error" role="alert">
          {bot.kind === "failed" ? t.loginBotFailed : t.loginWidgetFailed}
        </p>
        <button type="button" className="action" onClick={onRetry}>
          {t.retry}
        </button>
      </>
    );
  return <TelegramLoginWidget bot={bot.username} onLoadError={onWidgetError} />;
}

interface LoginProps {
  /** Идёт проверка: данные виджета у API или сохранённый токен */
  checking: boolean;
  error: SignInError | null;
}

export function Login({ checking, error }: LoginProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [attempt, setAttempt] = useState(0);
  // Кнопка «Повторить» исчезает вместе со старой попыткой — фокус на заголовок, а не в никуда
  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
    heading.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    document.title = `${t.login} · Bayramm`;
  }, []);

  // Отказ во входе — фокус на заголовок, чтобы диктор прочёл страницу с ошибкой заново
  useEffect(() => {
    if (error) heading.current?.focus({ preventScroll: true });
  }, [error]);

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
          {error && (
            <p className="login-error" role="alert">
              {t.errors[error]}
            </p>
          )}
          {checking ? (
            <p className="login-status" role="status">
              {t.loginChecking}
            </p>
          ) : (
            // Пока проверяем вход, имя бота не спрашиваем: вошедшему кнопка не нужна
            <SignInButton key={attempt} onRetry={retry} />
          )}
        </section>
      </main>
    </div>
  );
}
