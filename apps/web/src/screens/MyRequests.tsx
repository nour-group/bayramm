import type { ClientRequest, DeclineReason, RequestStatus } from "@bayramm/shared/api";
import { useEffect, useRef, useState } from "react";
import { isApiError } from "../api/errors";
import { Link } from "../components/Link";
import { Photo } from "../components/Photo";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { useAccount, useDictionaries, useLang, useServices } from "../context";
import { formatDayMonth, formatDuration, formatMomentTashkent, hoursLeft } from "../format";
import { useAsync, useDocumentTitle, useNow } from "../hooks";
import { Icon } from "../icons";
import { hrefFor, useNav } from "../router";
import { haptic } from "../telegram";

/* Статус → текст чипа и его вид. «contacted» — вендор связался: для клиента «ответили» */
const STATUS_TEXT = {
  new: "st_new",
  viewed: "st_viewed",
  contacted: "st_ans",
  deal: "st_deal",
  declined: "st_declined",
  withdrawn: "st_withdrawn",
  expired: "st_expired",
} as const satisfies Record<RequestStatus, string>;

const STATUS_TONE: Readonly<Record<RequestStatus, "wait" | "answer" | "deal" | "stop" | "closed">> = {
  new: "wait",
  viewed: "wait",
  contacted: "answer",
  deal: "deal",
  declined: "stop",
  withdrawn: "closed",
  expired: "closed",
};

const DECLINE_TEXT = {
  busy: "dr_busy",
  format: "dr_format",
  price: "dr_price",
  other: "dr_other",
} as const satisfies Record<DeclineReason, string>;

/** Ждём ответа вендора: статус ещё не сдвинулся дальше «просмотрена» */
const WAITING: readonly RequestStatus[] = ["new", "viewed"];
/** Отозвать можно, пока заявка в работе */
const WITHDRAWABLE: readonly RequestStatus[] = ["new", "viewed", "contacted"];

