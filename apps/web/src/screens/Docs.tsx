import { Documents } from "../components/Documents";
import { RichText } from "../components/RichText";
import { useLang } from "../context";
import { useDocumentTitle } from "../hooks";

/* «Документы» (/docs) — отдельной страницей для подвала сайта и поисковиков: тексты
   согласий в действующей версии и как работает заявка. Те же блоки — в профиле */
export function Docs() {
  const { t } = useLang();
  useDocumentTitle(t.meDocs, t.metaDocsDesc);

  return (
    <div className="screen docs-page">
      <h1 className="screen-title" tabIndex={-1}>
        {t.meDocs}
      </h1>
      <p className="muted page-lead">{t.docsLead}</p>
      <section className="section" aria-labelledby="docs-consents">
        <h2 className="section-title" id="docs-consents">
          {t.consentsTitle}
        </h2>
        <Documents />
      </section>
      <section className="section" aria-labelledby="docs-about">
        <h2 className="section-title" id="docs-about">
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
