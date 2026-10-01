/* Календарь занятости витрины — по модели занятости её категории:
     · day (залы) — месяц, одно нажатие — день занят или свободен;
     · slot (студия) — то же; время и часы клиент указывает в заявке;
     · parts (фото и видео, кортеж, декор) — день делится на утро, день и вечер. Нажатие на
       день открывает его части: занять весь день или одну часть (?part=). Часть занята, когда
       её отметили или договорённостей (заявки deal) на неё не меньше, чем витрина берёт
       заказов одновременно (parallelCapacity) — это число правится здесь же;
     · lead (цветы, торты, подарки) — календаря нет: срок «заказ не позже чем за N дней» из
       поля витрины и сроки услуг, со ссылками туда, где они меняются.

   Отметка сразу видна на экране и уходит в API; не сохранилось — возвращается как было. Дни,
   занятые отказом «занято», вендор может освободить; закрытые менеджером — нет. Прошедшие дни
   не меняются. «Сегодня» и границы — по Ташкенту, их отдаёт сервер.

   Календарь ведут несколько человек: партнёр, его коллеги, менеджер, а отказ «занято» занимает
   дату сам. Каждая правка (и число заказов одновременно) несёт версию календаря, которую видел
   человек (If-Match); правки уходят по очереди, каждая — от версии из прошлого ответа. Кто-то
   успел изменить календарь раньше (409 calendar_conflict) — месяц перечитывается, человек
   видит, что его изменили, и отмечает заново: чужая правка молча не затирается.

   Подпись дня для диктора называет всё, что видно глазами: занят ли (и какие части), кем
   (отказ «занято», менеджер), есть ли заявка, сегодня ли. На компьютере месяц крупнее,
   легенда — сбоку. */

