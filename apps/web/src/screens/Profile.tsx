import type { ClientConsentPurpose } from "@bayramm/shared/api";
import { useState } from "react";
import { LangSwitch } from "../components/LangSwitch";
import { Link } from "../components/Link";
import { Paragraphs, RichText } from "../components/RichText";
import { ErrorState, Loading } from "../components/States";
import { canSignIn, useAccount, useLang, useServices } from "../context";
import { tashkentToday } from "../format";
import { useAsync, useDocumentTitle } from "../hooks";
import { Icon } from "../icons";
import { hrefFor } from "../router";
import { haptic } from "../telegram";
import { AccountSection } from "./AccountSection";
import { clearDrafts } from "./request-draft";

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

/**
 * Файл из памяти: blob-ссылка и <a download>. Во вебвью Telegram скачивание может не
 * начаться — поэтому выгрузка ещё и показывается на экране. Нет Blob или createObjectURL
 * (старый вебвью) — только на экране
 */
function saveFile(name: string, text: string): void {
  if (typeof Blob !== "function" || typeof URL.createObjectURL !== "function") return;
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL?.(url), 60_000);
  } catch {
    // скачивание не поддерживается — данные остаются на экране
  }
}

type Action = "idle" | "busy" | "error";

/**
 * Права на свои данные: выгрузка, отключение уведомлений бота, удаление аккаунта.
 * Только с входом через Telegram; удалённый аккаунт — итоговое сообщение вместо раздела.
 * Согласие client_service здесь не собирается и не отзывается: при входе согласие не
 * спрашиваем, цели — заявка и уведомления; его текст — среди документов ниже
 */
function MyData() {
  const { api, webApp, now } = useServices();
  const { t } = useLang();
  const { me, deleted, markDeleted } = useAccount();
  const [exported, setExported] = useState<{ file: string; text: string } | null>(null);
  const [exporting, setExporting] = useState<Action>("idle");
  const [notify, setNotify] = useState<Action>("idle");
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState<Action>("idle");
  const profile = me.status === "ready" ? me.data : null;

  if (deleted) {
    return (
      <div className="callout" role="status">
        <Icon name="checkFill" size={17} />
        <span>
          <b>{t.accountDeletedH}</b>
          <br />
          {t.accountDeletedP}
        </span>
      </div>
    );
  }

  const download = async () => {
    setExporting("busy");
    try {
      const data = await api.exportMyData();
      const file = `bayramm-my-data-${tashkentToday(now())}.json`;
      const text = JSON.stringify(data, null, 2);
      setExported({ file, text });
      setExporting("idle");
      saveFile(file, text);
    } catch {
      setExporting("error");
    }
  };

  const stopNotifications = async () => {
    setNotify("busy");
    try {
      await api.withdrawConsent({ purpose: "bot_notifications" });
      if (profile) me.replace({ ...profile, notifications: false });
      haptic(webApp, "success");
      setNotify("idle");
    } catch {
      haptic(webApp, "error");
      setNotify("error");
    }
  };

  const remove = async () => {
    setRemoving("busy");
    try {
      await api.deleteAccount();
      clearDrafts();
      haptic(webApp, "success");
      markDeleted();
    } catch {
      haptic(webApp, "error");
      setRemoving("error");
    }
  };

  return (
    <>
      <p className="muted small">{t.myDataLead}</p>
      <div className="data-block">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={exporting === "busy"}
          onClick={download}
        >
          {exporting === "busy" ? t.exporting : t.exportData}
        </button>
        {exporting === "error" ? (
          <p className="fld-error" role="alert">
            {t.errExport}
          </p>
        ) : null}
        {exported ? (
          <>
            <p className="small" role="status">
              {t.exportReady(exported.file)}
            </p>
            <details className="doc">
              <summary>{t.exportShow}</summary>
              <pre className="data-dump">{exported.text}</pre>
            </details>
          </>
        ) : null}
      </div>

      {profile ? (
        <div className="data-block">
          <p>{profile.notifications ? t.notifyOn : t.notifyOff}</p>
          {profile.notifications ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={notify === "busy"}
              onClick={stopNotifications}
            >
              {t.notifyStop}
            </button>
          ) : null}
          {notify === "error" ? (
            <p className="fld-error" role="alert">
              {t.errNotify}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="data-block">
        {confirming ? (
          <fieldset className="confirm">
            <legend>{t.deleteQ}</legend>
            <ul className="delete-what">
              {t.deleteWhat.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className="two-buttons">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={removing === "busy"}
                onClick={remove}
              >
                {t.deleteConfirm}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={removing === "busy"}
                onClick={() => {
                  setConfirming(false);
                  setRemoving("idle");
                }}
              >
                {t.deleteKeep}
              </button>
            </div>
            {removing === "error" ? (
              <p className="fld-error" role="alert">
                {t.errDelete}
              </p>
            ) : null}
          </fieldset>
        ) : (
          <button type="button" className="link-btn" onClick={() => setConfirming(true)}>
            {t.deleteAccount}
          </button>
        )}
      </div>
    </>
  );
}

export function Profile() {
  const { webApp, identity } = useServices();
  const { deleted, me } = useAccount();
  const { t } = useLang();
  useDocumentTitle(t.navProfile);
  const user = deleted ? undefined : webApp?.initDataUnsafe.user;
  // Имя: из Telegram (Mini App), на сайте — из профиля аккаунта
  const own = !deleted && me.status === "ready" && me.data ? me.data : null;
  const name = user
    ? [user.first_name, user.last_name].filter(Boolean).join(" ")
    : own
      ? [own.firstName, own.lastName].filter(Boolean).join(" ") || null
      : null;

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

      <AccountSection />

      <Link className="row-link" href={hrefFor({ name: "requests" })}>
        <Icon name="notepad" size={20} />
        <span>
          <b>{t.mrTitle}</b>
          <span className="muted small">{t.mrSub}</span>
        </span>
        <Icon name="caret" size={14} />
      </Link>

      {canSignIn(identity) ? (
        <section className="section" aria-labelledby="profile-data">
          <h2 className="section-title" id="profile-data">
            {t.myData}
          </h2>
          <MyData />
        </section>
      ) : null}

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
