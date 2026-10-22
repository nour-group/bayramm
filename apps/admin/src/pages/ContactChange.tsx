/* «Партнёр предлагает новые контакты» — блок страницы витрины. Партнёр просит сменить публичные
   телефон и Telegram витрины, которая на проверке или на сайте (кабинет, vendor/contacts.ts);
   клиенты до решения видят прежние. Блок самодостаточный: сам спрашивает у API, есть ли ждущее
   предложение (GET /staff/listings/:id/contact-change — без значений), и если нет — ничего не
   рисует. Значения — только по «Показать» (POST …/reveal: сервер пишет чтение в журнал доступа к
   ПДн с причиной «решение по смене контактов»): одной кнопкой «Показать контакты» — «сейчас» и
   «предлагает партнёр». После этого — «Одобрить» (контакты витрины заменятся, партнёру
   уведомление) и «Отклонить» (только с причиной — частые чипами, её увидит партнёр); решили —
   «следующее в очереди» (NextInQueue). Решает модератор или администратор (revisions.moderate),
   остальным — что предложение есть и кто решает. ?focus=contacts (ссылка из оповещения команды и
   очереди) — фокус на заголовок блока. */

import { formatUzPhone } from "@bayramm/shared";
import type {
  ContactChangeResponse,
  ContactChangeReveal,
  RevealedListingContacts,
} from "@bayramm/shared/api/staff";
import { useEffect, useRef, useState } from "react";
import { type Failure, useCan, useLoad, useSession } from "../api";
import { formatMoment } from "../format";
import { readQuery } from "../router";
import { t } from "../texts";
import { busyLabel, ConfirmForm, ErrorText, focusSection, PhoneSheet } from "../ui";
import { NextInQueue } from "./NextInQueue";

const TITLE_ID = "contact-change-title";

/** «+998 90 111 22 33 · @name» — как контакты видит клиент; пусто — «не указано» */
const contactsText = (contacts: Pick<RevealedListingContacts, "telegram"> & { phone: string | null }) =>
  [contacts.phone ? formatUzPhone(contacts.phone) : null, contacts.telegram ? `@${contacts.telegram}` : null]
    .filter(Boolean)
    .join(" · ") || t.notSet;

