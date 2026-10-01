/* Раздел «Аккаунт»: кто вошёл и в какой кабинет (площадка, код для менеджера, роль),
   язык кабинета, другие приложения того же аккаунта и выход.

   Ссылки на другие роли: вне Telegram — обычные ссылки (без сессии приложение само уйдёт в
   хаб входа и вернётся по ?signin=1, второй раз входить не нужно); внутри Telegram — через
   бота: приложение открывает основное Mini App (?startapp), панель — карточка ролей бота.
   Выход — только в браузере: в Telegram вход — сама кнопка бота. */

import { LANGS, type Lang } from "@bayramm/shared";
import type { Me } from "@bayramm/shared/api/me";
import type { VendorMe } from "@bayramm/shared/api/vendor";
import { RadioGroup } from "@bayramm/ui/react";
import type { MouseEvent } from "react";
import { SignOutButton } from "./Account";
import { accountMe } from "./api";
import { authMethods, botOf, SIGNIN_PARAM } from "./hub";
import { fill, LANG_NAMES } from "./i18n";
import { getWebApp, inTelegram } from "./telegram";
import { Heading, type ScreenProps } from "./ui";
import { useLoad } from "./useLoad";

interface Links {
  readonly me: Me;
  readonly web: string;
  readonly admin: string;
  readonly bot: string | null;
}

async function loadLinks(): Promise<Links> {
  const [me, methods] = await Promise.all([accountMe(), authMethods()]);
  if (methods === null) throw new Error("auth/methods");
  return {
    me,
    web: methods.apps.web,
    admin: `${methods.apps.admin}/?${SIGNIN_PARAM}=1`,
    bot: botOf(methods),
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

interface AccountPageProps extends ScreenProps {
  readonly me: VendorMe;
  readonly onLang: (lang: Lang) => void;
  /** Партнёр нескольких вендоров: выбрать другой кабинет */
  readonly onSwitch: () => void;
}

export function AccountPage({ t, lang, headingRef, me, onLang, onSwitch }: AccountPageProps) {
  const [links] = useLoad("links", loadLinks);
  const ready = links.state === "ready" ? links.data : null;
  const telegram = inTelegram();
  const langOptions = LANGS.map((code) => ({ value: code, label: LANG_NAMES[code] }));

  return (
    <section className="page page-narrow" aria-labelledby="page-title">
      <Heading headingRef={headingRef}>{t.account}</Heading>

      <section className="panel" aria-labelledby="cabinet-title">
        <p className="field-label">{t.cabinetLabel}</p>
        <h2 className="section-title" id="cabinet-title">
          {me.vendor.name || me.vendor.code}
        </h2>
        <p className="note">{fill(t.vendorCode, { code: me.vendor.code })}</p>
        {me.user.fullName ? <p className="account-person">{me.user.fullName}</p> : null}
        <p className="account-role">{me.user.role === "owner" ? t.roleOwner : t.roleMember}</p>
        {ready && ready.me.roles.vendors.length > 1 ? (
          <button type="button" className="btn btn-ghost account-switch" onClick={onSwitch}>
            {t.switchVendor}
          </button>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="lang-title">
        <h2 className="section-title" id="lang-title">
          {t.language}
        </h2>
        <RadioGroup
          variant="segmented"
          aria-labelledby="lang-title"
          name="cabinet-lang"
          value={lang}
          options={langOptions}
          onChange={onLang}
        />
        <p className="note">{t.languageNote}</p>
      </section>

      {ready ? (
        <section className="panel" aria-labelledby="apps-title">
          <h2 className="section-title" id="apps-title">
            {t.otherApps}
          </h2>
          <div className="account-actions">
            <a
              className="btn btn-ghost"
              href={ready.web}
              onClick={viaBot(ready.bot ? `https://t.me/${ready.bot}?startapp` : null)}
            >
              {t.toClientApp}
            </a>
            {ready.me.roles.staff ? (
              <a
                className="btn btn-ghost"
                href={ready.admin}
                onClick={viaBot(ready.bot ? `https://t.me/${ready.bot}?start=admin` : null)}
              >
                {t.toAdmin}
              </a>
            ) : null}
          </div>
        </section>
      ) : null}

      {telegram ? null : <SignOutButton label={t.signOut} />}
    </section>
  );
}
