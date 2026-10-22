/* Карточка «Время работы» на экране витрины: как витрина работает в течение дня.
     · одно мероприятие в день (любая договорённость или отметка занимает весь день) или
       несколько — утром, днём и вечером отдельно;
     · в каких частях дня витрина работает (галочки) и окна этих частей — свои или окна
       категории; время — из списка с шагом 30 минут (своё поле времени, не системное);
     · сколько заказов витрина берёт одновременно (залы, машины, экипажи).
   Меняется сразу, без проверки командой — это часть календаря: правка идёт от версии календаря
   витрины (calendarVersion); календарь успели изменить — 409 calendar_conflict, карточка
   перечитывается. Часть, на которую есть будущие заявки, убрать нельзя (409 part_in_use — со
   сколькими заявками); перейти на одно мероприятие в день можно всегда.
   Владелец кабинета меняет в шторке «Изменить»; сотрудник площадки (member) только смотрит.
   Вписанное и не сохранённое — уход переспросит (useUnsaved). Подсказка к «Заказов одновременно» —
   словами категории (залы, машины, команды); у зала с указанным «Сколько залов» — их число рядом.
   Сохранили — всплывающая строка; ошибка проверки — фокус на первое неверное поле. */

import { ruPlural } from "@bayramm/shared";
import type { VendorListing } from "@bayramm/shared/api/vendor";
import {
  categoryConfig,
  DAY_PARTS,
  type DayPart,
  type DaySessionsDraft,
  dayPartWindows,
  daySessionsDirty,
  daySessionsDraft,
  daySessionsInput,
  MAX_PARALLEL_CAPACITY,
  type PartMode,
  validateDaySessions,
  windowText,
  windowTimes,
} from "@bayramm/shared/categories";
import { Checkbox, Dialog, NumberStepper, RadioGroup, Select, useToast } from "@bayramm/ui/react";
import { type FormEvent, useId, useRef, useState } from "react";
import { ApiFailure, api } from "./api";
import { partName } from "./category";
import { errorText } from "./errors";
import { fill, type TextKey, type VendorDict } from "./i18n";
import { useFocusInvalid } from "./invalid";
import { useConfirmLeave, useUnsaved } from "./unsaved";

interface Props {
  readonly listing: VendorListing;
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
  readonly owner: boolean;
  /** Сохранили или календарь изменили: перечитать витрину */
  readonly onChanged: () => Promise<void>;
}

type Draft = DaySessionsDraft;

/** Что значит «заказов одновременно» у категории: залы, машины, команды или мероприятия */
const CAPACITY_HINT: Readonly<Record<string, TextKey>> = {
  hall: "capacityHalls",
  restaurant: "capacityHalls",
  car: "capacityCars",
  photo: "capacityTeams",
  decor: "capacityTeams",
};

export function capacityHint(t: VendorDict, categoryCode: string): string {
  return `${t[CAPACITY_HINT[categoryCode] ?? "capacityEvents"]} ${t.capacityLead}`;
}

/** «на эту часть 2 будущие заявки» */
function inUseText(t: VendorDict, lang: "ru" | "uz", part: DayPart, count: number): string {
  const requests =
    lang === "ru" ? ruPlural(count, t.requestsOne, t.requestsFew, t.requestsMany) : t.requestsMany;
  return fill(t.sessionsInUse, { part: partName(t, part).toLowerCase(), n: count, requests });
}