export function ContactChange({ listingId, onDecided }: { listingId: string; onDecided?: () => void }) {
  const base = `/staff/listings/${listingId}/contact-change`;
  const { api } = useSession();
  const can = useCan();
  const decides = can("revisions.moderate");
  const { loaded, set } = useLoad<ContactChangeResponse>(base);
  const [values, setValues] = useState<ContactChangeReveal | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState<"approve" | "decline" | null>(null);
  const [outcome, setOutcome] = useState<"approved" | "declined" | null>(null);
  const approveButton = useRef<HTMLButtonElement>(null);
  const declineButton = useRef<HTMLButtonElement>(null);
  const [focusWanted] = useState(() => readQuery(["focus"] as const).focus === "contacts");
  const change = loaded.state === "ready" ? loaded.data.change : null;

  // Пришли по ссылке из оповещения: к блоку, когда он появился. Один раз за заход
  const focused = useRef(false);
  useEffect(() => {
    if (!focusWanted || focused.current || change === null) return;
    focused.current = true;
    const timer = setTimeout(() => focusSection(TITLE_ID), 0);
    return () => clearTimeout(timer);
  }, [focusWanted, change]);

  const show = async () => {
    setRevealing(true);
    setFailure(null);
    // Зачем открыли — пишется в журнал доступа к ПДн: здесь причина всегда одна
    const result = await api.post<ContactChangeReveal>(`${base}/reveal`, {
      reason: t.contactChange.revealReason,
    });
    setRevealing(false);
    if (result.ok) {
      setValues(result.data);
      return;
    }
    // Предложение успели отозвать или решить — блок исчезнет сам
    if (result.code === "contact_change_not_pending") set({ change: null });
    else setFailure(result);
  };

  const decide = async (reason: string): Promise<Failure | null> => {
    const result =
      pending === "decline"
        ? await api.post<ContactChangeResponse>(`${base}/decline`, { reason })
        : await api.post<ContactChangeResponse>(`${base}/approve`);
    if (!result.ok) {
      if (result.code === "contact_change_not_pending") {
        setPending(null);
        set({ change: null });
      }
      return result;
    }
    setOutcome(pending === "decline" ? "declined" : "approved");
    setPending(null);
    setValues(null);
    set(result.data);
    onDecided?.();
    return null;
  };

  if (outcome !== null) {
    return (
      <>
        <p className="notice notice-good" role="status">
          {outcome === "approved" ? t.contactChange.approved : t.contactChange.declined}
        </p>
        {/* Решили — сразу к следующей смене контактов в очереди */}
        <NextInQueue queue="contacts" currentId={listingId} />
      </>
    );
  }
  if (change === null) return null;

  return (
    <section className="panel" aria-labelledby={TITLE_ID}>
      <h2 id={TITLE_ID} tabIndex={-1}>
        {t.contactChange.title}
      </h2>
      <p className="muted small">
        {t.contactChange.what(change.phoneChanged, change.telegramChanged, formatMoment(change.submittedAt))}
      </p>
      <p className="muted small">{t.contactChange.keep}</p>

      {values ? (
        <div className="stack">
          <div className="change">
            <p className="change-label">{t.contactChange.now}</p>
            <div className="change-value">{contactsText(values.current)}</div>
          </div>
          <div className="change change-new">
            <p className="change-label">{t.contactChange.proposed}</p>
            <div className="change-value">
              {contactsText(values)}
              {values.telegram === null && values.current.telegram !== null ? (
                <span className="muted"> · {t.contactChange.removeTelegram}</span>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {!decides ? <p className="notice">{t.contactChange.who}</p> : null}
      {decides && !values ? (
        <div className="acts">
          <button
            type="button"
            className="btn btn-sm"
            aria-busy={revealing || undefined}
            disabled={revealing}
            onClick={() => void show()}
          >
            {busyLabel(t.contactChange.reveal, revealing)}
          </button>
          <span className="muted small">{t.contactChange.revealHint}</span>
        </div>
      ) : null}
      {failure ? <ErrorText failure={failure} /> : null}

      {decides && values ? (
        <div className="acts">
          <button
            ref={approveButton}
            type="button"
            className="btn btn-primary"
            aria-expanded={pending === "approve"}
            onClick={() => setPending(pending === "approve" ? null : "approve")}
          >
            {t.contactChange.approve}
          </button>
          <button
            ref={declineButton}
            type="button"
            className="btn btn-danger"
            aria-expanded={pending === "decline"}
            onClick={() => setPending(pending === "decline" ? null : "decline")}
          >
            {t.contactChange.decline}
          </button>
        </div>
      ) : null}
      <PhoneSheet
        open={pending === "approve"}
        title={t.contactChange.approve}
        onClose={() => setPending(null)}
        returnFocus={approveButton}
      >
        <ConfirmForm
          key="approve"
          hint={t.contactChange.approveHint}
          submitLabel={t.contactChange.approve}
          onSubmit={decide}
          onCancel={() => setPending(null)}
        />
      </PhoneSheet>
      <PhoneSheet
        open={pending === "decline"}
        title={t.contactChange.decline}
        onClose={() => setPending(null)}
        returnFocus={declineButton}
      >
        <ConfirmForm
          key="decline"
          hint={t.contactChange.declineHint}
          label={t.reason}
          required
          danger
          maxLength={500}
          presets={t.reasons.contactChangeDecline}
          submitLabel={t.contactChange.decline}
          onSubmit={decide}
          onCancel={() => setPending(null)}
        />
      </PhoneSheet>
    </section>
  );
}
