import { Dialog } from "@bayramm/ui/react";
import { useRef, useState } from "react";
import { useLang, useServices } from "../context";
import { useAsync } from "../hooks";
import { Icon, type IconName } from "../icons";
import { GUEST_SECTIONS } from "../nav";
import { hrefFor, type Tab } from "../router";
import { LangSwitch } from "./LangSwitch";
import { Link } from "./Link";
import { telegramLink } from "./TelegramCta";

/** Разделы гостя в меню: подпись и иконка — как у вкладок сайта (App.tsx, TAB_VIEW) */
const SECTION_VIEW = {
  catalog: { label: "navCatalog", icon: "home" },
  favorites: { label: "svTitle", icon: "heart" },
} as const satisfies Record<(typeof GUEST_SECTIONS)[number], { label: string; icon: IconName }>;

/** Содержимое шторки: грузится, только когда её открыли (бот и способы входа — из API) */
function MenuBody({
  current,
  signInHref,
  onPick,
}: {
  current: Tab | null;
  signInHref: string;
  onPick: () => void;
}) {
  const { api } = useServices();
  const { t, lang } = useLang();
  const bot = useAsync("bot", (signal) => api.bot(signal));
  const methods = useAsync("auth-methods", (signal) => api.authMethods(signal));
  const botHref = bot.status === "ready" ? telegramLink(bot.data.username) : null;
  // Телефон — только если вход по нему здесь включён (пока не ответили — не обещаем)
  const phone = methods.status === "ready" && methods.data.phone;

  return (
    // Язык шторки — текущий: слой диалога запомнил язык страницы на момент открытия
    <div className="site-menu" lang={lang}>
      <nav aria-label={t.sections}>
        <ul className="menu-links">
          {GUEST_SECTIONS.map((tab) => (
            <li key={tab}>
              <Link
                href={hrefFor({ name: tab })}
                aria-current={tab === current ? "page" : undefined}
                onClick={onPick}
              >
                <Icon name={SECTION_VIEW[tab].icon} size={20} className="menu-ico" />
                {t[SECTION_VIEW[tab].label]}
              </Link>
            </li>
          ))}
          <li>
            <Link href={hrefFor({ name: "docs" })} onClick={onPick}>
              <Icon name="shieldD" size={20} className="menu-ico" />
              {t.meDocs}
            </Link>
          </li>
          {botHref ? (
            <li>
              <a href={botHref} target="_blank" rel="noopener noreferrer">
                <Icon name="tg" size={20} className="menu-ico" />
                {t.ftTelegram}
              </a>
            </li>
          ) : null}
        </ul>
      </nav>
      <div className="menu-lang">
        <span>{t.language}</span>
        <LangSwitch className="lang lang-wide" />
      </div>
      <div className="menu-signin">
        <p className="muted small">{phone ? t.accSignInLead : t.accSignInLeadTelegram}</p>
        {/* Хаб входа — полной загрузкой: у /auth свой CSP */}
        <a className="btn btn-primary wide" href={signInHref}>
          {t.accSignIn}
        </a>
      </div>
    </div>
  );
}

/**
 * Меню сайта для гостя — кнопка в шапке и шторка (на телефоне снизу, шире — карточкой):
 * каталог, сохранённое, документы, бот в Telegram, язык и вход. На компьютере кнопки нет:
 * разделы — в шапке
 */
export function SiteMenu({ current, signInHref }: { current: Tab | null; signInHref: string }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-btn top-menu"
        aria-label={t.menu}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Icon name="list" size={20} />
      </button>
      <Dialog
        open={open}
        onClose={close}
        title={t.menu}
        className="site-menu-dialog"
        returnFocus={button}
        actions={
          <button type="button" className="ui-btn ui-btn-secondary" onClick={close}>
            {t.infoClose}
          </button>
        }
      >
        <MenuBody current={current} signInHref={signInHref} onPick={close} />
      </Dialog>
    </>
  );
}
