import type { Lang } from "@bayramm/shared";
import { TURNSTILE_ACTION_PHONE } from "@bayramm/shared/api/account";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useLang } from "../context";

/* Проверка «не робот» (Cloudflare Turnstile) перед кодом на телефон — только в хабе входа
   (/auth): CSP сайта пускает скрипт и фрейм challenges.cloudflare.com только там
   (turnstilePaths в воркере web). Скрипт грузится кодом и только когда проверка нужна
   (как виджет Telegram), виджет рисуется явно (render=explicit): встроенного скрипта и
   колбэка по имени нет. Сам виджет — фрейм Cloudflare; вокруг — рамка поля набора: подпись,
   пояснение, ошибки нашими словами.

   Токен одноразовый и живёт 5 минут: после каждой попытки отправки его сбрасывают
   (reset), виджет выдаёт новый. Истёк — виджет обновляется сам (refresh-expired). */

export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileOptions {
  readonly sitekey: string;
  readonly action: string;
  readonly theme: "light";
  readonly size: "flexible";
  readonly language: string;
  readonly "refresh-expired": "auto";
  readonly callback: (token: string) => void;
  readonly "expired-callback": () => void;
  readonly "error-callback": () => boolean;
}

/** Часть API Turnstile, которой мы пользуемся */
export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileOptions): string | null | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** api.js один раз на страницу; не загрузился — следующая попытка загрузит заново */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.addEventListener("load", () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("turnstile: api.js без window.turnstile"));
    });
    script.addEventListener("error", () => {
      loading = null;
      script.remove();
      reject(new Error("turnstile: api.js не загрузился"));
    });
    document.head.append(script);
  });
  return loading;
}

// Узбекского в Turnstile нет — тогда язык браузера
const widgetLanguage = (lang: Lang) => (lang === "ru" ? "ru" : "auto");

export interface HumanCheckHandle {
  /** Токен потрачен (запрос ушёл): взять новый */
  reset(): void;
}

interface HumanCheckProps {
  readonly siteKey: string;
  /** Токен готов (строка) или сгорел, истёк, проверка не прошла (null) */
  readonly onToken: (token: string | null) => void;
  /** reset() — после попытки отправки */
  readonly ref?: Ref<HumanCheckHandle>;
}

type Status = "loading" | "ready" | "failed" | "unavailable";

export function HumanCheck({ siteKey, onToken, ref }: HumanCheckProps) {
  const { t, lang } = useLang();
  const slot = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const report = useRef(onToken);
  report.current = onToken;

  useImperativeHandle(
    ref,
    () => ({
      reset() {
        report.current(null);
        if (widget.current) widget.current.api.reset(widget.current.id);
      },
    }),
    [],
  );

  // Язык — при первом показе: смена языка страницы виджет не пересоздаёт (токен не сгорит)
  const language = useRef(widgetLanguage(lang));

  useEffect(() => {
    let alive = true;
    loadTurnstile().then(
      (api) => {
        const host = slot.current;
        if (!alive || !host) return;
        const widgetId = api.render(host, {
          sitekey: siteKey,
          action: TURNSTILE_ACTION_PHONE,
          theme: "light",
          size: "flexible",
          language: language.current,
          "refresh-expired": "auto",
          callback: (token) => {
            setStatus("ready");
            report.current(token);
          },
          "expired-callback": () => report.current(null),
          "error-callback": () => {
            setStatus("failed");
            report.current(null);
            // Ошибку показываем своими словами; виджет сам попробует ещё раз
            return true;
          },
        });
        if (typeof widgetId === "string") widget.current = { api, id: widgetId };
        else setStatus("unavailable");
      },
      () => {
        if (alive) setStatus("unavailable");
      },
    );
    return () => {
      alive = false;
      const current = widget.current;
      widget.current = null;
      if (current) current.api.remove(current.id);
    };
  }, [siteKey]);

  const message =
    status === "failed" ? t.humanCheckFailed : status === "unavailable" ? t.humanCheckOff : null;
  return (
    <fieldset className="human-check">
      <legend className="fld-label">{t.humanCheck}</legend>
      <div className="human-check-slot" ref={slot} />
      {message ? (
        <p className="fld-error" role="alert">
          {message}
        </p>
      ) : (
        <p className="muted small">{t.humanCheckNote}</p>
      )}
    </fieldset>
  );
}
