/* Экран до кабинета: вход идёт, нужно войти (вне Telegram), номер не привязан, доступ
   отключён, сессия кончилась, вход через хаб не завершился или API не ответило.
   «Войти» ведёт в хаб входа на сайте Bayramm (hub.ts). Ссылка на бота — с именем бота
   окружения из API (в сборке его нет) и стартом партнёра. */

import { type MouseEvent, useEffect, useState } from "react";
import { fetchBotLink } from "./api";
import type { TextKey, VendorDict } from "./i18n";
import { Icon } from "./icons";
import { inTelegram, openBotLink } from "./telegram";
import type { ScreenProps } from "./ui";
import { Heading } from "./ui";

export type GateKind = "loading" | "outside" | "not_linked" | "disabled" | "expired" | "hub_failed" | "error";

const TEXTS: Readonly<Record<Exclude<GateKind, "loading">, [TextKey, TextKey]>> = {
  outside: ["gateOutsideTitle", "gateOutsideText"],
  not_linked: ["gateNotLinkedTitle", "gateNotLinkedText"],
  disabled: ["gateDisabledTitle", "gateDisabledText"],
  expired: ["gateExpiredTitle", "gateExpiredText"],
  hub_failed: ["gateHubTitle", "gateHubText"],
  error: ["gateErrorTitle", "gateErrorText"],
};

// Куда вести: без входа и без привязки — в бота; ошибка сети — повторить
const WANTS_BOT: readonly GateKind[] = ["outside", "not_linked", "expired"];
// Вне Telegram — войти через хаб (или другим аккаунтом, если этот не партнёр)
const WANTS_SIGN_IN: readonly GateKind[] = ["outside", "expired", "hub_failed", "not_linked"];

function BotLink({ t, primary }: { t: VendorDict; primary: boolean }) {
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchBotLink().then((url) => {
      if (active) setLink(url);
    });
    return () => {
      active = false;
    };
  }, []);

  if (link === null) return null;
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => openBotLink(link, event);
  return (
    <a
      className={primary ? "btn btn-primary" : "btn btn-ghost"}
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
    >
      {t.openBot}
    </a>
  );
}

interface GateProps extends Pick<ScreenProps, "t" | "headingRef"> {
  readonly kind: GateKind;
  readonly onRetry: () => void;
  /** Войти через хаб входа на сайте */
  readonly onSignIn: () => void;
}

export function Gate({ kind, t, headingRef, onRetry, onSignIn }: GateProps) {
  if (kind === "loading") {
    return (
      <section className="gate" aria-busy="true">
        <p className="status-line" role="status">
          {t.gateLoading}
        </p>
      </section>
    );
  }
  const [title, text] = TEXTS[kind];
  // Внутри Telegram вход — по кнопке бота; хаб — для браузера
  const signIn = WANTS_SIGN_IN.includes(kind) && !inTelegram();
  return (
    <section className="gate" aria-labelledby="page-title">
      <span className="empty-art">
        <Icon name={kind === "error" ? "warning" : kind === "disabled" ? "lock" : "info"} size={26} />
      </span>
      <Heading headingRef={headingRef}>{t[title]}</Heading>
      <p className="lead">{t[text]}</p>
      <div className="gate-actions">
        {signIn ? (
          <button type="button" className="btn btn-primary" onClick={onSignIn}>
            {kind === "not_linked" ? t.signInOther : t.signIn}
          </button>
        ) : null}
        {WANTS_BOT.includes(kind) ? <BotLink t={t} primary={!signIn} /> : null}
        {kind === "error" ? (
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            {t.retry}
          </button>
        ) : null}
      </div>
    </section>
  );
}
