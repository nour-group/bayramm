/* Экран до кабинета: вход идёт, кабинет открыт не из бота, Telegram не привязан,
   доступ отключён, сессия кончилась или API не ответило. Ссылка на бота — с именем
   бота окружения из API (в сборке его нет) и стартом партнёра. */

import { type MouseEvent, useEffect, useState } from "react";
import { fetchBotLink } from "./api";
import type { TextKey, VendorDict } from "./i18n";
import { Icon } from "./icons";
import { openBotLink } from "./telegram";
import type { ScreenProps } from "./ui";
import { Heading } from "./ui";

export type GateKind = "loading" | "outside" | "not_linked" | "disabled" | "expired" | "error";

const TEXTS: Readonly<Record<Exclude<GateKind, "loading">, [TextKey, TextKey]>> = {
  outside: ["gateOutsideTitle", "gateOutsideText"],
  not_linked: ["gateNotLinkedTitle", "gateNotLinkedText"],
  disabled: ["gateDisabledTitle", "gateDisabledText"],
  expired: ["gateExpiredTitle", "gateExpiredText"],
  error: ["gateErrorTitle", "gateErrorText"],
};

// Куда вести: не из бота и без привязки — в бота; ошибка сети — повторить
const WANTS_BOT: readonly GateKind[] = ["outside", "not_linked", "expired"];

function BotLink({ t }: { t: VendorDict }) {
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
    <a className="btn btn-primary" href={link} target="_blank" rel="noopener noreferrer" onClick={onClick}>
      {t.openBot}
    </a>
  );
}

interface GateProps extends Pick<ScreenProps, "t" | "headingRef"> {
  readonly kind: GateKind;
  readonly onRetry: () => void;
}

export function Gate({ kind, t, headingRef, onRetry }: GateProps) {
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
  return (
    <section className="gate" aria-labelledby="page-title">
      <span className="empty-art">
        <Icon name={kind === "error" ? "warning" : kind === "disabled" ? "lock" : "info"} size={26} />
      </span>
      <Heading headingRef={headingRef}>{t[title]}</Heading>
      <p className="lead">{t[text]}</p>
      <div className="gate-actions">
        {WANTS_BOT.includes(kind) ? <BotLink t={t} /> : null}
        {kind === "error" ? (
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            {t.retry}
          </button>
        ) : null}
      </div>
    </section>
  );
}
