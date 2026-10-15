/* Занятость витрины. У категорий с календарём день делится на утро, день и вечер; как витрина
   работает — «Время работы» (WorkingTimes.tsx, блок рядом): одно мероприятие в день или
   несколько, в своих частях, со своими окнами и числом заказов одновременно. У срока заказа
   (цветы, торты, подарки) календаря нет — LeadTime.
     · месяц сеткой, неделя с понедельника; у дня — три маленькие отметки рабочих частей
       (свободна, есть договорённость, занята), весь день занят — заливка; сегодня — точка в углу
       (кольцо — у фокуса);
     · нажатие на день открывает его под сеткой: «Весь день» (занять или освободить целиком) и
       рабочие части — окно, «занято N из M мест», заявки на эту часть (ссылки) и «Закрыть» /
       «Открыть». Часть занята, когда отмечена или мест не осталось; у одного мероприятия в день
       частей нет — только день целиком;
     · «Несколько дней»: первое нажатие — начало, второе — конец (пальцем, без перетаскивания,
       можно и через месяц), дни недели — только эти, что — весь день или часть; затем «Занять»
       или «Освободить» — одной правкой. «Освободить» больше одного дня — через подтверждение со
       счётом: сколько дней выбрано, сколько из них занято и сколько отметил сам вендор (до 400
       отметок одним нажатием).
   Объяснений над сеткой нет: нажатие на день и «Несколько дней» говорят сами, подсказка — только
   тому, кто дни не меняет. Прошедшие дни не меняются. «Сегодня» — по Ташкенту. Календарь ведут и
   вендор, и команда: правка уходит с версией календаря из последнего ответа. Его успели
   изменить — сервер отвечает calendar_conflict: месяц перечитывается, сотрудник отмечает ещё раз.
   Правки идут по одной — дни неактивны, пока не пришёл ответ.
   Месяц листают стрелками, «Сегодня» возвращает к текущему; пока новый месяц грузится, дни
   прежнего на экране неактивны — отметка не уйдёт в чужой месяц.
   Клетка дня — вся дорожка сетки, не меньше 44px: на 320px месяц выходит на 10px за поля
   страницы и семь дорожек по 44px помещаются без прокрутки вбок. */

import type {
  Availability,
  AvailabilityInput,
  BusyDay,
  BusyPart,
  CalendarRequest,
  DayPart,
  ListingDetail,
} from "@bayramm/shared/api/staff";
import {
  type CategoryConfig,
  DAY_PARTS,
  type DayLoad,
  type DayMarks,
  DEFAULT_DAY_PARTS,
  dayLoadOf,
  type PartLoad,
  partLoads,
  readAttributes,
  windowText,
} from "@bayramm/shared/categories";
import { ConfirmSheet, Tooltip, UiIcon } from "@bayramm/ui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Failure, useCan, useLoad, useSession } from "../api";
import { usePhone } from "../layout";
import { apiErrorText, t } from "../texts";
import { ErrorText, Link, LoadedView } from "../ui";

const DAY_MS = 86_400_000;

/** «Сегодня» по Ташкенту (UTC+5 круглый год) */
export function tashkentToday(now = new Date()): string {
  return new Date(now.getTime() + 5 * 3600_000).toISOString().slice(0, 10);
}

/** Дни месяца «YYYY-MM» и сколько пустых клеток перед первым (неделя с понедельника) */
export function monthGrid(month: string): { days: string[]; offset: number } {
  const first = new Date(`${month}-01T00:00:00Z`);
  const days: string[] = [];
  for (let d = first.getTime(); new Date(d).getUTCMonth() === first.getUTCMonth(); d += DAY_MS) {
    days.push(new Date(d).toISOString().slice(0, 10));
  }
  return { days, offset: (first.getUTCDay() + 6) % 7 };
}

export function shiftMonth(month: string, delta: number): string {
  const [year = 0, mon = 1] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, mon - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

const monthFormat = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });

