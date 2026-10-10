/* Занятость витрины — по режиму её категории (@bayramm/shared/categories):
     · day   — месяц сеткой, неделя с понедельника; нажатие на день отмечает его занятым
               или снимает отметку (площадка);
     · parts — день делится на утро, день и вечер (кортеж, фото и видео, декор): нажатие
               открывает день — отметить его целиком или по частям; у части видно, сколько
               договорённостей из «заказов одновременно» витрины. Часть занята, когда
               отмечена или мест не осталось; день — когда занят целиком или все части;
     · slot  — как day (студия): время и часы съёмки приходят в заявке;
     · lead  — календаря нет (цветы, торты, подарки): срок заказа — LeadTime.
   Прошедшие дни не меняются. «Сегодня» — по Ташкенту. Календарь ведут и вендор, и команда:
   правка уходит с версией календаря из последнего ответа. Его успели изменить — сервер
   отвечает calendar_conflict: месяц перечитывается, сотрудник отмечает ещё раз. Правки идут
   по одной — дни неактивны, пока не пришёл ответ.
   «Несколько дней»: первое нажатие — начало, второе — конец (пальцем, без перетаскивания,
   можно и через месяц), затем «Занять» или «Освободить» — одной правкой, днями целиком.
   «Освободить» больше одного дня — через подтверждение со счётом: сколько дней выбрано,
   сколько из них занято и сколько отметил сам вендор (до 400 дней одним нажатием).
   Месяц листают стрелками, «Сегодня» возвращает к текущему; пока новый месяц грузится, дни
   прежнего на экране неактивны — отметка не уйдёт в чужой месяц.
   Клетка дня — вся дорожка сетки, не меньше 44px: на 320px месяц выходит на 10px за поля
   страницы и семь дорожек по 44px помещаются без прокрутки вбок. */

import type {
  Availability,
  AvailabilityInput,
  BusyDay,
  BusyPart,
  DayPart,
  ListingDetail,
} from "@bayramm/shared/api/staff";
import { type CategoryConfig, DAY_PARTS, readAttributes } from "@bayramm/shared/categories";
import { ConfirmSheet, Tooltip, UiIcon } from "@bayramm/ui/react";
import { useEffect, useRef, useState } from "react";
import { type Failure, useCan, useLoad, useSession } from "../api";
import { partWindow } from "../categories";
import { apiErrorText, t } from "../texts";
import { ErrorText, LoadedView } from "../ui";

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

/** Не больше, чем сервер примет одной правкой */
const MAX_RANGE = 400;

/**
 * Дни выбора «несколько дней» по порядку, от раннего к позднему (концы можно выбрать в любом
 * порядке); прошедшие до today — не входят
 */
export function rangeDays(a: string, b: string, today: string): string[] {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const days: string[] = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); days.length < MAX_RANGE; d += DAY_MS) {
    const day = new Date(d).toISOString().slice(0, 10);
    if (day > to) break;
    if (day >= today) days.push(day);
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
    parallelCapacity: result.parallelCapacity,
    version: result.version,
  };
}

/** Часть дня глазами календаря: отмечена ли, сколько договорённостей, занята ли */
export interface PartState {
  readonly part: DayPart;
  readonly mark: BusyPart | undefined;
  readonly count: number;
  /** Мест не осталось: договорённостей не меньше, чем заказов одновременно */
  readonly full: boolean;
  readonly busy: boolean;
}

export type DayLoad = "free" | "partial" | "busy";

/** Части дня и его загрузка (режим parts) */
export function dayState(availability: Availability, day: string): { parts: PartState[]; load: DayLoad } {
  const whole = availability.busy.some((b) => b.day === day);
  const parts = DAY_PARTS.map((part): PartState => {
    const mark = availability.parts.find((p) => p.day === day && p.part === part);
    const count = availability.bookings.find((b) => b.day === day && b.part === part)?.count ?? 0;
    const full = count >= availability.parallelCapacity;
    return { part, mark, count, full, busy: whole || mark !== undefined || full };
  });
  const busyParts = parts.filter((p) => p.busy).length;
  const load: DayLoad = whole || busyParts === DAY_PARTS.length ? "busy" : busyParts > 0 ? "partial" : "free";
  return { parts, load };
}

type Range = { readonly start: string; readonly end: string | null };

/** Что снимет «Освободить»: выбрано дней, из них занято (отмечено) и отмечено вендором */
export interface FreeCount {
  readonly days: number;
  /** null — не узнали (нет связи): подтверждение говорит только число дней */
  readonly marked: number | null;
  readonly byVendor: number | null;
}

/** Счёт для подтверждения по занятым дням отрезка */
export function freeCount(days: readonly string[], busy: readonly BusyDay[]): FreeCount {
  const chosen = new Set(days);
  const marked = busy.filter((b) => chosen.has(b.day));
  return {
    days: days.length,
    marked: marked.length,
    byVendor: marked.filter((b) => b.source === "vendor").length,
  };
}