function RequestItem({
  request,
  highlighted,
  duplicate,
  onWithdrawn,
}: {
  request: ClientRequest;
  /** Открыта по ссылке (?open=<id>): кнопка бота или повторная заявка */
  highlighted: boolean;
  /** Сюда привела повторная заявка на ту же дату (?dup=1) */
  duplicate: boolean;
  onWithdrawn: (next: ClientRequest) => void;
}) {
  const { api, webApp, now } = useServices();
  const { t } = useLang();
  const { occasionName } = useDictionaries();
  const current = useNow(now);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const item = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!highlighted) return;
    item.current?.focus({ preventScroll: true });
    item.current?.scrollIntoView?.({ block: "center" });
  }, [highlighted]);

  const waiting = WAITING.includes(request.status) && request.firstResponseAt === null;
  const breached = waiting && request.slaBreached;
  const left = hoursLeft(request.slaDueAt, current);
  const similarHref = hrefFor(
    { name: "catalog" },
    { date: request.eventDate, guests: request.guests, district: request.listing.districtCode },
  );

  const withdraw = async () => {
    setBusy(true);
    setError(false);
    try {
      const next = await api.withdrawRequest(request.id);
      haptic(webApp, "success");
      setConfirming(false);
      onWithdrawn(next);
    } catch {
      haptic(webApp, "error");
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className={highlighted ? "req highlighted" : "req"}
      ref={item}
      tabIndex={highlighted ? -1 : undefined}
    >
      <div className="req-head">
        <Photo photo={request.listing.cover} alt="" sizes="56px" className="rq-thumb" />
        <div className="req-main">
          <h2 className="req-name">
            <Link href={hrefFor({ name: "venue", slug: request.listing.slug })}>{request.listing.name}</Link>
          </h2>
          <p className="muted small">
            {[
              occasionName(request.occasionCode),
              formatDayMonth(request.eventDate, t),
              t.guestsShort(request.guests),
              t.requestNo(request.publicNo),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <span className={`status status-${STATUS_TONE[request.status]}`}>
          {t[STATUS_TEXT[request.status]]}
        </span>
      </div>

      {highlighted && duplicate ? <p className="callout">{t.duplicateNote}</p> : null}

      {waiting && !breached ? (
        <p className="req-sla">
          <Icon name="clockD" size={14} />
          <span>
            {t.dueBy(formatMomentTashkent(request.slaDueAt, t))}
            {left > 0 ? ` · ${t.mrLeft(left)}` : ""}
          </span>
        </p>
      ) : null}

      {breached ? (
        <div className="req-breached">
          <p className="late">{t.mrLate}</p>
          <p className="small">{t.slaBreachedNote}</p>
          <Link className="btn btn-secondary" href={similarHref}>
            {t.similar}
          </Link>
        </div>
      ) : null}

      {request.firstResponseAt ? (
        <p className="req-sla">
          <Icon name="checkFill" size={14} />
          <span>
            {t.answeredIn(
              formatDuration(Date.parse(request.firstResponseAt) - Date.parse(request.createdAt), t),
            )}
          </span>
        </p>
      ) : null}

      {request.status === "declined" && request.declineReason ? (
        <p className="req-declined">{t.declinedBecause(t[DECLINE_TEXT[request.declineReason]])}</p>
      ) : null}

      {WITHDRAWABLE.includes(request.status) ? (
        confirming ? (
          <fieldset className="confirm">
            <legend>{t.withdrawQ}</legend>
            <div className="two-buttons">
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={withdraw}>
                {t.withdraw}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                {t.withdrawKeep}
              </button>
            </div>
            {error ? (
              <p className="fld-error" role="alert">
                {t.errWithdraw}
              </p>
            ) : null}
          </fieldset>
        ) : (
          <button type="button" className="link-btn" onClick={() => setConfirming(true)}>
            {t.withdraw}
          </button>
        )
      ) : null}
    </li>
  );
}

function RequestList() {
  const { api } = useServices();
  const { t } = useLang();
  const { query } = useNav();
  const requests = useAsync("my-requests", (signal) => api.myRequests(signal));
  // ?open=<id> — раскрыть заявку: так ведут кнопки бота о статусе и повторная заявка (&dup=1)
  const open = query.get("open");
  const duplicate = query.get("dup") === "1";

  if (requests.status === "loading") return <Loading />;
  if (requests.status === "error") {
    const signIn = isApiError(requests.error) && requests.error.status === 401;
    return <ErrorState message={signIn ? t.signInFailed : undefined} onRetry={requests.reload} />;
  }

  const { items } = requests.data;
  if (items.length === 0)
    return (
      <EmptyState
        title={t.mrSubEmpty}
        text={t.mrEmpty}
        action={
          <Link className="btn btn-primary" href={hrefFor({ name: "catalog" })}>
            {t.toCatalog}
          </Link>
        }
      />
    );

  return (
    <ul className="reqs">
      {items.map((request) => (
        <RequestItem
          key={request.id}
          request={request}
          highlighted={request.id === open}
          duplicate={duplicate}
          onWithdrawn={(next) =>
            requests.replace({ items: items.map((item) => (item.id === next.id ? next : item)) })
          }
        />
      ))}
    </ul>
  );
}

/** Свои заявки — только после входа: гостя оболочка уводит в хаб входа (nav.ts, signInGate) */
export function MyRequests() {
  const { deleted } = useAccount();
  const { t } = useLang();
  useDocumentTitle(t.mrTitle);

  const body = deleted ? <EmptyState title={t.accountDeletedH} text={t.accountDeletedP} /> : <RequestList />;

  return (
    <div className="screen my-requests">
      <h1 className="screen-title" tabIndex={-1}>
        {t.mrTitle}
      </h1>
      <p className="muted">{t.mrNote}</p>
      {body}
    </div>
  );
}