/** «Сентябрь 2026» — без «г.» и с заглавной */
export function monthTitle(month: string): string {
  const text = monthFormat.format(new Date(`${month}-01T00:00:00Z`)).replace(/\s*г\.?$/, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
const dayTitle = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
const dayName = (day: string) => dayTitle.format(new Date(`${day}T00:00:00Z`));

/** 0 — понедельник … 6 — воскресенье */
const weekdayOf = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

/** Не больше, чем сервер примет одной правкой */
const MAX_RANGE = 400;

/**
 * Дни выбора «несколько дней» по порядку, от раннего к позднему (концы можно выбрать в любом
 * порядке); прошедшие до today — не входят; weekdays — только эти дни недели (пусто — все)
 */
export function rangeDays(
  a: string,
  b: string,
  today: string,
  weekdays: ReadonlySet<number> = new Set(),
): string[] {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const days: string[] = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); days.length < MAX_RANGE; d += DAY_MS) {
    const day = new Date(d).toISOString().slice(0, 10);
    if (day > to) break;
    if (day >= today && (weekdays.size === 0 || weekdays.has(weekdayOf(day)))) days.push(day);
  }
  return days;
}

/**
 * Вливает ответ правки (занятые дни, части дня и договорённости на его отрезке) в показанный
 * месяц: вне отрезка ответа — как было, на отрезке — как ответил сервер (дни за краем месяца
 * сетка просто не показывает)
 */
export function mergeBusy(current: Availability, result: Availability): Availability {
  const outside = (item: { day: string }) => item.day < result.from || item.day > result.to;
  const byDay = (a: { day: string }, b: { day: string }) => a.day.localeCompare(b.day);
  return {
    ...current,
    busy: [...current.busy.filter(outside), ...result.busy].sort(byDay),
    parts: [...current.parts.filter(outside), ...result.parts].sort(byDay),
    bookings: [...current.bookings.filter(outside), ...result.bookings].sort(byDay),
    requests: [...(current.requests ?? []).filter(outside), ...(result.requests ?? [])].sort(byDay),
    sessions: result.sessions ?? current.sessions,
    parallelCapacity: result.parallelCapacity,
    version: result.version,
  };
}

/**
 * Ответ сервера без времени работы и заявок дня (старый API во время выкладки) — как у витрины
 * по умолчанию: несколько мероприятий, все части, окна по умолчанию
 */
export function withDefaults(availability: Availability): Availability {
  return {
    ...availability,
    sessions: availability.sessions ?? {
      mode: "parts",
      parts: [...DAY_PARTS],
      windows: DEFAULT_DAY_PARTS,
      custom: null,
      parallelCapacity: availability.parallelCapacity ?? 1,
    },
    requests: availability.requests ?? [],
    parts: availability.parts ?? [],
    bookings: availability.bookings ?? [],
  };
}

/** Часть дня глазами календаря: отмечена ли, сколько договорённостей, занята ли */
export interface PartState extends PartLoad {
  readonly mark: BusyPart | undefined;
  readonly requests: readonly CalendarRequest[];
}

export type { DayLoad };

/** День: отметка целиком, рабочие части (у одного мероприятия в день — нет) и загрузка */
export function dayState(
  availability: Availability,
  day: string,
): { entry: BusyDay | undefined; parts: PartState[]; load: DayLoad; requests: CalendarRequest[] } {
  const booked: Partial<Record<DayPart, number>> = {};
  for (const b of availability.bookings) if (b.day === day) booked[b.part] = b.count;
  const marks: DayMarks = {
    whole: availability.busy.some((b) => b.day === day),
    marked: availability.parts.filter((p) => p.day === day).map((p) => p.part),
    booked,
  };
  const { sessions } = availability;
  const requests = availability.requests.filter((r) => r.day === day);
  const parts =
    sessions.mode === "whole"
      ? []
      : partLoads(sessions, marks)
          .filter((p) => sessions.parts.includes(p.part))
          .map((p) => ({
            ...p,
            mark: availability.parts.find((m) => m.day === day && m.part === p.part),
            requests: requests.filter((r) => r.parts.includes(p.part)),
          }));
  return {
    entry: availability.busy.find((b) => b.day === day),
    parts,
    load: dayLoadOf(sessions, marks),
    requests,
  };
}

type Range = { readonly start: string; readonly end: string | null };

/** Что закрыть или открыть на нескольких днях: весь день или часть */
export type RangeWhat = "whole" | DayPart;

/** Что снимет «Освободить»: выбрано дней, из них занято (отмечено) и отмечено вендором */
export interface FreeCount {
  readonly days: number;
  /** null — не узнали (нет связи): подтверждение говорит только число дней */
  readonly marked: number | null;
  readonly byVendor: number | null;
}

/** Счёт для подтверждения по отметкам отрезка: дня целиком или выбранной части */
export function freeCount(
  days: readonly string[],
  availability: Pick<Availability, "busy" | "parts">,
  what: RangeWhat = "whole",
): FreeCount {
  const chosen = new Set(days);
  const marked =
    what === "whole"
      ? availability.busy.filter((b) => chosen.has(b.day))
      : availability.parts.filter((p) => p.part === what && chosen.has(p.day));
  return {
    days: days.length,
    marked: marked.length,
    byVendor: marked.filter((b) => b.source === "vendor").length,
  };
}

