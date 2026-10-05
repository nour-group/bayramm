import { LANGS } from "@bayramm/shared";
import { useLang, useServices } from "../context";
import { tashkentToday } from "../format";
import { useAsync } from "../hooks";
import { prefetchDictionary } from "../i18n";
import { Icon } from "../icons";
import { hrefFor } from "../router";
import { LANG_NAMES } from "./LangSwitch";
import { Link } from "./Link";
import { telegramLink } from "./TelegramCta";

/**
 * Язык в подвале — строкой, а не вторым переключателем (он уже в шапке и в меню): «Язык: Русский ·
 * Oʻzbekcha», где другой язык — ссылка-кнопка на нём самом
 */
function FooterLang() {
  const { lang, setLang, t, pendingLang } = useLang();
  return (
    // biome-ignore lint/a11y/useSemanticElements: группа «язык» с подписью, fieldset здесь не форма
    <div className="footer-lang" role="group" aria-label={t.language}>
      <span className="muted" aria-hidden="true">
        {t.language}:
      </span>
      {LANGS.map((code) =>
        code === lang ? (
          <span key={code} lang={code} aria-current="true">
            {LANG_NAMES[code]}
          </span>
        ) : (
          <button
            key={code}
            type="button"
            className="link-btn"
            lang={code}
            aria-busy={code === pendingLang || undefined}
            onPointerEnter={() => prefetchDictionary(code)}
            onFocus={() => prefetchDictionary(code)}
            onClick={() => setLang(code)}
          >
            {LANG_NAMES[code]}
          </button>
        ),
      )}
    </div>
  );
}

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
        <FooterLang />
      </div>
      <p className="footer-copy muted small">© {year} Bayramm</p>
    </footer>
  );
}
