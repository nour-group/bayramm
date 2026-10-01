import type { ClientConsentPurpose } from "@bayramm/shared/api";
import { useLang, useServices } from "../context";
import { useAsync } from "../hooks";
import { Icon } from "../icons";
import { Paragraphs } from "./RichText";
import { ErrorState, Loading } from "./States";

const PURPOSE_TITLE = {
  client_service: "cp_client_service",
  request_transfer: "cp_request_transfer",
  bot_notifications: "cp_bot_notifications",
} as const satisfies Record<ClientConsentPurpose, string>;

/** Тексты согласий в действующей версии: те же, что клиент отмечает в форме заявки */
export function Documents() {
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
