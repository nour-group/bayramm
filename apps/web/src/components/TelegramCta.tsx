import { buildStartParam } from "@bayramm/tg";
import { useLang, useServices } from "../context";
import { useAsync } from "../hooks";
import { authHref } from "../hub";
import { Icon } from "../icons";
import { ErrorState } from "./States";

// Имя бота по правилам @BotFather: латиница, цифры, _, в конце bot
const BOT_USERNAME_RE = /^[A-Za-z0-9_]{2,29}bot$/i;

/**
 * Ссылка, открывающая Mini App в Telegram: t.me/<бот>?startapp=vendor_<slug> ведёт сразу
 * к площадке. Имени бота в сборке нет — у каждого окружения свой (GET /api/telegram/bot)
 */
export function telegramLink(username: string, slug?: string): string | null {
  if (!BOT_USERNAME_RE.test(username)) return null;
  if (!slug) return `https://t.me/${username}?startapp`;
  try {
    return `https://t.me/${username}?startapp=${buildStartParam({ kind: "vendor", id: slug })}`;
  } catch {
    return `https://t.me/${username}?startapp`;
  }
}

/** Вне Telegram без входа: заявки и «Мои заявки» — после входа: в Telegram или на сайте (хаб) */
export function TelegramCta({ slug, headingLevel = 2 }: { slug?: string; headingLevel?: 1 | 2 }) {
  const { api } = useServices();
  const { t } = useLang();
  const bot = useAsync("bot", (signal) => api.bot(signal));
  const href = bot.status === "ready" ? telegramLink(bot.data.username, slug) : null;
  const Heading = headingLevel === 1 ? "h1" : "h2";

  return (
    <section className="tg-cta" aria-labelledby="tg-cta-title">
      <span className="tg-cta-icon" aria-hidden="true">
        <Icon name="tg" size={26} />
      </span>
      <Heading id="tg-cta-title" className="section-title" tabIndex={headingLevel === 1 ? -1 : undefined}>
        {t.tgOnlyH}
      </Heading>
      <p>{t.tgOnlyP}</p>
      {href ? (
        <a className="btn btn-primary" href={href} target="_blank" rel="noopener noreferrer">
          <Icon name="tg" size={20} />
          {t.openInTg}
        </a>
      ) : bot.status === "loading" ? (
        <p className="muted" role="status">
          {t.loading}
        </p>
      ) : (
        <ErrorState message={t.tgUnavailable} onRetry={bot.reload} />
      )}
      {/* Или на сайте: хаб входа — Telegram или код из сообщения; после входа — сюда же */}
      <a
        className="btn btn-secondary"
        href={authHref({ return: window.location.pathname + window.location.search })}
      >
        {t.ctaSignIn}
      </a>
    </section>
  );
}
