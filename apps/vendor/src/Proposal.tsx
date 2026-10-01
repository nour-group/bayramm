/* Изменения карточки: партнёр предлагает новое название, описания, поля витрины своей
   категории (Attributes.tsx) и ссылки на видео (у фото и видео, студии), команда Bayramm
   проверяет (панель → «Модерация»). Цены — не здесь: цена «от» считается из услуг (раздел
   «Услуги»). Клиенты видят одобренную карточку, пока предложение ждёт решения. Одно открытое
   предложение на площадку: пока оно на проверке — его видно здесь, его можно отозвать;
   решение (одобрено или отказ с причиной) — тоже здесь.

   Предлагать и отзывать может только владелец кабинета: сотрудник площадки видит, что
   предложено и что решили, но без формы и кнопок. Предложение, которое внёс менеджер Bayramm
   (byTeam), партнёр не отзывает — по нему решает модератор.

   В предложение уходят только изменённые поля (у полей витрины — только изменённые ключи,
   attributePatch); ничего не изменили — запроса нет. Поля проверяются до запроса теми же
   правилами, что на сервере (attributeErrors, videoLinkErrors); неверные поля от сервера
   (attributes.fleet.0.class, video_links.1) тоже подсвечиваются. Контролы — из @bayramm/ui/react. */

import type {
  ListingRevisionPayload,
  VendorListing,
  VendorRevision,
  VendorRevisionList,
} from "@bayramm/shared/api/vendor";
import { DESCRIPTION_MAX } from "@bayramm/shared/api/vendor";
import {
  type AttributeDraft,
  type AttributeDrafts,
  type AttributeValue,
  attributeDrafts,
  attributeErrors,
  attributePatch,
  type CategoryConfig,
  categoryConfig,
  videoLinkErrors,
  videoLinksValue,
} from "@bayramm/shared/categories";
import { ConfirmSheet } from "@bayramm/ui/react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { AttributeFacts, AttributesForm } from "./Attributes";
import { ApiFailure, api } from "./api";
import { formatMoment } from "./format";
import { fill, type VendorDict } from "./i18n";
import { LoadError, Loading } from "./ui";
import { useLoad } from "./useLoad";

interface Values {
  readonly name: string;
  readonly descriptionRu: string;
  readonly descriptionUz: string;
}

/** Ссылки на видео в форме: сохранённые, а если их нет — одно пустое поле */
const videoDraftsOf = (listing: VendorListing) =>
  listing.videoLinks.length > 0 ? [...listing.videoLinks] : [""];

/**
 * Предложение: только изменённые поля. category — категория витрины (поля витрины и
 * видео); before — поля витрины, как их загрузила форма
 */
export function proposalOf(
  listing: VendorListing,
  category: CategoryConfig | undefined,
  values: Values,
  drafts: AttributeDrafts,
  before: AttributeDrafts,
  videos: readonly string[],
): ListingRevisionPayload {
  const payload: { -readonly [K in keyof ListingRevisionPayload]: ListingRevisionPayload[K] } = {};
  const name = values.name.trim();
  if (name !== listing.name) payload.name = name;
  const ru = values.descriptionRu.trim();
  if (ru !== listing.description.ru.trim()) payload.description_ru = ru;
  const uz = values.descriptionUz.trim();
  if (uz !== listing.description.uz.trim()) payload.description_uz = uz;
  if (category) {
    const patch = attributePatch(category, drafts, before);
    if (Object.keys(patch).length > 0)
      payload.attributes = patch as Readonly<Record<string, AttributeValue | null>>;
    if (category.maxVideoLinks > 0) {
      const links = videoLinksValue(videos);
      if (JSON.stringify(links) !== JSON.stringify(listing.videoLinks)) payload.video_links = links;
    }
  }
  return payload;
}

// ── что предложено ─────────────────────────────────────────────────────────

