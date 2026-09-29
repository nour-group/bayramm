import type { ClientConsentPurpose } from "@bayramm/shared/api";
import { LangSwitch } from "../components/LangSwitch";
import { Link } from "../components/Link";
import { Paragraphs, RichText } from "../components/RichText";
import { ErrorState, Loading } from "../components/States";
import { useLang, useServices } from "../context";
import { useAsync, useDocumentTitle } from "../hooks";
import { Icon } from "../icons";
import { hrefFor } from "../router";

const PURPOSE_TITLE = {
  client_service: "cp_client_service",
  request_transfer: "cp_request_transfer",
  bot_notifications: "cp_bot_notifications",
} as const satisfies Record<ClientConsentPurpose, string>;

/** Тексты согласий в действующей версии: те же, что клиент отмечает в форме заявки */
function Documents() {
  const { api } = useServices();
  const { t, lang } = useLang();
  const texts = useAsync(`consents:${lang}`, (signal) => api.consentTexts(lang, signal));

  if (texts.status === "loading") return <Loading />;
  if (texts.status === "error") return <ErrorState onRetry={texts.reload} />;
  if (texts.data.items.length === 0) return <p className="muted">{t.docsEmpty}</p>;

  return (
    <div className="docs">
      {texts.data.items.map((text) => (
        <details key={text.id} className="doc">
          <summary>
            <Icon name="lock" size={17} />
            <span>{t[PURPOSE_TITLE[text.purpose]]}</span>
            <span className="muted small">{t.consentVersion(text.version)}</span>
          </summary>
          <Paragraphs text={text.body} className="prose" />
        </details>
      ))}
    </div>
  );
}

export function Profile() {
  const { webApp } = useServices();
  const { t } = useLang();
  useDocumentTitle(t.navProfile);
  const user = webApp?.initDataUnsafe.user;
  const name = user ? [user.first_name, user.last_name].filter(Boolean).join(" ") : null;

  return (
    <div className="screen profile">
      <h1 className="screen-title" tabIndex={-1}>
        {t.navProfile}
      </h1>
      {name ? <p className="profile-name">{name}</p> : null}

      <section className="section" aria-labelledby="profile-lang">
        <h2 className="section-title" id="profile-lang">
          {t.language}
        </h2>
        <LangSwitch className="lang lang-wide" />
      </section>

      <Link className="row-link" href={hrefFor({ name: "requests" })}>
        <Icon name="notepad" size={20} />
        <span>
          <b>{t.mrTitle}</b>
          <span className="muted small">{t.mrSub}</span>
        </span>
        <Icon name="caret" size={14} />
      </Link>

      <section className="section" aria-labelledby="profile-docs">
        <h2 className="section-title" id="profile-docs">
          {t.meDocs}
        </h2>
        <Documents />
      </section>

      <section className="section" aria-labelledby="profile-about">
        <h2 className="section-title" id="profile-about">
          {t.meAbout}
        </h2>
        <h3 className="sub-title">{t.i_book_h}</h3>
        <RichText blocks={t.i_book_b} />
        <h3 className="sub-title">{t.i_city_h}</h3>
        <RichText blocks={t.i_city_b} />
        <RichText blocks={t.i_d3_b} />
      </section>
    </div>
  );
}
