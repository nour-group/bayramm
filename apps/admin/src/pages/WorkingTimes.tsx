/* «Время работы» витрины на её странице: одно мероприятие в день или несколько, рабочие части
   дня и их окна (свои или окна категории; время — из списка с шагом 30 минут), заказов
   одновременно. Меняется сразу, без модерации, как календарь: от версии календаря витрины
   (calendarVersion); календарь успели изменить — calendar_conflict, витрина перечитывается.
   Часть с будущими заявками не убрать (part_in_use — сколько заявок); на одно мероприятие в
   день — всегда. Без права listings.write — только показ. Шторка «Изменить»: вписанное и не
   сохранённое — уход переспросит (useUnsaved). */

import type { DaySessionsChange, ListingDetail } from "@bayramm/shared/api/staff";
import {
  type CategoryConfig,
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
import { type Failure, useCan, useSession } from "../api";
import { apiErrorText, t } from "../texts";
import { useUnsaved } from "../unsaved";

const partTitle = (part: DayPart) => t.dayParts[part] ?? part;

/** Почему не сохранилось: часть с заявками — какие и сколько; иначе текст по коду */
export function sessionsFailureText(failure: Failure): string {
  if (failure.code === "part_in_use" && failure.inUse && failure.inUse.length > 0)
    return failure.inUse.map((p) => t.sessionsInUse(partTitle(p.part).toLowerCase(), p.count)).join(" ");
  return apiErrorText(failure.code);
}

export function WorkingTimes({
  listing,
  category,
  onSaved,
}: {
  listing: ListingDetail;
  category: CategoryConfig;
  /** Сохранили или календарь изменили: перечитать витрину (и календарь) */
  onSaved: () => void;
}) {
  const { api } = useSession();
  const can = useCan();
  const toast = useToast();
  const editable = can("listings.write");
  const sessions = listing.daySessions;
  const formId = useId();
  const edit = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState<DaySessionsDraft>(() => daySessionsDraft(sessions));
  const [draft, setDraft] = useState<DaySessionsDraft>(start);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useUnsaved(open && daySessionsDirty(draft, start));

  const openSheet = () => {
    const next = daySessionsDraft(sessions);
    setStart(next);
    setDraft(next);
    setErrors([]);
    setFailure(null);
    setOpen(true);
  };
  const close = () => {
    if (!busy) setOpen(false);
  };
  const update = (patch: Partial<DaySessionsDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const togglePart = (part: DayPart, on: boolean) =>
    update({
      parts: on
        ? DAY_PARTS.filter((p) => p === part || draft.parts.includes(p))
        : draft.parts.filter((p) => p !== part),
    });
  const setWindow = (part: DayPart, edge: "from" | "to", value: string) =>
    update({ windows: { ...draft.windows, [part]: { ...draft.windows[part], [edge]: value } } });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const input = daySessionsInput(category, draft);
    const checked = validateDaySessions(category, input);
    if (!checked.ok) {
      setErrors(checked.errors);
      setFailure(null);
      return;
    }
    setErrors([]);
    setFailure(null);
    setBusy(true);
    const result = await api.put<DaySessionsChange>(`/staff/listings/${listing.id}/day-sessions`, {
      version: listing.calendarVersion,
      ...input,
    });
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      toast(t.sessionsSaved, { tone: "success" });
      onSaved();
      return;
    }
    if (result.code === "invalid_input") setErrors(result.details);
    else setFailure(sessionsFailureText(result));
    // Календарь изменили: версия устарела — перечитать витрину и сохранить ещё раз
    if (result.code === "calendar_conflict") onSaved();
  };

  const windowError = (part: DayPart) => errors.includes(`windows.${part}`);

  return (
    <section className="panel" aria-labelledby="sessions-title">
      <div className="panel-head">
        <h2 id="sessions-title">{t.sessionsTitle}</h2>
        {editable ? (
          <button ref={edit} type="button" className="btn btn-sm" onClick={openSheet}>
            {t.sessionsEdit}
          </button>
        ) : null}
      </div>
      <dl className="dl">
        <dt>{t.sessionsMode}</dt>
        <dd>{sessions.mode === "whole" ? t.sessionsModeWhole : t.sessionsModeParts}</dd>
        {sessions.mode === "parts" ? (
          <>
            <dt>{t.sessionsParts}</dt>
            <dd>
              {sessions.parts
                .map((part) => `${partTitle(part)} ${windowText(sessions.windows[part])}`)
                .join(", ")}
            </dd>
          </>
        ) : null}
        <dt>{t.listingDataSections.occupancy}</dt>
        <dd>{sessions.parallelCapacity}</dd>
      </dl>
      {editable ? (
        <Dialog
          open={open}
          title={t.sessionsTitle}
          onClose={close}
          returnFocus={edit}
          className="sheet-form"
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
                {t.save}
              </button>
            </>
          }
        >
          <form id={formId} className="sessions-form" noValidate onSubmit={(event) => void submit(event)}>
            <p className="muted small">{t.sessionsLead}</p>
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
              <fieldset className="sessions-field">
                <legend>{t.sessionsParts}</legend>
                <ul className="sessions-rows">
                  {DAY_PARTS.map((part) => {
                    const on = draft.parts.includes(part);
                    const w = draft.windows[part];
                    const name = partTitle(part);
                    return (
                      <li
                        key={part}
                        className={windowError(part) ? "sessions-row field-bad" : "sessions-row"}
                      >
                        <Checkbox checked={on} onChange={(checked) => togglePart(part, checked)}>
                          {name}
                        </Checkbox>
                        {on ? (
                          <div className="sessions-times">
                            <Select
                              size="compact"
                              label={t.sessionsFrom(name)}
                              value={w.from}
                              options={windowTimes("from", w.from).map((v) => ({ value: v, label: v }))}
                              onChange={(value) => setWindow(part, "from", value)}
                              aria-invalid={windowError(part) || undefined}
                            />
                            <span aria-hidden="true">–</span>
                            <Select
                              size="compact"
                              label={t.sessionsTo(name)}
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
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => update({ windows: dayPartWindows(category) })}
                >
                  {t.sessionsDefault}
                </button>
              </fieldset>
            ) : null}
            <div className="sessions-field">
              <p className="sessions-label">{t.listingDataSections.occupancy}</p>
              <p className="muted small" id={`${formId}-capacity`}>
                {t.sessionsCapacityLead}
              </p>
              <NumberStepper
                value={draft.capacity}
                min={1}
                max={MAX_PARALLEL_CAPACITY}
                maxLength={2}
                onChange={(capacity) => update({ capacity })}
                aria-label={t.listingDataSections.occupancy}
                decrementLabel={`${t.listingDataSections.occupancy} −1`}
                incrementLabel={`${t.listingDataSections.occupancy} +1`}
                aria-describedby={`${formId}-capacity`}
                aria-invalid={errors.includes("parallelCapacity") || undefined}
              />
              {errors.includes("parallelCapacity") ? (
                <p className="field-error">{t.parallelCapacityError}</p>
              ) : null}
            </div>
            {failure ? (
              <p className="notice notice-error" role="alert">
                {failure}
              </p>
            ) : null}
          </form>
        </Dialog>
      ) : null}
    </section>
  );
}
