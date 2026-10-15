import { buildStartParam } from "@bayramm/tg";
import { useLang, useServices } from "../context";
import { useAsync } from "../hooks";
import { Icon } from "../icons";

// Имя бота по правилам @BotFather: латиница, цифры, _, в конце bot
const BOT_USERNAME_RE = /^[A-Za-z0-9_]{2,29}bot$/i;

/**
 * Ссылка, открывающая Mini App в Telegram: t.me/<бот>?startapp=vendor_<slug> ведёт сразу
 * к площадке. Имени бота в сборке нет — у каждого окружения свой (GET /api/auth/methods)
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

/**
 * Гостю сайта в форме заявки: та же витрина в Telegram — вход там без пароля. Имя бота не
 * пришло — ссылки нет (форма и вход на сайте остаются)
 */
export function BotLink({ slug }: { slug: string }) {
  const { api } = useServices();
  const { t } = useLang();
  const bot = useAsync("bot", (signal) => api.bot(signal));
  const href = bot.status === "ready" ? telegramLink(bot.data.username, slug) : null;
  if (!href) return null;
  return (
    <a className="link-btn bot-link" href={href} target="_blank" rel="noopener noreferrer">
      <Icon name="tg" size={17} />
      {t.openInTg}
    </a>
  );
}
