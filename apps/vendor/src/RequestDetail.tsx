/* Карточка заявки. Открытие новой отмечает её просмотренной (это делает API).
   Телефон клиента — сразу, без «разблокировки»; нажатие на него пишется в журнал.
   Действия — ровно те переходы, что разрешает база:
     new/viewed → «Я связался» | «Отказать»;  contacted → «Договорились» | «Не подошло»;
     deal/declined → «Вернуть в активные». Отказ — с причиной; «занято» занимает дату.

   Что нужно клиенту — по форме заявки категории: часть дня (модель parts), поля категории
   (detailRows: часы, машины, кг…) и выбранные услуги с количеством и дополнениями — названия
   и цены как были при подаче заявки (chosenServices).

   На компьютере карточка стоит рядом со списком (split): заголовок — h2 под h1 «Заявки»,
   ссылки «Назад» нет (список и так на экране), а после открытия и каждого действия список
   перечитывается (onChanged) — статус и счётчики в нём меняются вместе с карточкой. */

import {
  DECLINE_NOTE_MAX,
  DECLINE_REASONS,
  type DeclineReason,
  type VendorRequestDetail,
  type VendorRequestPatch,
} from "@bayramm/shared/api/vendor";
import { categoryConfig, chosenServices, detailRows } from "@bayramm/shared/categories";
import { RadioGroup } from "@bayramm/ui/react";
import { type FormEvent, type MouseEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiFailure, api } from "./api";
import { categoryName, partName, partWindow, priceText } from "./category";
import { errorText } from "./errors";
import { formatBudget, formatDate, formatGuests, formatMoment, formatPhone, slaView } from "./format";
import { fill, textOf, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { awaitsAnswer, SlaTimer } from "./Requests";
import type { Navigate } from "./router";
import { useBackButton } from "./telegram";
import { Heading, LoadError, Loading, type ScreenProps, StatusChip } from "./ui";
import { useUnsaved } from "./unsaved";
import { useLoad } from "./useLoad";
import { useNow } from "./useNow";

interface DeclineFormProps {
  readonly t: VendorDict;
  readonly busy: boolean;
  readonly onSubmit: (reason: DeclineReason, note: string) => void;
  readonly onCancel: () => void;
}

function DeclineForm({ t, busy, onSubmit, onCancel }: DeclineFormProps) {
  const [reason, setReason] = useState<DeclineReason | null>(null);
  const [note, setNote] = useState("");
  const noteId = useId();
  // Выбранная причина или вписанный комментарий — несохранённое
  useUnsaved(reason !== null || note.trim() !== "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason) onSubmit(reason, note);
  };
  return (
    <form className="panel decline" onSubmit={submit}>
      <fieldset className="choices">
        <legend className="panel-title">{t.declineTitle}</legend>
        <p className="note">{t.declineSub}</p>
        <RadioGroup
          variant="row"
          name="decline-reason"
          value={reason}
          options={DECLINE_REASONS.map((code) => ({ value: code, label: textOf(t, `reason_${code}`) }))}
          onChange={setReason}
        />
      </fieldset>
      {reason === "busy" ? <p className="note">{t.declineBusyNote}</p> : null}
      <label className="field-label" htmlFor={noteId}>
        {t.declineNoteLabel}
      </label>
      <textarea
        id={noteId}
        className="field"
        rows={2}
        maxLength={DECLINE_NOTE_MAX}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="actions">
        <button type="submit" className="btn btn-danger" disabled={reason === null || busy}>
          {t.declineConfirm}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}

interface RequestDetailProps extends ScreenProps {
  readonly id: string;
  readonly navigate: Navigate;
  /** Рядом со списком (компьютер) */
  readonly split?: boolean;
  /** Заявка открыта (стала просмотренной) или изменилась — перечитать список */
  readonly onChanged?: () => void;
  /** Первый ответ API по заявке: её статус (список переходит на её вкладку) */
  readonly onLoaded?: (status: VendorRequestDetail["status"]) => void;
}

/** Что сказать под действиями: правка не сохранилась (текст по коду API) или статус устарел */
type Notice = { readonly kind: "failed"; readonly text: string } | { readonly kind: "stale" } | null;

export function RequestDetail({
  id,
  t,
  lang,
  headingRef,
  navigate,
  split = false,
  onChanged,
  onLoaded,
}: RequestDetailProps) {
  const now = useNow();
  const [detail, reload, setDetail] = useLoad<VendorRequestDetail>(id, (key) => api.request(key));
  const [pending, setPending] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const titleId = split ? "request-title" : "page-title";
  const level = split ? 2 : 1;

  // Открытие новой заявки делает её просмотренной: список рядом должен это показать
  const reported = useRef(false);
  const ready = detail.state === "ready" ? detail.data : null;
  useEffect(() => {
    if (!ready || reported.current) return;
    reported.current = true;
    onLoaded?.(ready.status);
    onChanged?.();
  }, [ready, onLoaded, onChanged]);

  // Нажатая кнопка исчезает (форма отказа вместо действий, новые действия после ответа) —
  // фокус не теряется в body: он переходит на первое поле или кнопку нового блока
  const actionsRef = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const decline = useCallback((open: boolean) => {
    refocus.current = true;
    setDeclining(open);
  }, []);
  const shownStatus = ready?.status;
  // biome-ignore lint/correctness/useExhaustiveDependencies: перенос фокуса — после смены формы или статуса
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    actionsRef.current?.querySelector<HTMLElement>("input, button:not(:disabled)")?.focus();
  }, [declining, shownStatus]);

  const back = useCallback(() => navigate({ route: "requests" }), [navigate]);
  const nativeBack = useBackButton(back);
  // Ссылка «Назад» — для браузера и старых клиентов без кнопки Telegram
  const backLink = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    back();
  };

  const act = async (patch: VendorRequestPatch) => {
    setPending(true);
    setNotice(null);
    try {
      const item = await api.updateRequest(id, patch);
      // Без повторного GET: он заново прочёл бы телефон клиента (и записал бы это в журнал)
      setDetail((current) => ({
        ...current,
        ...item,
        declineNote: patch.declineNote ?? null,
        history:
          item.status === current.status
            ? current.history
            : [...current.history, { status: item.status, at: new Date().toISOString(), by: "vendor_user" }],
      }));
      refocus.current = true;
      setDeclining(false);
      onChanged?.();
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "illegal_transition") {
        setNotice({ kind: "stale" });
        setDeclining(false);
        reload();
        onChanged?.();
      } else {
        setNotice({ kind: "failed", text: errorText(err, t) });
      }
    } finally {
      setPending(false);
    }
  };

  // Ссылка «Назад» — в браузере на телефоне; в Telegram — его кнопка, рядом со списком — не нужна
  const backTo =
    nativeBack || split ? null : (
      <a className="back-link" href="/requests" onClick={backLink}>
        <Icon name="back" size={14} />
        {t.back}
      </a>
    );

  if (detail.state === "loading") {
    return (
      <section className="page request" aria-busy="true">
        {backTo}
        <Loading t={t} kind="card" />
      </section>
    );
  }
  if (detail.state === "error") {
    const missing = detail.error instanceof ApiFailure && detail.error.status === 404;
    return (
      <section className="page request" aria-labelledby={missing ? titleId : undefined}>
        {backTo}
        {missing ? (
          <>
            <Heading headingRef={headingRef} level={level} id={titleId}>
              {t.requestNotFound}
            </Heading>
            <p className="lead">{t.requestNotFoundText}</p>
          </>
        ) : (
          <LoadError t={t} onRetry={reload} error={detail.error} />
        )}
      </section>
    );
  }

  const request = detail.data;
  const Sub = split ? "h3" : "h2";
  const budget = formatBudget(request.budgetMinUzs, request.budgetMaxUzs, t, lang);
  const late = awaitsAnswer(request) && slaView(request.sla, now).kind === "late";
  const status = request.status;
  const category = categoryConfig(request.listing.categoryCode);
  const rows = detailRows(lang, category, request.details, (code) => textOf(t, `dist_${code}`));
  const services = chosenServices(category, request.details);

  return (
    <section className="page request" aria-labelledby={titleId}>
      {backTo}
      <div className="detail-top">
        <Heading headingRef={headingRef} level={level} id={titleId}>
          {fill(t.requestNo, { n: request.publicNo })}
        </Heading>
        <StatusChip status={status} late={late} t={t} />
      </div>
      {awaitsAnswer(request) ? <SlaTimer item={request} t={t} now={now} /> : null}

      <dl className="facts">
        <div>
          <dt>{t.eventDate}</dt>
          <dd>{formatDate(request.eventDate, t, true)}</dd>
        </div>
        {request.dayPart ? (
          <div>
            <dt>{t.dayPartLabel}</dt>
            <dd>
              {partName(t, request.dayPart)}{" "}
              <span className="fact-sub">{partWindow(category, request.dayPart)}</span>
            </dd>
          </div>
        ) : null}
        {request.guests === null ? null : (
          <div>
            <dt>{t.guestsLabel}</dt>
            <dd>{formatGuests(request.guests, t)}</dd>
          </div>
        )}
        <div>
          <dt>{t.budgetLabel}</dt>
          <dd>{budget ?? t.budgetNone}</dd>
        </div>
        <div>
          <dt>{t.occasionLabel}</dt>
          <dd>{textOf(t, `occ_${request.occasionCode}`)}</dd>
        </div>
        <div className="facts-wide">
          <dt>{t.listingPicker}</dt>
          <dd className="fact-vitrina">
            <span>{request.listing.name}</span>
            <span className="chip chip-cat">{categoryName(lang, request.listing.categoryCode)}</span>
          </dd>
        </div>
      </dl>

      {request.contact ? (
        <div className="panel client">
          <p className="panel-title">{t.clientLabel}</p>
          <p className="client-name">{request.contact.name}</p>
          {request.contact.phone ? (
            <a
              className="btn btn-primary btn-wide btn-phone"
              href={`tel:${request.contact.phone}`}
              aria-label={`${t.call} ${formatPhone(request.contact.phone)}`}
              onClick={() => void api.callAttempt(id).catch(() => {})}
            >
              <Icon name="phone" size={20} />
              {formatPhone(request.contact.phone)}
            </a>
          ) : null}
          {request.contact.comment ? (
            <div className="comment">
              <p className="field-label">{t.commentLabel}</p>
              <p>{request.contact.comment}</p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="notice">{t.contactHidden}</p>
      )}

      {/* Сначала клиент и звонок — ответить за 12 часов; что нужно клиенту — следом */}
      {rows.length > 0 || services.length > 0 ? (
        <section className="panel request-details" aria-labelledby={`${titleId}-details`}>
          <Sub className="panel-title" id={`${titleId}-details`}>
            {t.requestDetails}
          </Sub>
          {rows.length > 0 ? (
            <dl className="detail-rows">
              {rows.map((row) =>
                row.value === null ? (
                  <div key={row.key} className="detail-flag">
                    <dt>
                      <Icon name="check" size={14} />
                      {row.label}
                    </dt>
                    <dd className="sr-only">{t.yes}</dd>
                  </div>
                ) : (
                  <div key={row.key}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ),
              )}
            </dl>
          ) : null}
          {services.length > 0 ? (
            <div className="chosen">
              <p className="field-label">{t.chosenServices}</p>
              <ul className="chosen-list">
                {services.map((service) => (
                  <li key={service.id}>
                    <p className="chosen-head">
                      <span className="chosen-name">
                        {service.name[lang]}
                        {service.qty === null ? "" : ` ${fill(t.qtyLine, { n: service.qty })}`}
                      </span>
                      <span className="chosen-price">
                        {priceText(service.priceUzs, service.priceUnit, t, lang)}
                      </span>
                    </p>
                    {service.options.length > 0 ? (
                      <ul className="chosen-options">
                        {service.options.map((option) => (
                          <li key={option.id}>
                            <span>+ {option.name[lang]}</span>
                            <span className="chosen-price">
                              {priceText(option.priceUzs, option.priceUnit, t, lang)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {notice ? (
        <p className="form-error" role="alert">
          {notice.kind === "stale" ? t.staleStatus : notice.text}
        </p>
      ) : null}

      <div className="request-actions" ref={actionsRef}>
        {declining ? (
          <DeclineForm
            t={t}
            busy={pending}
            onCancel={() => decline(false)}
            onSubmit={(reason, note) =>
              void act({
                status: "declined",
                declineReason: reason,
                ...(note.trim() ? { declineNote: note } : {}),
              })
            }
          />
        ) : (
          <div className="panel">
            {status === "new" || status === "viewed" ? (
              <>
                <p className="note">{t.callFirst}</p>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-dark"
                    disabled={pending}
                    onClick={() => void act({ status: "contacted" })}
                  >
                    <Icon name="check" size={17} />
                    {t.actContacted}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={pending}
                    onClick={() => decline(true)}
                  >
                    {t.actDecline}
                  </button>
                </div>
              </>
            ) : null}
            {status === "contacted" ? (
              <>
                <p className="panel-title">{t.askOutcome}</p>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-dark"
                    disabled={pending}
                    onClick={() => void act({ status: "deal" })}
                  >
                    <Icon name="check" size={17} />
                    {t.actDeal}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={pending}
                    onClick={() => decline(true)}
                  >
                    {t.actNoDeal}
                  </button>
                </div>
              </>
            ) : null}
            {status === "deal" || status === "declined" ? (
              <>
                {status === "declined" && request.declineReason ? (
                  <p className="note">
                    {fill(t.reasonLine, { reason: textOf(t, `reason_${request.declineReason}`) })}
                    {request.declineNote ? ` — ${request.declineNote}` : ""}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={pending}
                  onClick={() => void act({ status: "contacted" })}
                >
                  {t.actReopen}
                </button>
              </>
            ) : null}
            {status === "withdrawn" || status === "expired" ? (
              <p className="note">{status === "withdrawn" ? t.doneWithdrawn : t.doneExpired}</p>
            ) : null}
          </div>
        )}
      </div>

      <p className="note">{t.consentNote}</p>

      {request.history.length > 0 ? (
        <div className="history">
          <Sub className="section-title">{t.history}</Sub>
          <ol>
            {request.history.map((entry) => (
              <li key={`${entry.at}-${entry.status}`}>
                <span className="history-status">{textOf(t, `st_${entry.status}`)}</span>
                <span className="history-meta">
                  {formatMoment(entry.at, t, now)} · {textOf(t, `by_${entry.by}`)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
