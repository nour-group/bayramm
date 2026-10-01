import { useLang, useServices } from "../context";
import { tashkentToday } from "../format";
import { useAsync } from "../hooks";
import { Icon } from "../icons";
import { hrefFor } from "../router";
import { LangSwitch } from "./LangSwitch";
import { Link } from "./Link";
import { telegramLink } from "./TelegramCta";

/** Подвал сайта (в Mini App его нет): каталог, документы, бот в Telegram, язык */
export function SiteFooter() {
  const { api, now } = useServices();
  const { t } = useLang();
  const bot = useAsync("bot", (signal) => api.bot(signal));
  const botHref = bot.status === "ready" ? telegramLink(bot.data.username) : null;
  const year = tashkentToday(now()).slice(0, 4);

  return (
    <footer className="site-footer">
      <div className="footer-in">
        <div className="footer-brand">
          <Link className="brand" href={hrefFor({ name: "home" })}>
            Bayramm
          </Link>
          <p className="muted small">{t.ftAbout}</p>
        </div>
        <nav className="footer-nav" aria-label={t.ftNav}>
          <Link href={hrefFor({ name: "catalog" })}>{t.navCatalog}</Link>
          <Link href={hrefFor({ name: "docs" })}>{t.meDocs}</Link>
          {botHref ? (
            <a href={botHref} target="_blank" rel="noopener noreferrer">
              <Icon name="tg" size={17} className="footer-ico" />
              {t.ftTelegram}
            </a>
          ) : null}
        </nav>
        <LangSwitch />
      </div>
      <p className="footer-copy muted small">© {year} Bayramm</p>
    </footer>
  );
}