function Proposed({
  payload,
  listing,
  t,
  lang,
}: {
  payload: ListingRevisionPayload;
  listing: VendorListing;
  t: VendorDict;
  lang: "ru" | "uz";
}) {
  const category = categoryConfig(listing.categoryCode);
  return (
    <dl className="facts proposal-facts">
      {payload.name !== undefined ? (
        <div className="facts-wide">
          <dt>{t.nameLabel}</dt>
          <dd>{payload.name}</dd>
        </div>
      ) : null}
      {payload.description_ru !== undefined ? (
        <div className="facts-wide">
          <dt>{t.descriptionRuLabel}</dt>
          <dd className="description" lang="ru">
            {payload.description_ru}
          </dd>
        </div>
      ) : null}
      {payload.description_uz !== undefined ? (
        <div className="facts-wide">
          <dt>{t.descriptionUzLabel}</dt>
          <dd className="description" lang="uz">
            {payload.description_uz}
          </dd>
        </div>
      ) : null}
      {payload.attributes !== undefined && category ? (
        <div className="facts-wide">
          <dt>{t.attributesTitle}</dt>
          <dd>
            <AttributeFacts category={category} attributes={payload.attributes} t={t} lang={lang} />
          </dd>
        </div>
      ) : null}
      {payload.video_links !== undefined ? (
        <div className="facts-wide">
          <dt>{t.videoTitle}</dt>
          <dd>
            {payload.video_links.length === 0 ? (
              t.notSet
            ) : (
              <ul className="video-list">
                {payload.video_links.map((link) => (
                  <li key={link}>{link}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

// ── форма ──────────────────────────────────────────────────────────────────

interface FormProps {
  readonly listing: VendorListing;
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
  readonly onSent: (revision: VendorRevision) => void;
  /** Открытое предложение уже есть (409): показать его */
  readonly onPendingExists: () => void;
  readonly onCancel: () => void;
}

type FormNotice = "noChanges" | "invalid" | "failed" | "pendingExists" | null;

/** Ссылка на видео N из пути ответа API: video_links.1 → 1; весь список — все */
function videoErrorIndexes(details: readonly string[], count: number): number[] {
  if (details.includes("video_links")) return Array.from({ length: count }, (_, i) => i);
  return details.flatMap((path) => {
    const match = /^video_links\.(\d+)$/.exec(path);
    return match ? [Number(match[1])] : [];
  });
}

function ProposalForm({ listing, t, lang, onSent, onPendingExists, onCancel }: FormProps) {
  const id = useId();
  const category = categoryConfig(listing.categoryCode);
  const [values, setValues] = useState<Values>(() => ({
    name: listing.name,
    descriptionRu: listing.description.ru,
    descriptionUz: listing.description.uz,
  }));
  const [before] = useState<AttributeDrafts>(() =>
    category ? attributeDrafts(category, listing.attributes) : {},
  );
  const [drafts, setDrafts] = useState<AttributeDrafts>(before);
  const [videos, setVideos] = useState<string[]>(() => videoDraftsOf(listing));
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const [badVideos, setBadVideos] = useState<ReadonlySet<number>>(new Set());
  const [notice, setNotice] = useState<FormNotice>(null);
  const [busy, setBusy] = useState(false);
  const maxVideos = category?.maxVideoLinks ?? 0;

  const set = (key: keyof Values) => (value: string) => setValues((prev) => ({ ...prev, [key]: value }));
  const bad = (key: string) => invalid.has(key);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    // Сначала — те же проверки, что на сервере: поля витрины и ссылки
    const attrErrors = category ? attributeErrors(category, drafts) : [];
    const videoErrors = category && maxVideos > 0 ? videoLinkErrors(category, videos) : [];
    if (attrErrors.length > 0 || videoErrors.length > 0) {
      setInvalid(new Set(attrErrors));
      setBadVideos(new Set(videoErrors));
      setNotice("invalid");
      return;
    }
    const payload = proposalOf(listing, category, values, drafts, before, videos);
    setInvalid(new Set());
    setBadVideos(new Set());
    if (Object.keys(payload).length === 0) {
      setNotice("noChanges");
      return;
    }
    setBusy(true);
    try {
      onSent(await api.proposeRevision(listing.id, payload));
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "invalid_input") {
        // attributes.fleet.0.class — подсвечивается поле, запись и список; name — поле
        setInvalid(new Set(err.details));
        setBadVideos(new Set(videoErrorIndexes(err.details, videos.length)));
        setNotice("invalid");
      } else if (err instanceof ApiFailure && err.code === "no_changes") {
        setNotice("noChanges");
      } else if (err instanceof ApiFailure && err.code === "revision_pending") {
        setNotice("pendingExists");
        onPendingExists();
      } else {
        setNotice("failed");
      }
    } finally {
      setBusy(false);
    }
  };

  const errorText = (key: string) =>
    bad(key) ? (
      <p className="field-error" id={`${id}-${key}-error`}>
        {t.fieldInvalid}
      </p>
    ) : null;
  const described = (key: string) => (bad(key) ? `${id}-${key}-error` : undefined);

  const text = (
    key: "name" | "descriptionRu" | "descriptionUz",
    field: string,
    label: string,
    multiline: boolean,
  ) => {
    const inputId = `${id}-${key}`;
    const common = {
      id: inputId,
      className: "field",
      value: values[key],
      "aria-invalid": bad(field) || undefined,
      "aria-describedby": described(field),
      onChange: (event: { target: { value: string } }) => set(key)(event.target.value),
    };
    return (
      <div className="form-row">
        <label className="field-label" htmlFor={inputId}>
          {label}
        </label>
        {multiline ? (
          <textarea
            {...common}
            rows={5}
            maxLength={DESCRIPTION_MAX}
            lang={key === "descriptionUz" ? "uz" : "ru"}
          />
        ) : (
          <input {...common} maxLength={80} autoComplete="off" />
        )}
        {errorText(field)}
      </div>
    );
  };

  const notices: Record<Exclude<FormNotice, null>, string> = {
    noChanges: t.proposalNoChanges,
    invalid: t.proposalInvalid,
    failed: t.actionFailed,
    pendingExists: t.proposalPendingExists,
  };

  return (
    <form className="proposal-form" onSubmit={submit} noValidate>
      {text("name", "name", t.nameLabel, false)}
      {/* Шире телефона поля — парами: описание RU рядом с UZ */}
      <div className="form-grid">
        {text("descriptionRu", "description_ru", t.descriptionRuLabel, true)}
        {text("descriptionUz", "description_uz", t.descriptionUzLabel, true)}
      </div>

      {category && category.attributes.length > 0 ? (
        <fieldset className="choices proposal-attributes">
          <legend className="panel-title">{t.attributesTitle}</legend>
          <p className="note">{t.attributesLead}</p>
          <AttributesForm
            category={category}
            drafts={drafts}
            onChange={(key: string, value: AttributeDraft) =>
              setDrafts((prev) => ({ ...prev, [key]: value }))
            }
            invalid={invalid}
            t={t}
            lang={lang}
            idPrefix={`${id}-attr`}
          />
        </fieldset>
      ) : null}

      {maxVideos > 0 ? (
        <fieldset className="choices proposal-videos">
          <legend className="panel-title">{t.videoTitle}</legend>
          <p className="note">{fill(t.videoLead, { max: maxVideos })}</p>
          {videos.map((link, index) => {
            const inputId = `${id}-video-${index}`;
            const wrong = badVideos.has(index);
            return (
              // Ссылки без своего id: номер поля и есть его место
              // biome-ignore lint/suspicious/noArrayIndexKey: поле ссылки — по месту
              <div key={index} className="form-row video-row">
                <label className="field-label" htmlFor={inputId}>
                  {fill(t.videoLabel, { n: index + 1 })}
                </label>
                <div className="video-field">
                  <input
                    id={inputId}
                    className="field"
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    maxLength={200}
                    placeholder="https://"
                    value={link}
                    aria-invalid={wrong || undefined}
                    aria-describedby={wrong ? `${inputId}-error` : undefined}
                    onChange={(event) =>
                      setVideos((prev) => prev.map((v, i) => (i === index ? event.target.value : v)))
                    }
                  />
                  {videos.length > 1 || link !== "" ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setBadVideos(new Set());
                        setVideos((prev) => {
                          const next = prev.filter((_, i) => i !== index);
                          return next.length > 0 ? next : [""];
                        });
                      }}
                    >
                      {fill(t.videoRemove, { n: index + 1 })}
                    </button>
                  ) : null}
                </div>
                {wrong ? (
                  <p className="field-error" id={`${inputId}-error`}>
                    {t.videoInvalid}
                  </p>
                ) : null}
              </div>
            );
          })}
          {videos.length < maxVideos ? (
            <button
              type="button"
              className="btn btn-ghost attr-add"
              onClick={() => setVideos((prev) => [...prev, ""])}
            >
              {t.videoAdd}
            </button>
          ) : null}
        </fieldset>
      ) : null}

      {notice ? (
        <p className={notice === "noChanges" ? "note" : "form-error"} role="alert">
          {notices[notice]}
        </p>
      ) : null}
      <div className="actions">
        <button type="submit" className="btn btn-dark" disabled={busy}>
          {t.proposalSubmit}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}

// ── раздел целиком ─────────────────────────────────────────────────────────

interface ProposalProps {
  readonly listing: VendorListing;
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
  /** Владелец кабинета: только он предлагает и отзывает */
  readonly owner: boolean;
}

export function Proposal({ listing, t, lang, owner }: ProposalProps) {
  const [revisions, reload, setRevisions] = useLoad<VendorRevisionList>(listing.id, (key) =>
    api.revisions(key),
  );
  const [editing, setEditing] = useState(false);
  const [sent, setSent] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [withdrawFailed, setWithdrawFailed] = useState(false);
  const withdrawButton = useRef<HTMLButtonElement>(null);
  // Кнопка, которую нажали, исчезает (форма вместо «Предложить», «на проверке» вместо
  // формы) — фокус переходит в новый блок: на первое поле формы, на «Предложить» после
  // «Отмены», на заголовок раздела после отправки (сам статус «Отправлено» читает диктор)
  const section = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const refocus = useRef<"first" | "title" | null>(null);
  const edit = (open: boolean) => {
    refocus.current = "first";
    setEditing(open);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: перенос фокуса — после смены формы или отправки
  useEffect(() => {
    const target = refocus.current;
    if (target === null) return;
    refocus.current = null;
    if (target === "title") title.current?.focus();
    else section.current?.querySelector<HTMLElement>(".proposal-form input, .proposal-start")?.focus();
  }, [editing, sent]);

  const body = () => {
    if (revisions.state === "loading") return <Loading t={t} />;
    if (revisions.state === "error") return <LoadError t={t} onRetry={reload} />;
    const items = revisions.data.items;
    const pending = items.find((r) => r.status === "pending");
    const latest = items[0];

    const replace = (next: VendorRevision) =>
      setRevisions((list) => ({ items: list.items.map((r) => (r.id === next.id ? next : r)) }));

    const withdraw = async () => {
      if (!pending) return;
      setBusy(true);
      setWithdrawFailed(false);
      try {
        replace(await api.withdrawRevision(listing.id, pending.id));
        setConfirming(false);
        setSent(false);
      } catch (err) {
        // По предложению уже решили или его внесла команда — показать, как есть
        if (
          err instanceof ApiFailure &&
          (err.code === "illegal_transition" || err.code === "forbidden_for_actor")
        ) {
          setConfirming(false);
          reload();
        } else setWithdrawFailed(true);
      } finally {
        setBusy(false);
      }
    };

    if (pending) {
      const date = formatMoment(pending.submittedAt, t);
      // Предложение менеджера Bayramm решает модератор: партнёр его не отзывает
      const withdrawable = owner && !pending.byTeam;
      return (
        <>
          {sent ? (
            <p className="note" role="status">
              {t.proposalSent}
            </p>
          ) : null}
          <div className="notice proposal-pending">
            <p>{fill(pending.byTeam ? t.proposalByTeam : t.proposalPending, { date })}</p>
            <Proposed payload={pending.payload} listing={listing} t={t} lang={lang} />
          </div>
          {withdrawable ? (
            <>
              <button
                ref={withdrawButton}
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setWithdrawFailed(false);
                  setConfirming(true);
                }}
              >
                {t.proposalWithdraw}
              </button>
              <ConfirmSheet
                open={confirming}
                title={t.proposalWithdrawQ}
                text={t.proposalWithdrawText}
                confirmLabel={t.proposalWithdraw}
                cancelLabel={t.cancel}
                tone="danger"
                busy={busy}
                error={withdrawFailed ? t.actionFailed : undefined}
                onConfirm={() => void withdraw()}
                onCancel={() => setConfirming(false)}
                returnFocus={withdrawButton}
              />
            </>
          ) : null}
        </>
      );
    }

    return (
      <>
        {latest?.status === "declined" && latest.decisionReason ? (
          <p className="notice">{fill(t.proposalDeclined, { reason: latest.decisionReason })}</p>
        ) : null}
        {latest?.status === "approved" && latest.decidedAt ? (
          <p className="note">{fill(t.proposalApproved, { date: formatMoment(latest.decidedAt, t) })}</p>
        ) : null}
        {!owner ? (
          <p className="note">{t.proposalOwnerOnly}</p>
        ) : editing ? (
          <ProposalForm
            listing={listing}
            t={t}
            lang={lang}
            onSent={(revision) => {
              setRevisions((list) => ({ items: [revision, ...list.items] }));
              refocus.current = "title";
              setEditing(false);
              setSent(true);
            }}
            onPendingExists={reload}
            onCancel={() => edit(false)}
          />
        ) : (
          <>
            <p className="note">{t.proposalLead}</p>
            <button type="button" className="btn btn-dark proposal-start" onClick={() => edit(true)}>
              {t.proposalStart}
            </button>
          </>
        )}
      </>
    );
  };

  return (
    <section className="panel proposal" aria-labelledby="proposal-title" ref={section}>
      <h2 className="section-title" id="proposal-title" ref={title} tabIndex={-1}>
        {t.proposalTitle}
      </h2>
      {body()}
    </section>
  );
}
