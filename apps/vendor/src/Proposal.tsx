/* Предложение изменений витрины, которое ждёт решения команды, и его судьба: кабинет показывает
   одно открытое предложение на витрину, его можно отозвать (через подтверждение); решение
   (отказ с причиной) и история последних решений — здесь же. Само предложение партнёр
   составляет в окнах «Изменить» у карточек-групп (ListingEdit.tsx, VenueGroups.tsx): пока
   витрины нет на сайте, изменения сохраняются сразу, на проверке и позже — уходят предложением.
   Цены — не здесь: цена «от» считается из услуг (раздел «Услуги»).

   Клиенты видят одобренную карточку, пока предложение ждёт: у карточки-группы, которую оно
   затрагивает, метка «на проверке» и строка «Предложено: …» (VenueGroups.tsx). Пока предложение
   открыто, новое отправить нельзя — «Изменить» скрыто (одно открытое предложение на витрину).

   История решений — свёрнута («История предложений»): последние пять решённых предложений —
   когда, что решили, какие поля менялись и почему отказали.

   Предлагать и отзывать может только владелец кабинета: сотрудник площадки видит, что
   предложено и что решили, но без кнопок. Предложение, которое внёс менеджер Bayramm (byTeam),
   партнёр не отзывает — по нему решает модератор. */

