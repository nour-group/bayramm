/* Аккаунт партнёра в кабинете: выбор вендора (человек — партнёр нескольких площадок) и
   ссылки на другие роли того же аккаунта — клиентское приложение и панель оператора.
   Вне Telegram — обычные ссылки: без сессии приложение само уйдёт в хаб входа и
   вернётся (?signin=1), второй раз входить не нужно. Внутри Telegram — через бота:
   приложение открывает основное Mini App (?startapp), панель — карточка ролей бота. */

import type { VendorMembership } from "@bayramm/shared/api/account";
import type { Me } from "@bayramm/shared/api/me";
import type { MouseEvent } from "react";
import { accountMe, signOut } from "./api";
import { authMethods, chooseVendor, SIGNIN_PARAM } from "./hub";
import type { VendorDict } from "./i18n";
import { getWebApp, inTelegram } from "./telegram";
import { Heading, type ScreenProps } from "./ui";
import { useLoad } from "./useLoad";

interface ChooserProps extends Pick<ScreenProps, "t" | "headingRef"> {
  readonly vendors: readonly VendorMembership[];
  readonly onChosen: () => void;
}

export function VendorChooser({ vendors, t, headingRef, onChosen }: ChooserProps) {
  return (
    <section className="gate" aria-labelledby="page-title">
      <Heading headingRef={headingRef}>{t.chooseTitle}</Heading>
      <p className="lead">{t.chooseText}</p>
      <div className="gate-actions vendor-choice">
        {vendors.map((v) => (
          <button
            key={v.vendorId}
            type="button"
            className="btn btn-ghost btn-wide"
            onClick={() => {
              chooseVendor(v.vendorId);
              onChosen();
            }}
          >
            {v.name ?? v.code} · {v.code}
          </button>
        ))}
      </div>
    </section>
  );
}

// Имя бота: 5–32 символа латиницы, цифр и _, в конце — bot (правила @BotFather)
const BOT_USERNAME_RE = /^[A-Za-z0-9_]{2,29}bot$/i;

interface Links {
  readonly me: Me;
  readonly web: string;
  readonly admin: string;
  readonly bot: string | null;
}

async function loadLinks(): Promise<Links> {
  const [me, methods] = await Promise.all([accountMe(), authMethods()]);
  if (methods === null) throw new Error("auth/methods");
  const bot = methods.telegram.bot;
  return {
    me,
    web: methods.apps.web,
    admin: `${methods.apps.admin}/?${SIGNIN_PARAM}=1`,
    bot: bot && BOT_USERNAME_RE.test(bot) ? bot : null,
  };
}

/** Внутри Telegram — ссылка через бота (Mini App с initData); вне — обычный переход */
function viaBot(url: string | null) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    const webApp = getWebApp();
    if (url && inTelegram() && webApp?.openTelegramLink) {
      event.preventDefault();
      webApp.openTelegramLink(url);
    }
  };
}

export function AccountLinks({ t, onSwitch }: { t: VendorDict; onSwitch: () => void }) {
  const [links] = useLoad("links", loadLinks);
  if (links.state !== "ready") return null;
  const { me, web, admin, bot } = links.data;
  const telegram = inTelegram();
  return (
    <section className="account-links" aria-labelledby="account-title">
      <h2 className="panel-title" id="account-title">
        {t.account}
      </h2>
      <div className="account-actions">
        {me.roles.vendors.length > 1 ? (
          <button type="button" className="btn btn-ghost" onClick={onSwitch}>
            {t.switchVendor}
          </button>
        ) : null}
        <a className="btn btn-ghost" href={web} onClick={viaBot(bot ? `https://t.me/${bot}?startapp` : null)}>
          {t.toClientApp}
        </a>
        {me.roles.staff ? (
          <a
            className="btn btn-ghost"
            href={admin}
            onClick={viaBot(bot ? `https://t.me/${bot}?start=admin` : null)}
          >
            {t.toAdmin}
          </a>
        ) : null}
        {telegram ? null : (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              chooseVendor(null);
              void signOut().finally(() => window.location.replace("/"));
            }}
          >
            {t.signOut}
          </button>
        )}
      </div>
    </section>
  );
}