/** Правка нескольких дней: весь день — busy/free, часть — busyParts/freeParts */
export function rangeInput(
  version: number,
  days: readonly string[],
  what: RangeWhat,
  mark: "busy" | "free",
): AvailabilityInput {
  if (what === "whole") return { version, [mark]: days };
  const refs = days.map((day) => ({ day, part: what }));
  return mark === "busy" ? { version, busyParts: refs } : { version, freeParts: refs };
}

/** Состояние части словами: отмечена (кем), занята местами, «занято N из M мест», свободна */
function partWord(state: PartState, capacity: number, whole: boolean): string {
  if (whole) return t.partState.covered ?? t.partState.busy ?? "";
  if (state.mark) return t.partState.busy ?? "";
  if (state.booked > 0) return t.partSeats(state.booked, capacity);
  return t.partState.free ?? "";
}

function RequestLinks({ requests }: { requests: readonly CalendarRequest[] }) {
  if (requests.length === 0) return null;
  return (
    <ul className="day-requests">
      {requests.map((r) => (
        <li key={r.id}>
          <Link to={{ name: "request", id: r.id }} className="day-request">
            {t.dayRequest(r.publicNo, t.requestStatus[r.status] ?? r.status)}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Calendar({
  listingId,
  revision,
  headerExtra,
  onVersion,
}: {
  listingId: string;
  category: CategoryConfig;
  /** Версия календаря из витрины: время работы сохранили — месяц перечитывается */
  revision?: number;
  /** Справа в шапке блока */
  headerExtra?: ReactNode;
  /** Версия календаря из последнего ответа: «Время работы» сохраняет от неё */
  onVersion?: (version: number) => void;
}) {
  const { api } = useSession();
  const can = useCan();
  const today = tashkentToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const { days, offset } = monthGrid(month);
  const from = days[0] ?? today;
  const to = days.at(-1) ?? today;
  const path = `/staff/listings/${listingId}/availability?from=${from}&to=${to}`;
  const { loaded, reload, set } = useLoad<Availability>(path);
  // Ответ, пришедший после перехода на другой месяц, в новый месяц не вливаем
  const shown = useRef(path);
  shown.current = path;
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // Выбор нескольких дней: null — обычный режим (нажатие открывает день)
  const [ranging, setRanging] = useState(false);
  const [range, setRange] = useState<Range | null>(null);
  const [weekdays, setWeekdays] = useState<ReadonlySet<number>>(new Set());
  const [what, setWhat] = useState<RangeWhat>("whole");
  // Открытый день — его части под сеткой
  const [opened, setOpened] = useState<string | null>(null);
  // На телефоне части дня — под месяцем, у нижних панелей: открыли день — прокрутить к ним
  // (scrollIntoView есть не везде — ловушка №5; запас под панелями — scroll-margin в styles.css)
  const dayParts = useRef<HTMLElement>(null);
  const phone = usePhone();
  useEffect(() => {
    if (!opened || !phone) return;
    const frame = requestAnimationFrame(() => dayParts.current?.scrollIntoView?.({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [opened, phone]);
  // «Освободить» несколько дней — подтверждение со счётом
  const [freeing, setFreeing] = useState<FreeCount | null>(null);
  // Листнули месяц: на экране — прежний ответ, пока не пришёл новый (useLoad его не стирает)
  const [waiting, setWaiting] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: loaded — повод: пришёл ответ нового месяца
  useEffect(() => setWaiting(false), [loaded]);
  const editable = can("listings.write");
  const selected = range ? rangeDays(range.start, range.end ?? range.start, today, weekdays) : [];
  const seen = loaded.state === "ready" ? loaded.data.version : null;
  useEffect(() => {
    if (seen !== null) onVersion?.(seen);
  }, [seen, onVersion]);
  // Время работы сохранили — части дня и занятость считаются по-новому
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (lastRevision.current === revision) return;
    lastRevision.current = revision;
    reload();
  }, [revision, reload]);

  // Сообщение об ошибке — про месяц, где отмечали: в другом месяце оно только путает
  const goMonth = (delta: number) => {
    setFailure(null);
    setOpened(null);
    setWaiting(true);
    setMonth(shiftMonth(month, delta));
  };
  const goToday = () => {
    setFailure(null);
    setOpened(null);
    setWaiting(true);
    setMonth(today.slice(0, 7));
  };

  const send = async (key: string, input: AvailabilityInput, current: Availability) => {
    const at = path;
    setPending(key);
    setFailure(null);
    const result = await api.put<Availability>(`/staff/listings/${listingId}/availability`, input);
    if (result.ok && shown.current === at) {
      // Ответ — только про изменённые дни и новая версия: вливаем в месяц
      set(mergeBusy(current, result.data));
    } else if (!result.ok && shown.current === at) {
      setFailure(result);
      // Календарь изменили: показываем актуальный месяц, дни неактивны, пока он не пришёл
      if (result.code === "calendar_conflict") {
        const fresh = await api.get<Availability>(at);
        if (!fresh.ok) reload();
        else if (shown.current === at) set(fresh.data);
      }
    }
    setPending(null);
    return result.ok;
  };

  const toggle = (day: string, busy: BusyDay | undefined, current: Availability) =>
    void send(
      day,
      busy ? { version: current.version, free: [day] } : { version: current.version, busy: [day] },
      current,
    );

  const togglePart = (day: string, state: PartState, current: Availability) =>
    void send(
      `${day}:${state.part}`,
      state.mark
        ? { version: current.version, freeParts: [{ day, part: state.part }] }
        : { version: current.version, busyParts: [{ day, part: state.part }] },
      current,
    );

  const pick = (day: string) => {
    // Первое нажатие — начало; второе — конец; третье — новый выбор
    if (!range || range.end !== null) setRange({ start: day, end: null });
    else setRange({ start: range.start, end: day });
  };

  const applyRange = async (mark: "busy" | "free", current: Availability) => {
    if (selected.length === 0) return;
    const ok = await send("range", rangeInput(current.version, selected, what, mark), current);
    if (ok) {
      setRange(null);
      setRanging(false);
      setFreeing(null);
    }
  };

  // Освободить больше одного дня — сначала счёт: сколько занято и сколько отметил вендор. Дни
  // за краем показанного месяца — одним запросом отрезка (сервер отдаёт до 400 дней)
  const askFree = async (current: Availability) => {
    const first = selected[0];
    const last = selected.at(-1);
    if (first === undefined || last === undefined) return;
    // Прежняя ошибка — не про этот выбор: в подтверждении её не показываем
    setFailure(null);
    if (selected.length === 1) {
      void applyRange("free", current);
      return;
    }
    if (first >= current.from && last <= current.to) {
      setFreeing(freeCount(selected, current, what));
      return;
    }
    setPending("count");
    const result = await api.get<Availability>(
      `/staff/listings/${listingId}/availability?from=${first}&to=${last}`,
    );
    setPending(null);
    setFreeing(
      result.ok
        ? freeCount(selected, result.data, what)
        : { days: selected.length, marked: null, byVendor: null },
    );
  };

  const toggleRanging = () => {
    setRanging(!ranging);
    setRange(null);
    setWeekdays(new Set());
    setWhat("whole");
    setOpened(null);
    setFailure(null);
  };
  const toggleWeekday = (index: number) =>
    setWeekdays((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <section className="panel cal-panel" aria-labelledby="calendar-title">
      <div className="panel-head">
        <h2 id="calendar-title">{t.availability}</h2>
        {headerExtra}
      </div>
      {/* Без права правки дни неактивны — об этом, и только об этом, строка */}
      {editable ? null : <p className="muted small">{t.availabilityReadOnly}</p>}
      <div className="cal-head">
        <button type="button" className="ui-icon-btn" onClick={() => goMonth(-1)} aria-label={t.prevMonth}>
          <UiIcon name="prev" size={17} />
        </button>
        <p className="cal-title" aria-live="polite">
          {monthTitle(month)}
        </p>
        {month === today.slice(0, 7) ? null : (
          <button type="button" className="btn btn-sm" onClick={goToday}>
            {t.calToday}
          </button>
        )}
        <button type="button" className="ui-icon-btn" onClick={() => goMonth(1)} aria-label={t.nextMonth}>
          <UiIcon name="next" size={17} />
        </button>
      </div>
      {editable && (
        <div className="cal-tools">
          <button type="button" className="chip" aria-pressed={ranging} onClick={toggleRanging}>
            {t.rangeMode}
          </button>
          {ranging && (
            <p className="muted small" aria-live="polite">
              {range === null
                ? t.rangePickStart
                : range.end === null
                  ? t.rangePickEnd
                  : t.rangeChosen(selected.length)}
            </p>
          )}
        </div>
      )}
      <LoadedView loaded={loaded} onRetry={reload} skeleton="block">
        {(loadedAvailability) => {
          const availability = withDefaults(loadedAvailability);
          // Новый месяц ещё грузится, на экране — прежний ответ: дни неактивны, отметки не видны
          const stale = waiting;
          const inRange = new Set(selected);
          const openedState = opened && !stale ? dayState(availability, opened) : null;
          const capacity = availability.sessions.parallelCapacity;
          const rangeParts = availability.sessions.mode === "whole" ? [] : availability.sessions.parts;
          return (
            <>
              {stale ? (
                <p className="visually-hidden" role="status">
                  {t.calLoading}
                </p>
              ) : null}
              <div className="cal" aria-busy={stale || undefined}>
                {t.weekdays.map((name, index) => (
                  <span key={name} className={index > 4 ? "cal-wd cal-we" : "cal-wd"} aria-hidden="true">
                    {name}
                  </span>
                ))}
                {Array.from({ length: offset }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: пустые клетки перед первым числом
                  <span key={`pad-${i}`} className="cal-pad" aria-hidden="true" />
                ))}
                {days.map((day) => {
                  const state = stale ? null : dayState(availability, day);
                  const past = day < today;
                  const chosen = inRange.has(day);
                  const load: DayLoad = state?.load ?? "free";
                  const status = load === "free" ? "" : ` — ${t.dayLoad[load]}`;
                  const label = `${dayName(day)}${status}${day === today ? `, ${t.legendToday}` : ""}${chosen ? `, ${t.rangeInside}` : ""}`;
                  // Подсказка под мышью повторяет aria-label: диктору её не дублируем
                  return (
                    <Tooltip key={day} text={label} describe={false}>
                      {(tip) => (
                        <button
                          {...tip}
                          type="button"
                          className={`cal-day${weekdayOf(day) > 4 ? " cal-we" : ""}${load === "busy" ? " cal-busy" : load === "partial" ? " cal-partial" : ""}${day === today ? " cal-today" : ""}${chosen ? " cal-chosen" : ""}${!ranging && opened === day ? " cal-open" : ""}`}
                          aria-pressed={ranging ? chosen : opened === day}
                          aria-label={label}
                          disabled={!editable || past || pending !== null || stale}
                          onClick={() => (ranging ? pick(day) : setOpened(opened === day ? null : day))}
                        >
                          {day === today ? <span className="cal-today-dot" aria-hidden="true" /> : null}
                          {Number(day.slice(8))}
                          {state && state.parts.length > 0 ? (
                            <span className="cal-parts" aria-hidden="true">
                              {state.parts.map((p) => (
                                <i
                                  key={p.part}
                                  className={p.busy ? "is-busy" : p.booked > 0 ? "is-booked" : undefined}
                                />
                              ))}
                            </span>
                          ) : null}
                        </button>
                      )}
                    </Tooltip>
                  );
                })}
              </div>
              <ul className="cal-legend" aria-label={t.legend}>
                <li>
                  <span className="cal-key cal-key-free" aria-hidden="true" />
                  {t.legendFree}
                </li>
                <li>
                  <span className="cal-key cal-key-partial" aria-hidden="true" />
                  {t.legendPartial}
                </li>
                <li>
                  <span className="cal-key cal-key-busy" aria-hidden="true" />
                  {t.legendBusy}
                </li>
                <li>
                  <span className="cal-key cal-key-today" aria-hidden="true" />
                  {t.legendToday}
                </li>
                {ranging && (
                  <li>
                    <span className="cal-key cal-key-chosen" aria-hidden="true" />
                    {t.legendChosen}
                  </li>
                )}
              </ul>
              {opened && openedState ? (
                <section ref={dayParts} className="day-parts" aria-label={t.pickedDay(dayName(opened))}>
                  <p className="day-parts-title">{t.pickedDay(dayName(opened))}</p>
                  <div className="day-part-row">
                    <span className="day-part-name">
                      {t.wholeDay}
                      <span className="sub">
                        {openedState.entry
                          ? `${t.partState.busy} · ${t.busySources[openedState.entry.source] ?? ""}`
                          : openedState.load === "partial" || openedState.parts.some((p) => p.booked > 0)
                            ? t.wholePartial
                            : (t.partState[openedState.load === "busy" ? "busy" : "free"] ?? "")}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={pending !== null}
                      onClick={() => toggle(opened, openedState.entry, availability)}
                    >
                      {openedState.entry ? t.openWholeDay : t.closeWholeDay}
                    </button>
                    <RequestLinks
                      requests={openedState.requests.filter(
                        (r) => r.parts.length === 0 || openedState.parts.length === 0,
                      )}
                    />
                  </div>
                  {openedState.parts.map((state) => {
                    const name = t.dayParts[state.part] ?? state.part;
                    const whole = openedState.entry !== undefined;
                    return (
                      <div key={state.part} className="day-part-row">
                        <span className="day-part-name">
                          {name}{" "}
                          <span className="sub">{windowText(availability.sessions.windows[state.part])}</span>
                          <span className="sub">{partWord(state, capacity, whole)}</span>
                        </span>
                        {/* Подпись меняется («Закрыть» / «Открыть») — aria-pressed не нужен; часть — в имени */}
                        <button
                          type="button"
                          className="btn btn-sm"
                          aria-label={`${state.mark ? t.openPart : t.closePart}: ${name}`}
                          disabled={pending !== null || whole || (state.full && !state.mark)}
                          onClick={() => togglePart(opened, state, availability)}
                        >
                          {state.mark ? t.openPart : t.closePart}
                        </button>
                        <RequestLinks requests={state.requests} />
                      </div>
                    );
                  })}
                </section>
              ) : null}
              {ranging ? (
                <div className="cal-range">
                  <fieldset className="cal-range-group">
                    <legend>{t.rangeWeekdays}</legend>
                    <div className="chips">
                      {t.weekdays.map((name, index) => (
                        <button
                          key={name}
                          type="button"
                          className="chip"
                          aria-pressed={weekdays.has(index)}
                          aria-label={t.weekdaysLong[index] ?? name}
                          onClick={() => toggleWeekday(index)}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  {rangeParts.length > 0 ? (
                    <fieldset className="cal-range-group">
                      <legend>{t.rangeWhat}</legend>
                      <div className="chips">
                        {(["whole", ...rangeParts] as const).map((value) => (
                          <button
                            key={value}
                            type="button"
                            className="chip"
                            aria-pressed={what === value}
                            onClick={() => setWhat(value)}
                          >
                            {value === "whole" ? t.wholeDay : (t.dayParts[value] ?? value)}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  ) : null}
                </div>
              ) : null}
              {ranging && selected.length > 0 && range?.end !== null && (
                <div className="acts cal-range-acts">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={pending !== null || stale}
                    onClick={() => void applyRange("busy", availability)}
                  >
                    {t.rangeBusy(selected.length)}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={pending !== null || stale}
                    onClick={() => void askFree(availability)}
                  >
                    {t.rangeFree}
                  </button>
                  <button type="button" className="btn" onClick={() => setRange(null)}>
                    {t.cancel}
                  </button>
                </div>
              )}
              <ConfirmSheet
                open={freeing !== null}
                title={t.rangeFreeTitle}
                text={freeing ? t.rangeFreeText(freeing.days, freeing.marked, freeing.byVendor) : undefined}
                confirmLabel={t.rangeFreeConfirm(freeing?.days ?? 0)}
                cancelLabel={t.cancel}
                tone="danger"
                busy={pending !== null}
                error={freeing && failure ? apiErrorText(failure.code) : undefined}
                onConfirm={() => void applyRange("free", availability)}
                onCancel={() => setFreeing(null)}
              />
            </>
          );
        }}
      </LoadedView>
      {failure && <ErrorText failure={failure} />}
    </section>
  );
}

/** Режим lead (цветы, торты, подарки): календаря нет — срок заказа витрины и услуг */
export function LeadTime({ listing, category }: { listing: ListingDetail; category: CategoryConfig }) {
  const attributes = readAttributes(category, listing.attributes);
  const days = typeof attributes.lead_days === "number" ? attributes.lead_days : null;
  const services = listing.services.filter((s) => s.leadDays !== null && s.status !== "rejected");
  return (
    <section className="panel" aria-labelledby="lead-title">
      <h2 id="lead-title">{t.leadTitle}</h2>
      <p className={days === null ? "notice notice-warn" : "lead-days"}>
        {days === null ? t.leadNotSet : t.leadDaysValue(days)}
      </p>
      {services.length > 0 ? (
        <p className="sub">
          {t.leadServices(services.map((s) => `${s.name.ru} — ${s.leadDays} ${t.daysShort}`).join("; "))}
        </p>
      ) : null}
    </section>
  );
}