import type { ListingRevisionPayload, VendorRevision, VendorRevisionList } from "@bayramm/shared/api/vendor";
import { REVISION_KEYS } from "@bayramm/shared/api/vendor";
import { ConfirmSheet } from "@bayramm/ui/react";
import { useId, useRef, useState } from "react";
import { ApiFailure, api } from "./api";
import { errorText as apiErrorText } from "./errors";
import { formatMoment } from "./format";
import { fill, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { LoadError, Loading } from "./ui";
import type { Load } from "./useLoad";

// ── история решений ────────────────────────────────────────────────────────

/** Сколько решённых предложений показывает история */
export const HISTORY_SHOWN = 5;

/** Решённые предложения (одобрено или отклонено), новые первыми, не больше HISTORY_SHOWN */
export function decidedRevisions(items: readonly VendorRevision[]): VendorRevision[] {
  return items.filter((r) => r.status === "approved" || r.status === "declined").slice(0, HISTORY_SHOWN);
}

/** Какие поля менялись: названия из словаря в порядке показа; вместимость — одной строкой */
export function revisionFields(payload: ListingRevisionPayload, t: VendorDict): string[] {
  const label: Readonly<Record<(typeof REVISION_KEYS)[number], string>> = {
    name: t.nameLabel,
    description_ru: t.descriptionRuLabel,
    description_uz: t.descriptionUzLabel,
    attributes: t.attributesTitle,
    video_links: t.videoTitle,
    cap_min: t.capacity,
    cap_max: t.capacity,
    district_code: t.district,
    address_ru: t.addressRuLabel,
    address_uz: t.addressUzLabel,
  };
  const names = REVISION_KEYS.filter((key) => payload[key] !== undefined).map((key) => label[key]);
  return [...new Set(names)];
}

/**
 * «История предложений»: свёрнута, пока партнёр не откроет. Кнопка с aria-expanded (не
 * <details>: в кабинете такого контрола нет, кнопки и свёртки — свои)
 */
function ProposalHistory({ items, t }: { items: readonly VendorRevision[]; t: VendorDict }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const decided = decidedRevisions(items);
  if (decided.length === 0) return null;
  return (
    <div className="proposal-history">
      <button
        type="button"
        className={`btn btn-ghost disclosure${open ? " disclosure-open" : ""}`}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="next" size={14} />
        {t.proposalHistory}
        <span className="count">{decided.length}</span>
      </button>
      {open ? (
        <ol className="revlog" id={listId}>
          {decided.map((revision) => {
            const approved = revision.status === "approved";
            const fields = revisionFields(revision.payload, t);
            return (
              <li key={revision.id}>
                <span className="revlog-head">
                  <span className={`chip chip-${approved ? "done" : "off"}`}>
                    {approved ? t.revApproved : t.revDeclined}
                  </span>
                  {revision.decidedAt ? (
                    <time dateTime={revision.decidedAt}>{formatMoment(revision.decidedAt, t)}</time>
                  ) : null}
                </span>
                {fields.length > 0 ? (
                  <span className="revlog-line">{fill(t.revFields, { fields: fields.join(", ") })}</span>
                ) : null}
                {!approved && revision.decisionReason ? (
                  <span className="revlog-line">
                    {fill(t.reasonLine, { reason: revision.decisionReason })}
                  </span>
                ) : null}
                {revision.byTeam ? <span className="revlog-line revlog-team">{t.revTeam}</span> : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

// ── блок состояния предложения ─────────────────────────────────────────────

interface NoticeProps {
  readonly listingId: string;
  readonly revisions: Load<VendorRevisionList>;
  readonly reload: () => void;
  readonly setRevisions: (update: (data: VendorRevisionList) => VendorRevisionList) => void;
  readonly t: VendorDict;
  /** Владелец кабинета: только он отзывает */
  readonly owner: boolean;
  /** Предложение отозвано: значок «требует внимания» у раздела — заново */
  readonly onChanged?: () => void;
}

/**
 * Открытое предложение: когда отправлено, «клиенты видят прежнее», отзыв; отказ команды с
 * причиной; свёрнутая история. Нечего показать — блока нет (сотруднику площадки — тоже)
 */
export function RevisionNotice({
  listingId,
  revisions,
  reload,
  setRevisions,
  t,
  owner,
  onChanged,
}: NoticeProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [withdrawFailed, setWithdrawFailed] = useState<string | null>(null);
  const withdrawButton = useRef<HTMLButtonElement>(null);

  if (revisions.state === "loading") return <Loading t={t} />;
  if (revisions.state === "error") return <LoadError t={t} onRetry={reload} error={revisions.error} />;

  const items = revisions.data.items;
  const pending = items.find((r) => r.status === "pending");
  const latest = items[0];

  const withdraw = async () => {
    if (!pending) return;
    setBusy(true);
    setWithdrawFailed(null);
    try {
      const next = await api.withdrawRevision(listingId, pending.id);
      setRevisions((list) => ({ items: list.items.map((r) => (r.id === next.id ? next : r)) }));
      setConfirming(false);
      onChanged?.();
    } catch (err) {
      // По предложению уже решили или его внесла команда — показать, как есть
      if (
        err instanceof ApiFailure &&
        (err.code === "illegal_transition" || err.code === "forbidden_for_actor")
      ) {
        setConfirming(false);
        reload();
      } else setWithdrawFailed(apiErrorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  const history = <ProposalHistory items={items} t={t} />;

  if (pending) {
    const date = formatMoment(pending.submittedAt, t);
    // Предложение менеджера Bayramm решает модератор: партнёр его не отзывает
    const withdrawable = owner && !pending.byTeam;
    return (
      <div className="proposal">
        <div className="notice proposal-pending">
          <p>{fill(pending.byTeam ? t.proposalByTeam : t.proposalPending, { date })}</p>
          {owner ? <p className="note">{t.proposalPendingLocked}</p> : null}
          {withdrawable ? (
            <>
              <button
                ref={withdrawButton}
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setWithdrawFailed(null);
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
                error={withdrawFailed ?? undefined}
                onConfirm={() => void withdraw()}
                onCancel={() => setConfirming(false)}
                returnFocus={withdrawButton}
              />
            </>
          ) : null}
        </div>
        {history}
      </div>
    );
  }

  // Прошлое предложение отклонили — причина на виду, пока нет нового; одобренное — в истории
  const declined = latest?.status === "declined" && latest.decisionReason ? latest.decisionReason : null;
  if (declined === null && decidedRevisions(items).length === 0) return null;
  return (
    <div className="proposal">
      {declined !== null ? <p className="notice">{fill(t.proposalDeclined, { reason: declined })}</p> : null}
      {history}
    </div>
  );
}