export function Calendar({ listingId, category }: { listingId: string; category: CategoryConfig }) {
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
  // Выбор нескольких дней: null — обычный режим (нажатие отмечает день сразу)
  const [ranging, setRanging] = useState(false);
  const [range, setRange] = useState<Range | null>(null);
  // Режим parts: открытый день — его части под сеткой
  const [opened, setOpened] = useState<string | null>(null);
  // «Освободить» несколько дней — подтверждение со счётом
  const [freeing, setFreeing] = useState<FreeCount | null>(null);
  // Листнули месяц: на экране — прежний ответ, пока не пришёл новый (useLoad его не стирает)
  const [waiting, setWaiting] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: loaded — повод: пришёл ответ нового месяца
  useEffect(() => setWaiting(false), [loaded]);
  const editable = can("listings.write");
  const parts = category.availability === "parts";
  const selected = range ? rangeDays(range.start, range.end ?? range.start, today) : [];
  const hint =
    category.availability === "parts"
      ? t.availabilityHints.parts
      : category.availability === "slot"
        ? t.availabilityHints.slot
        : t.availabilityHints.day;

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
    const ok = await send("range", { version: current.version, [mark]: selected }, current);
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
      setFreeing(freeCount(selected, current.busy));
      return;
    }
    setPending("count");
    const result = await api.get<Availability>(
      `/staff/listings/${listingId}/availability?from=${first}&to=${last}`,
    );
    setPending(null);
    setFreeing(
      result.ok
        ? freeCount(selected, result.data.busy)
        : { days: selected.length, marked: null, byVendor: null },
    );
  };

  const toggleRanging = () => {
    setRanging(!ranging);
    setRange(null);
    setOpened(null);
    setFailure(null);
  };

  return (
    <section className="panel cal-panel" aria-labelledby="calendar-title">
      <h2 id="calendar-title">{t.availability}</h2>
      {/* Без права правки дни неактивны — и подсказка не зовёт на них нажимать */}
      <p className="muted small">{editable ? hint : t.availabilityReadOnly}</p>
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
        {(availability) => {
          // Новый месяц ещё грузится, на экране — прежний ответ: дни неактивны, отметки не видны
          const stale = waiting;
          const busyByDay = new Map(stale ? [] : availability.busy.map((b) => [b.day, b]));
          const inRange = new Set(selected);
          const openedState = opened && !stale ? dayState(availability, opened) : null;
          return (
            <>
              {parts ? <p className="cal-capacity">{t.capacityNow(availability.parallelCapacity)}</p> : null}
              {stale ? (
                <p className="visually-hidden" role="status">
                  {t.calLoading}
                </p>
              ) : null}
              <div className="cal" aria-busy={stale || undefined}>
                {t.weekdays.map((name) => (
                  <span key={name} className="cal-wd" aria-hidden="true">
                    {name}
                  </span>
                ))}
                {Array.from({ length: offset }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: пустые клетки перед первым числом
                  <span key={`pad-${i}`} className="cal-pad" aria-hidden="true" />
                ))}
                {days.map((day) => {
                  const busy = busyByDay.get(day);
                  const past = day < today;
                  const chosen = inRange.has(day);
                  const load: DayLoad =
                    parts && !stale ? dayState(availability, day).load : busy ? "busy" : "free";
                  const status = parts
                    ? load === "free"
                      ? ""
                      : ` — ${t.dayLoad[load]}`
                    : busy
                      ? ` — ${t.busy}, ${t.busySources[busy.source] ?? ""}`
                      : "";
                  const label = `${dayName(day)}${status}${chosen ? `, ${t.rangeInside}` : ""}`;
                  // Режим parts: день открывается (части — под сеткой); иначе нажатие отмечает день
                  const open = parts && !ranging;
                  // Подсказка под мышью повторяет aria-label: диктору её не дублируем
                  return (
                    <Tooltip key={day} text={label} describe={false}>
                      {(tip) => (
                        <button
                          {...tip}
                          type="button"
                          className={`cal-day${load === "busy" ? " cal-busy" : load === "partial" ? " cal-partial" : ""}${day === today ? " cal-today" : ""}${chosen ? " cal-chosen" : ""}${open && opened === day ? " cal-open" : ""}`}
                          aria-pressed={open ? opened === day : Boolean(busy)}
                          aria-label={label}
                          disabled={!editable || past || pending !== null || stale}
                          onClick={() =>
                            ranging
                              ? pick(day)
                              : open
                                ? setOpened(opened === day ? null : day)
                                : toggle(day, busy, availability)
                          }
                        >
                          {Number(day.slice(8))}
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
                {parts ? (
                  <li>
                    <span className="cal-key cal-key-partial" aria-hidden="true" />
                    {t.legendPartial}
                  </li>
                ) : null}
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
                <section className="day-parts" aria-label={t.pickedDay(dayName(opened))}>
                  <p className="day-parts-title">{t.pickedDay(dayName(opened))}</p>
                  <div className="day-part-row">
                    <span className="day-part-name">
                      {t.wholeDay}
                      <span className="sub">
                        {busyByDay.has(opened) ? t.partState.busy : t.partState.free}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-pressed={busyByDay.has(opened)}
                      disabled={pending !== null}
                      onClick={() => toggle(opened, busyByDay.get(opened), availability)}
                    >
                      {busyByDay.has(opened) ? t.rangeFree : t.markBusy}
                      <span className="visually-hidden">: {t.wholeDay}</span>
                    </button>
                  </div>
                  {openedState.parts.map((state) => {
                    const name = t.dayParts[state.part] ?? state.part;
                    const whole = busyByDay.has(opened);
                    const word =
                      state.mark || whole
                        ? t.partState.busy
                        : state.full
                          ? t.partState.full
                          : t.partState.free;
                    return (
                      <div key={state.part} className="day-part-row">
                        <span className="day-part-name">
                          {name} <span className="sub">{partWindow(category, state.part)}</span>
                          <span className="sub">
                            {word} · {t.partBookings(state.count, availability.parallelCapacity)}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="btn btn-sm"
                          aria-pressed={state.mark !== undefined}
                          disabled={pending !== null || whole || (state.full && !state.mark)}
                          onClick={() => togglePart(opened, state, availability)}
                        >
                          {state.mark ? t.rangeFree : t.markBusy}
                          <span className="visually-hidden">: {name}</span>
                        </button>
                      </div>
                    );
                  })}
                </section>
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
      <p className="muted small">{t.leadHint}</p>
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