import type {
  BusyDay,
  BusyPart,
  DayPart,
  VendorCalendar,
  VendorListing,
  VendorListingRef,
} from "@bayramm/shared/api/vendor";
import {
  type AvailabilityMode,
  type CategoryConfig,
  categoryConfig,
  DAY_PARTS,
} from "@bayramm/shared/categories";
import { NumberStepper } from "@bayramm/ui/react";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, api } from "./api";
import { availabilityOf, partName, partWindow } from "./category";
import { formatDate, tashkentToday, weekdayIndex } from "./format";
import { fill, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { ListingPicker } from "./ListingPicker";
import { type Location, type Navigate, pathOf } from "./router";
import { Empty, Heading, LoadError, Loading, type ScreenProps } from "./ui";
import { useLoad } from "./useLoad";

/** "2026-10" ± n месяцев */
export function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 2000, (mon ?? 1) - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

function daysOf(month: string): string[] {
  const [year, mon] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year ?? 2000, mon ?? 1, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/** Подпись дня: дата, занят ли и кем, есть ли заявка, сегодня ли */
export function dayLabel(
  day: string,
  entry: BusyDay | undefined,
  extras: { readonly request: boolean; readonly today: boolean },
  t: VendorDict,
): string {
  const date = formatDate(day, t, true);
  const state = !entry
    ? t.dayFree
    : entry.source === "request_decline"
      ? t.dayBusyDecline
      : entry.source === "staff"
        ? t.dayBusyStaff
        : t.dayBusy;
  const parts = [fill(state, { date })];
  if (extras.request) parts.push(t.legendRequest);
  if (extras.today) parts.push(t.legendToday);
  return parts.join(", ");
}

// ── части дня (модель parts) ────────────────────────────────────────────────

export interface PartInfo {
  readonly part: DayPart;
  /** Отметка части (вендор, отказ «занято», менеджер) */
  readonly mark: BusyPart | undefined;
  /** Договорённостей (заявки deal) на эту часть */
  readonly booked: number;
  /** Места заняты договорённостями: их не меньше, чем заказов одновременно */
  readonly full: boolean;
  /** Часть занята: отметкой, договорённостями или весь день */
  readonly busy: boolean;
}

/** Части дня: что занято, кем и сколько договорённостей */
export function partsOf(calendar: VendorCalendar, day: string): PartInfo[] {
  const dayBusy = calendar.busy.some((b) => b.day === day);
  return DAY_PARTS.map((part) => {
    const mark = calendar.parts.find((p) => p.day === day && p.part === part);
    const booked = calendar.bookings.find((b) => b.day === day && b.part === part)?.count ?? 0;
    const full = booked >= calendar.parallelCapacity;
    return { part, mark, booked, full, busy: dayBusy || mark !== undefined || full };
  });
}

/** Состояние части словами: «занято», «договорённостей: 1 из 2», «свободно» */
function partStateText(info: PartInfo, capacity: number, t: VendorDict): string {
  if (info.busy) return t.partBusy;
  if (info.booked > 0) return fill(t.partBookings, { n: info.booked, cap: capacity });
  return t.partFree;
}

/** Подпись дня режима parts: дата и каждая часть; весь день занят — так и сказано */
export function partsDayLabel(
  calendar: VendorCalendar,
  day: string,
  extras: { readonly request: boolean; readonly today: boolean },
  t: VendorDict,
): string {
  const entry = calendar.busy.find((b) => b.day === day);
  const label = entry
    ? dayLabel(day, entry, { request: false, today: false }, t)
    : `${formatDate(day, t, true)}: ${partsOf(calendar, day)
        .map((info) =>
          fill(t.partState, {
            part: partName(t, info.part),
            state:
              info.mark?.source === "staff"
                ? t.legendStaff
                : partStateText(info, calendar.parallelCapacity, t),
          }),
        )
        .join(", ")}`;
  const parts = [label];
  if (extras.request) parts.push(t.legendRequest);
  if (extras.today) parts.push(t.legendToday);
  return parts.join(", ");
}

// ── месяц ──────────────────────────────────────────────────────────────────

interface MonthProps {
  readonly calendar: VendorCalendar;
  readonly t: VendorDict;
  readonly pending: ReadonlySet<string>;
  /** Режим parts: выбранный день (его части — ниже месяца) */
  readonly selected: string | null;
  readonly onDay: (day: string, busy: BusyDay | undefined) => void;
}

function MonthGrid({ calendar, t, pending, selected, onDay }: MonthProps) {
  const parts = calendar.mode === "parts";
  const busy = new Map(calendar.busy.map((entry) => [entry.day, entry]));
  const requests = new Set(calendar.requestDays);
  const days = daysOf(calendar.month);
  const lead = days[0] ? weekdayIndex(days[0]) : 0;

  return (
    <div className="cal-grid">
      {t.weekdays.map((name, index) => (
        <span key={name} className={`cal-wd${index > 4 ? " cal-we" : ""}`} aria-hidden="true">
          {name}
        </span>
      ))}
      {Array.from({ length: lead }, (_, i) => `pad-${i}`).map((key) => (
        <span key={key} className="cal-pad" aria-hidden="true" />
      ))}
      {days.map((day) => {
        const entry = busy.get(day);
        const past = day < calendar.today;
        const beyond = day > calendar.maxDay;
        const locked = entry?.source === "staff";
        const info = parts ? partsOf(calendar, day) : [];
        const allParts = info.length > 0 && info.every((p) => p.busy);
        const someParts = info.some((p) => p.busy || p.booked > 0);
        const extras = { request: requests.has(day), today: day === calendar.today };
        const classes = [
          "cal-day",
          weekdayIndex(day) > 4 ? "cal-we" : "",
          entry ? `cal-busy cal-${entry.source}` : allParts ? "cal-busy cal-full" : "",
          !entry && !allParts && someParts ? "cal-partial" : "",
          day === calendar.today ? "cal-today" : "",
          requests.has(day) ? "cal-req" : "",
          parts && day === selected ? "cal-selected" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={day}
            type="button"
            className={classes}
            // День целиком — нажата (занят) или нет; у частей дня кнопка выбирает день
            aria-pressed={parts ? day === selected : entry !== undefined}
            aria-label={parts ? partsDayLabel(calendar, day, extras, t) : dayLabel(day, entry, extras, t)}
            aria-current={day === calendar.today ? "date" : undefined}
            aria-disabled={(!parts && locked) || undefined}
            disabled={past || beyond || (!parts && pending.has(day))}
            onClick={() => onDay(day, entry)}
          >
            <span className="cal-num">{Number(day.slice(8))}</span>
            {locked ? <Icon name="lock" size={12} /> : null}
            {parts && !entry ? (
              <span className="cal-parts" aria-hidden="true">
                {info.map((p) => (
                  <i key={p.part} className={p.busy ? "is-busy" : p.booked > 0 ? "is-booked" : undefined} />
                ))}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ── выбранный день (режим parts) ────────────────────────────────────────────

interface DayPanelProps {
  readonly calendar: VendorCalendar;
  readonly category: CategoryConfig | undefined;
  readonly day: string | null;
  readonly t: VendorDict;
  readonly pending: ReadonlySet<string>;
  readonly onToggle: (day: string, part: DayPart | null, entry: BusyDay | BusyPart | undefined) => void;
}

function DayPanel({ calendar, category, day, t, pending, onToggle }: DayPanelProps) {
  if (day === null || !day.startsWith(calendar.month)) {
    return (
      <section className="panel day-panel" aria-label={t.wholeDay}>
        <p className="note">{t.pickDay}</p>
      </section>
    );
  }
  const entry = calendar.busy.find((b) => b.day === day);
  const locked = day < calendar.today || day > calendar.maxDay;
  const control = (
    key: string,
    current: BusyDay | BusyPart | undefined,
    part: DayPart | null,
    label: string,
    blocked: ReactNode,
  ) => {
    if (blocked) return <span className="day-part-note">{blocked}</span>;
    if (current?.source === "staff")
      return (
        <span className="day-part-note">
          <Icon name="lock" size={12} />
          {t.legendStaff}
        </span>
      );
    const free = current !== undefined;
    return (
      <button
        type="button"
        className={free ? "btn btn-ghost" : "btn btn-dark"}
        aria-label={`${free ? t.markFree : t.markBusy}: ${label}`}
        disabled={locked || pending.has(key)}
        onClick={() => onToggle(day, part, current)}
      >
        {free ? t.markFree : t.markBusy}
      </button>
    );
  };

  return (
    <section className="panel day-panel" aria-labelledby="day-panel-title">
      <h2 className="section-title" id="day-panel-title">
        {formatDate(day, t, true)}
      </h2>
      <ul className="day-parts">
        <li className={entry ? "day-part is-busy" : "day-part"}>
          <span className="day-part-name">
            <strong>{t.wholeDay}</strong>
            <span className="day-part-state">{entry ? t.partBusy : t.partFree}</span>
          </span>
          {control(day, entry, null, `${t.wholeDay}, ${formatDate(day, t)}`, null)}
        </li>
        {partsOf(calendar, day).map((info) => {
          const name = partName(t, info.part);
          const blocked = entry ? t.partCovered : !info.mark && info.full ? t.partFull : null;
          return (
            <li key={info.part} className={info.busy ? "day-part is-busy" : "day-part"}>
              <span className="day-part-name">
                <strong>
                  {name} <span className="day-part-window">{partWindow(category, info.part)}</span>
                </strong>
                <span className="day-part-state">
                  {info.mark?.source === "staff"
                    ? t.partBusy
                    : partStateText(info, calendar.parallelCapacity, t)}
                  {info.booked > 0 && info.busy
                    ? ` · ${fill(t.partBookings, { n: info.booked, cap: calendar.parallelCapacity })}`
                    : ""}
                </span>
              </span>
              {control(
                `${day}/${info.part}`,
                info.mark,
                info.part,
                `${name}, ${formatDate(day, t)}`,
                blocked,
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── срок заказа (модель lead) ───────────────────────────────────────────────

function RouteButton({ to, navigate, children }: { to: Location; navigate: Navigate; children: ReactNode }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a className="btn btn-ghost" href={pathOf(to)} onClick={onClick}>
      {children}
    </a>
  );
}

function LeadTime({
  listingId,
  t,
  lang,
  navigate,
}: {
  listingId: string;
  t: VendorDict;
  lang: "ru" | "uz";
  navigate: Navigate;
}) {
  const [listing, reload] = useLoad<VendorListing>(listingId, (id) => api.listing(id));
  if (listing.state === "loading") return <Loading t={t} />;
  if (listing.state === "error") return <LoadError t={t} onRetry={reload} />;
  const leadDays = listing.data.attributes.lead_days;
  const services = listing.data.services.filter(
    (s) => s.leadDays !== null && (s.status === "active" || s.status === "review"),
  );
  return (
    <section className="panel lead-panel" aria-labelledby="lead-title">
      <h2 className="section-title" id="lead-title">
        {t.leadTitle}
      </h2>
      <p className="lead-days">
        <Icon name="clock" size={20} />
        <span>{typeof leadDays === "number" ? fill(t.leadText, { n: leadDays }) : t.leadUnset}</span>
      </p>
      {services.length > 0 ? (
        <>
          <p className="field-label">{t.leadServices}</p>
          <ul className="packages">
            {services.map((service) => (
              <li key={service.id}>
                <span>{service.name[lang] || service.name.ru}</span>
                <strong className="package-price">{fill(t.svcLead, { n: service.leadDays ?? 0 })}</strong>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="note">{t.leadChange}</p>
      <div className="actions">
        <RouteButton to={{ route: "card" }} navigate={navigate}>
          {t.toCard}
        </RouteButton>
        <RouteButton to={{ route: "services" }} navigate={navigate}>
          {t.toServices}
        </RouteButton>
      </div>
    </section>
  );
}

// ── раздел ─────────────────────────────────────────────────────────────────

type Message = "staff" | "failed" | "conflict" | "capacity";

const MESSAGE_TEXT = {
  staff: "staffLocked",
  failed: "calendarSaveFailed",
  conflict: "calendarConflict",
  capacity: "capacityInvalid",
} as const satisfies Readonly<Record<Message, keyof VendorDict>>;

interface CalendarProps extends ScreenProps {
  readonly listings: readonly VendorListingRef[];
  readonly listingId: string | null;
  readonly onListing: (id: string) => void;
  /** Выбор витрины — в боковой панели (компьютер) */
  readonly inSidebar?: boolean;
  readonly navigate: Navigate;
}

/** Отметка дня целиком в загруженном месяце: busy — занят (как ответил сервер), null — свободен */
function withDay(calendar: VendorCalendar, day: string, busy: BusyDay | null): VendorCalendar {
  const rest = calendar.busy.filter((b) => b.day !== day);
  return { ...calendar, busy: busy ? [...rest, busy] : rest };
}

/** Отметка части дня: busy — занята, null — свободна */
function withPart(
  calendar: VendorCalendar,
  day: string,
  part: DayPart,
  busy: BusyPart | null,
): VendorCalendar {
  const rest = calendar.parts.filter((p) => !(p.day === day && p.part === part));
  return { ...calendar, parts: busy ? [...rest, busy] : rest };
}

function withMark(
  calendar: VendorCalendar,
  day: string,
  part: DayPart | null,
  busy: BusyDay | BusyPart | null,
): VendorCalendar {
  return part === null
    ? withDay(calendar, day, busy as BusyDay | null)
    : withPart(calendar, day, part, busy as BusyPart | null);
}

const NOTE: Readonly<Record<AvailabilityMode, "calendarNoteSlot" | "calendarNoteParts" | null>> = {
  day: null,
  slot: "calendarNoteSlot",
  parts: "calendarNoteParts",
  lead: null,
};

export function Calendar({
  t,
  lang,
  headingRef,
  listings,
  listingId,
  onListing,
  inSidebar = false,
  navigate,
}: CalendarProps) {
  const listing = listings.find((l) => l.id === listingId);
  const header = (
    <>
      <Heading headingRef={headingRef}>{t.calendar}</Heading>
      {listing && listingId ? (
        <ListingPicker
          listings={listings}
          value={listingId}
          onChange={onListing}
          t={t}
          lang={lang}
          inSidebar={inSidebar}
        />
      ) : null}
    </>
  );

  if (!listing || !listingId) {
    return (
      <section className="page" aria-labelledby="page-title">
        {header}
        <Empty icon="calendar" title={t.noListings} text={t.noListingsText} />
      </section>
    );
  }

  if (availabilityOf(listing.categoryCode) === "lead") {
    return (
      <section className="page" aria-labelledby="page-title">
        {header}
        <LeadTime key={listingId} listingId={listingId} t={t} lang={lang} navigate={navigate} />
      </section>
    );
  }

  return (
    <section className="page page-calendar" aria-labelledby="page-title">
      {header}
      <CalendarMonth t={t} listing={listing} />
    </section>
  );
}

function CalendarMonth({ t, listing }: { t: VendorDict; listing: VendorListingRef }) {
  const listingId = listing.id;
  const category = categoryConfig(listing.categoryCode);
  const [month, setMonth] = useState(() => tashkentToday().slice(0, 7));
  const key = `${listingId}/${month}`;
  const [calendar, reload, setCalendar, refresh] = useLoad<VendorCalendar>(key, (k) => {
    const [id = "", m = ""] = k.split("/");
    return api.calendar(id, m);
  });
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<Message | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [capacity, setCapacity] = useState<string | null>(null);
  // Правки уходят по одной, каждая — от последней известной версии календаря площадки:
  // две правки от одной версии вторая не прошла бы (409), хотя чужих изменений не было
  const queue = useRef<Promise<void>>(Promise.resolve());
  const known = useRef<{ listingId: string; version: number } | null>(null);
  // Растёт, когда календарь перечитан из-за чужой правки: ждущие очереди правки не уходят
  const round = useRef(0);

  // Версия только растёт: ответ чтения, начатого до правки, не откатывает её назад
  const remember = useCallback((listing: string, version: number) => {
    const current = known.current;
    if (current?.listingId === listing && current.version >= version) return;
    known.current = { listingId: listing, version };
  }, []);
  useEffect(() => {
    if (calendar.state === "ready") remember(calendar.data.listingId, calendar.data.version);
  }, [calendar, remember]);
  // Другая витрина — выбранный день и черновик числа заказов не переносятся
  // biome-ignore lint/correctness/useExhaustiveDependencies: сброс — по смене витрины
  useEffect(() => {
    setSelected(null);
    setCapacity(null);
    setMessage(null);
  }, [listingId]);

  const mark = (id: string, on: boolean) =>
    setPending((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  // День — в том месяце той площадки, что на экране; иначе правка его не касается
  const onScreen = (current: VendorCalendar, listing: string, day: string) =>
    current.listingId === listing && day.startsWith(current.month);

  /** Версия для правки: нет — правка не уходит (так не бывает: календарь уже загружен) */
  const versionOf = (listing: string) => {
    const version = known.current?.listingId === listing ? known.current.version : null;
    if (version === null) throw new Error("calendar version is unknown");
    return version;
  };

  /** Чужая правка (409) или день закрыл менеджер: показать календарь как в базе */
  const conflicted = async (err: unknown): Promise<boolean> => {
    const conflict = err instanceof ApiFailure && err.code === "calendar_conflict";
    const locked = err instanceof ApiFailure && err.code === "forbidden_for_actor";
    if (!conflict && !locked) return false;
    round.current += 1;
    setMessage(conflict ? "conflict" : "staff");
    if (!(await refresh())) reload();
    return true;
  };

  const save = async (
    listing: string,
    day: string,
    part: DayPart | null,
    entry: BusyDay | BusyPart | undefined,
    asked: number,
  ) => {
    const id = part === null ? day : `${day}/${part}`;
    try {
      // Пока правка ждала очереди, календарь перечитали из-за чужой правки: на экране уже
      // то, что в базе, — человек проверит и отметит заново
      if (round.current !== asked) return;
      const version = versionOf(listing);
      const change = entry
        ? await api.markFree(listing, day, version, part)
        : await api.markBusy(listing, day, version, part);
      remember(listing, change.version);
      setCalendar((current) => {
        if (current.listingId !== listing) return current;
        const next = onScreen(current, listing, day) ? withMark(current, day, part, change.busy) : current;
        return { ...next, version: Math.max(current.version, change.version) };
      });
    } catch (err) {
      if (!(await conflicted(err))) {
        setMessage("failed");
        setCalendar((current) =>
          onScreen(current, listing, day) ? withMark(current, day, part, entry ?? null) : current,
        );
      }
    } finally {
      mark(id, false);
    }
  };

  const toggle = (day: string, part: DayPart | null, entry: BusyDay | BusyPart | undefined) => {
    if (entry?.source === "staff") {
      setMessage("staff");
      return;
    }
    setMessage(null);
    mark(part === null ? day : `${day}/${part}`, true);
    // Сразу на экране; не сохранилось — вернём как было
    const optimistic: BusyDay | BusyPart | null = entry
      ? null
      : part === null
        ? { day, source: "vendor", requestId: null }
        : { day, part, source: "vendor", requestId: null };
    setCalendar((current) => withMark(current, day, part, optimistic));
    const asked = round.current;
    queue.current = queue.current.then(() => save(listingId, day, part, entry, asked));
  };

  const saveCapacity = (value: number) => {
    if (!Number.isInteger(value) || value < 1 || value > 50) {
      setMessage("capacity");
      return;
    }
    setMessage(null);
    mark("capacity", true);
    const asked = round.current;
    queue.current = queue.current.then(async () => {
      try {
        if (round.current !== asked) return;
        const change = await api.setCapacity(listingId, value, versionOf(listingId));
        remember(listingId, change.version);
        setCapacity(null);
        setCalendar((current) =>
          current.listingId === listingId
            ? {
                ...current,
                parallelCapacity: change.parallelCapacity,
                version: Math.max(current.version, change.version),
              }
            : current,
        );
      } catch (err) {
        // Календарь изменили — на экране число из базы: человек проверит и поправит заново
        if (await conflicted(err)) setCapacity(null);
        else setMessage("failed");
      } finally {
        mark("capacity", false);
      }
    });
  };

  const [year, mon] = month.split("-");
  const monthName = t.months[Number(mon) - 1] ?? "";
  const ready = calendar.state === "ready" ? calendar.data : null;
  const mode: AvailabilityMode = ready?.mode ?? availabilityOf(listing.categoryCode);
  const parts = mode === "parts";
  const canPrev = ready ? month > ready.today.slice(0, 7) : false;
  const canNext = ready ? month < ready.maxDay.slice(0, 7) : false;
  const note = NOTE[mode];
  const capacityValue = capacity ?? String(ready?.parallelCapacity ?? 1);
  const capacityChanged = ready !== null && capacityValue !== String(ready.parallelCapacity);

  return (
    <>
      <p className="lead">
        {t.calendarNote}
        {note ? ` ${t[note]}` : ""}
      </p>
      <div className="cal-layout">
        <div className="cal-main">
          <div className="cal">
            <div className="cal-head">
              <p className="cal-month" aria-live="polite">
                {monthName} <span>{year}</span>
              </p>
              <div className="cal-nav">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t.prevMonth}
                  disabled={!canPrev}
                  onClick={() => setMonth((m) => shiftMonth(m, -1))}
                >
                  <Icon name="prev" size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t.nextMonth}
                  disabled={!canNext}
                  onClick={() => setMonth((m) => shiftMonth(m, 1))}
                >
                  <Icon name="next" size={14} />
                </button>
              </div>
            </div>
            {calendar.state === "loading" ? <Loading t={t} /> : null}
            {calendar.state === "error" ? <LoadError t={t} onRetry={reload} /> : null}
            {ready ? (
              <MonthGrid
                calendar={ready}
                t={t}
                pending={pending}
                selected={selected}
                onDay={(day, entry) => (parts ? setSelected(day) : toggle(day, null, entry))}
              />
            ) : null}
            {/* Сообщение — у самого месяца: на компьютере легенда сбоку, низ страницы далеко */}
            {message ? (
              <p className={message === "failed" ? "form-error" : "notice"} role="alert">
                {t[MESSAGE_TEXT[message]]}
              </p>
            ) : null}
          </div>
          {ready && parts ? (
            <DayPanel
              calendar={ready}
              category={category}
              day={selected}
              t={t}
              pending={pending}
              onToggle={toggle}
            />
          ) : null}
        </div>
        <aside className="cal-aside" aria-labelledby="legend-title">
          {ready && parts ? (
            <div className="capacity">
              <label className="panel-title" htmlFor="capacity-input">
                {t.capacityTitle}
              </label>
              <p className="note" id="capacity-hint">
                {t.capacityLead}
              </p>
              <div className="capacity-row">
                <NumberStepper
                  id="capacity-input"
                  value={capacityValue}
                  min={1}
                  max={50}
                  maxLength={2}
                  onChange={setCapacity}
                  decrementLabel={`${t.capacityTitle}: ${t.capacityLess}`}
                  incrementLabel={`${t.capacityTitle}: ${t.capacityMore}`}
                  aria-describedby="capacity-hint"
                />
                <button
                  type="button"
                  className="btn btn-dark"
                  disabled={!capacityChanged || pending.has("capacity")}
                  onClick={() => saveCapacity(Number(capacityValue))}
                >
                  {t.serviceSave}
                </button>
              </div>
            </div>
          ) : null}
          <h2 className="panel-title" id="legend-title">
            {t.legendTitle}
          </h2>
          <ul className="cal-legend">
            <li>
              <span className="dot dot-busy" />
              {t.legendBusy}
            </li>
            {parts ? (
              <li>
                <span className="dot dot-part" />
                {t.legendPart}
              </li>
            ) : null}
            <li>
              <span className="dot dot-decline" />
              {t.legendDecline}
            </li>
            <li>
              <span className="dot dot-staff" />
              {t.legendStaff}
            </li>
            <li>
              <span className="dot dot-req" />
              {t.legendRequest}
            </li>
            <li>
              <span className="dot dot-today" />
              {t.legendToday}
            </li>
          </ul>
          <p className="note">
            {parts ? t.calendarHintParts : t.calendarHint} {t.tz}
          </p>
        </aside>
      </div>
    </>
  );
}