export function WorkingTimes({ listing, t, lang, owner, onChanged }: Props) {
  const sessions = listing.daySessions;
  const category = categoryConfig(listing.categoryCode);
  const formId = useId();
  const edit = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState<Draft>(() => daySessionsDraft(listing.daySessions));
  const [draft, setDraft] = useState<Draft>(start);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const showInvalid = useFocusInvalid(form);
  // «Сколько залов» витрины — рядом с «Заказов одновременно»: обычно это одно и то же число
  const halls = listing.attributes.halls_count;

  useUnsaved(open && daySessionsDirty(draft, start));
  const confirmLeave = useConfirmLeave();

  const openSheet = () => {
    const next = daySessionsDraft(listing.daySessions);
    setStart(next);
    setDraft(next);
    setErrors([]);
    setFormError(null);
    setOpen(true);
  };
  // Вписанное и не сохранённое — «Уйти без сохранения?»; окно закрывается следующим тактом
  const close = () => {
    if (!busy) confirmLeave(() => queueMicrotask(() => setOpen(false)));
  };
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const togglePart = (part: DayPart, on: boolean) =>
    update({
      parts: on
        ? DAY_PARTS.filter((p) => p === part || draft.parts.includes(p))
        : draft.parts.filter((p) => p !== part),
    });
  const setWindow = (part: DayPart, edge: "from" | "to", value: string) =>
    update({ windows: { ...draft.windows, [part]: { ...draft.windows[part], [edge]: value } } });
  const resetWindows = () => {
    if (category) update({ windows: dayPartWindows(category) });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!category) return;
    const input = daySessionsInput(category, draft);
    const checked = validateDaySessions(category, input);
    if (!checked.ok) {
      setErrors(checked.errors);
      setFormError(null);
      showInvalid();
      return;
    }
    setErrors([]);
    setFormError(null);
    setBusy(true);
    try {
      await api.setDaySessions(listing.id, input, listing.calendarVersion);
      await onChanged();
      setOpen(false);
      toast(t.sessionsSaved, { tone: "success" });
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "invalid_input") {
        setErrors(err.details);
        showInvalid();
      } else if (err instanceof ApiFailure && err.code === "part_in_use" && err.inUse.length > 0)
        setFormError(err.inUse.map((p) => inUseText(t, lang, p.part, p.count)).join(" "));
      else {
        // Календарь изменили: версия устарела — перечитать витрину, сохранить ещё раз
        if (err instanceof ApiFailure && err.code === "calendar_conflict") await onChanged();
        setFormError(errorText(err, t));
      }
    } finally {
      setBusy(false);
    }
  };

  const windowError = (part: DayPart) => errors.includes(`windows.${part}`);

  return (
    <section className="panel sessions" aria-labelledby="sessions-title">
      <div className="contacts-head">
        <h3 className="panel-title" id="sessions-title" tabIndex={-1}>
          {t.sessionsTitle}
        </h3>
        {owner ? (
          <button ref={edit} type="button" className="btn btn-ghost" onClick={openSheet}>
            {t.sessionsEdit}
          </button>
        ) : null}
      </div>
      <dl className="contact-rows">
        <div>
          <dt>{t.sessionsMode}</dt>
          <dd>{sessions.mode === "whole" ? t.sessionsModeWhole : t.sessionsModeParts}</dd>
        </div>
        {sessions.mode === "parts" ? (
          <div>
            <dt>{t.sessionsParts}</dt>
            <dd>
              <ul className="sessions-parts">
                {sessions.parts.map((part) => (
                  <li key={part}>
                    {partName(t, part)}{" "}
                    <span className="day-part-window">{windowText(sessions.windows[part])}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t.capacityTitle}</dt>
          <dd>{sessions.parallelCapacity}</dd>
        </div>
      </dl>

      {owner ? (
        <Dialog
          open={open}
          title={t.sessionsTitle}
          onClose={close}
          returnFocus={edit}
          className="sheet-wide"
          actions={
            <>
              <button type="button" className="ui-btn ui-btn-secondary" disabled={busy} onClick={close}>
                {t.cancel}
              </button>
              <button
                type="submit"
                form={formId}
                className="ui-btn ui-btn-primary"
                disabled={busy}
                aria-busy={busy || undefined}
              >
                {t.sessionsSave}
              </button>
            </>
          }
        >
          <form
            ref={form}
            id={formId}
            className="sessions-form"
            noValidate
            onSubmit={(event) => void submit(event)}
          >
            <p className="note">{t.sessionsLead}</p>
            <fieldset className="sessions-field">
              <legend>{t.sessionsMode}</legend>
              <RadioGroup<PartMode>
                variant="row"
                value={draft.mode}
                options={[
                  { value: "whole", label: t.sessionsModeWhole, hint: t.sessionsModeWholeHint },
                  { value: "parts", label: t.sessionsModeParts, hint: t.sessionsModePartsHint },
                ]}
                onChange={(mode) => update({ mode })}
              />
            </fieldset>
            {draft.mode === "parts" ? (
              <fieldset className="sessions-field" aria-invalid={errors.includes("parts") || undefined}>
                <legend>{t.sessionsParts}</legend>
                <ul className="sessions-rows">
                  {DAY_PARTS.map((part) => {
                    const on = draft.parts.includes(part);
                    const w = draft.windows[part];
                    const name = partName(t, part);
                    return (
                      <li
                        key={part}
                        className={windowError(part) ? "sessions-row is-invalid" : "sessions-row"}
                      >
                        <Checkbox checked={on} onChange={(checked) => togglePart(part, checked)}>
                          {name}
                        </Checkbox>
                        {on ? (
                          <div className="sessions-times">
                            <Select
                              size="compact"
                              label={fill(t.sessionsFrom, { part: name })}
                              value={w.from}
                              options={windowTimes("from", w.from).map((v) => ({ value: v, label: v }))}
                              onChange={(value) => setWindow(part, "from", value)}
                              aria-invalid={windowError(part) || undefined}
                            />
                            <span aria-hidden="true">–</span>
                            <Select
                              size="compact"
                              label={fill(t.sessionsTo, { part: name })}
                              value={w.to}
                              options={windowTimes("to", w.to).map((v) => ({ value: v, label: v }))}
                              onChange={(value) => setWindow(part, "to", value)}
                              aria-invalid={windowError(part) || undefined}
                            />
                          </div>
                        ) : null}
                        {windowError(part) ? <p className="field-error">{t.sessionsWindowInvalid}</p> : null}
                      </li>
                    );
                  })}
                </ul>
                {errors.includes("parts") ? <p className="field-error">{t.sessionsPartsRequired}</p> : null}
                <button type="button" className="btn btn-ghost" onClick={resetWindows}>
                  {t.sessionsDefault}
                </button>
              </fieldset>
            ) : null}
            <div className="sessions-field">
              <p className="sessions-label" id={`${formId}-capacity`}>
                {t.capacityTitle}
              </p>
              <p className="note" id={`${formId}-capacity-hint`}>
                {capacityHint(t, listing.categoryCode)}
                {typeof halls === "number" ? ` ${fill(t.capacityHallsCount, { n: halls })}` : ""}
              </p>
              <NumberStepper
                value={draft.capacity}
                min={1}
                max={MAX_PARALLEL_CAPACITY}
                maxLength={2}
                onChange={(capacity) => update({ capacity })}
                aria-label={t.capacityTitle}
                decrementLabel={`${t.capacityTitle}: ${t.capacityLess}`}
                incrementLabel={`${t.capacityTitle}: ${t.capacityMore}`}
                aria-describedby={`${formId}-capacity-hint`}
                aria-invalid={errors.includes("parallelCapacity") || undefined}
              />
              {errors.includes("parallelCapacity") ? (
                <p className="field-error">{t.capacityInvalid}</p>
              ) : null}
            </div>
            {formError ? (
              <p className="form-error" role="alert">
                {formError}
              </p>
            ) : null}
          </form>
        </Dialog>
      ) : null}
    </section>
  );
}
