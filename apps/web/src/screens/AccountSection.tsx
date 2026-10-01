import type { AuthMethods } from "@bayramm/shared/api/account";
import type { Me } from "@bayramm/shared/api/me";
import { type MouseEvent, useState } from "react";
import { type HumanProof, humanProofFor, PhoneCode } from "../components/PhoneCode";
import { canSignIn, useAccount, useLang, useServices } from "../context";
import { useAsync } from "../hooks";
import { authHref, browser } from "../hub";
import { Icon } from "../icons";
import { hrefFor } from "../router";
import { haptic } from "../telegram";

/* Профиль → «Аккаунт»: один аккаунт на все роли.
     · кнопки «Кабинет партнёра» и «Панель оператора» — только если роль есть. Это обычные
       ссылки на приложения: без сессии они сами идут в хаб входа и возвращаются с кодом —
       второй раз входить не нужно (в Telegram — то же, в том же окне);
     · способы входа: Telegram и телефон — подключены или «добавить». Способ другого
       аккаунта не добавить (409), слияния нет. Телефон с проверкой «не робот» на сайте
       добавляется в хабе (/auth?link=phone: виджет Turnstile разрешён только там), в
       Telegram — здесь же, запрос кода подписан initData;
     · на сайте — «Выйти» (и на главную). Гость сюда не попадает: профиль только после входа
       (nav.ts), «Войти» — в шапке и меню сайта. Ссылки в хаб — полной загрузкой: у /auth свой CSP */

// Имя бота по правилам @BotFather: латиница, цифры, _, в конце bot
const BOT_USERNAME_RE = /^[A-Za-z0-9_]{2,29}bot$/i;

/**
 * Ссылка на другое приложение того же аккаунта. Вне Telegram — адрес с ?signin=1: без
 * сессии приложение сразу уйдёт в хаб и вернётся со входом. В Telegram — через бота:
 * карточка ролей с кнопками Mini App, где вход — по initData
 */
function useAppLink(bot: string | null) {
  const { webApp } = useServices();
  return (start: "cabinet" | "admin") => (event: MouseEvent<HTMLAnchorElement>) => {
    if (bot && BOT_USERNAME_RE.test(bot) && webApp?.openTelegramLink) {
      event.preventDefault();
      webApp.openTelegramLink(`https://t.me/${bot}?start=${start}`);
    }
  };
}

function Roles({ me, methods }: { me: Me; methods: AuthMethods | null }) {
  const { t } = useLang();
  const via = useAppLink(methods?.telegram.bot ?? null);
  const vendors = me.roles.vendors;
  if (methods === null || (vendors.length === 0 && me.roles.staff === null)) return null;
  const { apps } = methods;
  return (
    <div className="roles">
      <h3 className="sub-title">{t.accRoles}</h3>
      {vendors.length > 0 ? (
        <a className="row-link" href={`${apps.vendor}/?signin=1`} onClick={via("cabinet")}>
          <Icon name="hall" size={20} />
          <span>
            <b>{t.accVendor}</b>
            <span className="muted small">{vendors.map((v) => v.name ?? v.code).join(" · ")}</span>
          </span>
          <Icon name="caret" size={14} />
        </a>
      ) : null}
      {me.roles.staff ? (
        <a className="row-link" href={`${apps.admin}/?signin=1`} onClick={via("admin")}>
          <Icon name="sliders" size={20} />
          <span>
            <b>{t.accAdmin}</b>
          </span>
          <Icon name="caret" size={14} />
        </a>
      ) : null}
    </div>
  );
}

function Methods({
  me,
  phoneOn,
  widgetOn,
  human,
}: {
  me: Me;
  phoneOn: boolean;
  widgetOn: boolean;
  human: HumanProof | null;
}) {
  const { api, identity, webApp } = useServices();
  const { t } = useLang();
  const { me: meState } = useAccount();
  const [adding, setAdding] = useState(false);
  const [linked, setLinked] = useState(false);
  const has = (kind: "telegram" | "phone") => me.identities.some((i) => i.kind === kind);

  const onCode = async (phone: string, code: string) => {
    const next = await api.linkPhone(phone, code);
    meState.replace(next);
    setAdding(false);
    setLinked(true);
    haptic(webApp, "success");
  };

  return (
    <div className="methods">
      <h3 className="sub-title">{t.accMethods}</h3>
      <ul className="method-list">
        <li className="method">
          <Icon name="tg" size={17} className="method-ico" />
          <span className="method-name">{t.accTelegram}</span>
          {has("telegram") ? (
            <span className="muted small">{t.accMethodOn}</span>
          ) : widgetOn && identity === "site" ? (
            <a
              className="link-btn"
              href={authHref({ link: "telegram", return: hrefFor({ name: "profile" }) })}
            >
              {t.accAddTelegram}
            </a>
          ) : null}
        </li>
        <li className="method">
          <Icon name="phone" size={17} className="method-ico" />
          <span className="method-name">{t.accPhone}</span>
          {has("phone") ? (
            <span className="muted small">{t.accMethodOn}</span>
          ) : phoneOn && human?.kind === "turnstile" ? (
            <a className="link-btn" href={authHref({ link: "phone", return: hrefFor({ name: "profile" }) })}>
              {t.accAddPhone}
            </a>
          ) : phoneOn && !adding ? (
            <button type="button" className="link-btn" onClick={() => setAdding(true)}>
              {t.accAddPhone}
            </button>
          ) : null}
        </li>
      </ul>
      {adding ? <PhoneCode onCode={onCode} submitLabel={t.accAddPhone} human={human} /> : null}
      {linked ? (
        <p className="small" role="status">
          {t.accLinked}
        </p>
      ) : null}
    </div>
  );
}

export function AccountSection() {
  const { api, identity, webApp } = useServices();
  const { t } = useLang();
  const { me, deleted } = useAccount();
  const methods = useAsync("auth-methods", (signal) => api.authMethods(signal));
  const [leaving, setLeaving] = useState(false);
  const profile = me.status === "ready" ? me.data : null;
  const ready = methods.status === "ready" ? methods.data : null;

  if (deleted || !canSignIn(identity) || profile === null) return null;

  const signOut = async () => {
    setLeaving(true);
    try {
      await api.signOut();
    } finally {
      // Токен вкладки забыт в любом случае; страница — заново, уже гостем: на главную
      // (профиль гостю не показывается — он увёл бы прямо во вход)
      browser.replace(hrefFor({ name: "home" }));
    }
  };

  const widgetOn =
    ready !== null &&
    ready.telegram.loginDomain !== null &&
    ready.telegram.loginDomain === window.location.hostname;

  return (
    <section className="section" aria-labelledby="profile-account">
      <h2 className="section-title" id="profile-account">
        {t.accTitle}
      </h2>
      <Roles me={profile} methods={ready} />
      <Methods
        me={profile}
        phoneOn={ready?.phone === true}
        widgetOn={widgetOn}
        human={ready ? humanProofFor(ready, webApp?.initData) : null}
      />
      {identity === "site" ? (
        <button type="button" className="btn btn-secondary wide" disabled={leaving} onClick={signOut}>
          {t.accSignOut}
        </button>
      ) : null}
    </section>
  );
}
