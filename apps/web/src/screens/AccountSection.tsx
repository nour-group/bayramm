import type { Me } from "@bayramm/shared/api/me";
import { useState } from "react";
import { PhoneCode } from "../components/PhoneCode";
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
       аккаунта не добавить (409), слияния нет;
     · на сайте — «Войти» (хаб) и «Выйти». Ссылки в хаб — полной загрузкой: у /auth свой CSP */

function Roles({ me, apps }: { me: Me; apps: Readonly<Record<string, string>> | null }) {
  const { t } = useLang();
  const vendors = me.roles.vendors;
  if (apps === null || (vendors.length === 0 && me.roles.staff === null)) return null;
  return (
    <div className="roles">
      <h3 className="sub-title">{t.accRoles}</h3>
      {vendors.length > 0 ? (
        <a className="row-link" href={apps.vendor}>
          <Icon name="hall" size={20} />
          <span>
            <b>{t.accVendor}</b>
            <span className="muted small">{vendors.map((v) => v.name ?? v.code).join(" · ")}</span>
          </span>
          <Icon name="caret" size={14} />
        </a>
      ) : null}
      {me.roles.staff ? (
        <a className="row-link" href={apps.admin}>
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

function Methods({ me, phoneOn, widgetOn }: { me: Me; phoneOn: boolean; widgetOn: boolean }) {
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
          ) : phoneOn && !adding ? (
            <button type="button" className="link-btn" onClick={() => setAdding(true)}>
              {t.accAddPhone}
            </button>
          ) : null}
        </li>
      </ul>
      {adding ? <PhoneCode onCode={onCode} submitLabel={t.accAddPhone} /> : null}
      {linked ? (
        <p className="small" role="status">
          {t.accLinked}
        </p>
      ) : null}
    </div>
  );
}

export function AccountSection() {
  const { api, identity } = useServices();
  const { t } = useLang();
  const { me, deleted } = useAccount();
  const methods = useAsync("auth-methods", (signal) => api.authMethods(signal));
  const [leaving, setLeaving] = useState(false);
  const profile = me.status === "ready" ? me.data : null;
  const ready = methods.status === "ready" ? methods.data : null;

  if (deleted) return null;

  if (!canSignIn(identity)) {
    return (
      <section className="section" aria-labelledby="profile-account">
        <h2 className="section-title" id="profile-account">
          {t.accTitle}
        </h2>
        <p className="muted small">{t.accSignInLead}</p>
        <a className="btn btn-primary wide" href={authHref({ return: hrefFor({ name: "profile" }) })}>
          {t.accSignIn}
        </a>
      </section>
    );
  }

  if (profile === null) return null;

  const signOut = async () => {
    setLeaving(true);
    try {
      await api.signOut();
    } finally {
      // Токен вкладки забыт в любом случае; страница — заново, уже гостем
      browser.replace(hrefFor({ name: "profile" }));
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
      <Roles me={profile} apps={ready?.apps ?? null} />
      <Methods me={profile} phoneOn={ready?.phone === true} widgetOn={widgetOn} />
      {identity === "site" ? (
        <button type="button" className="btn btn-secondary wide" disabled={leaving} onClick={signOut}>
          {t.accSignOut}
        </button>
      ) : null}
    </section>
  );
}
