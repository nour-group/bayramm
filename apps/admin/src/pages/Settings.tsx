/* Настройки — только администратор. Каждая — своей формой: значение проверяет сервер и
   ещё раз база (границы и согласованность: напоминания раньше срока ответа, минимум фото
   не больше максимума). Ошибка — у той настройки, которую меняли.
   Число — с «−» и «+» в границах SETTING_LIMITS (те же у API) и единицей после поля; вне
   границ или напоминания не по возрастанию — ошибка до запроса. */

import {
  SETTING_LIMITS,
  type SettingKey,
  type SettingValue,
  type StaffSetting,
  type StaffSettings,
} from "@bayramm/shared/api/staff";
import { NumberStepper, TimeField } from "@bayramm/ui/react";
import { type FormEvent, useId, useState } from "react";
import { type Failure, useLoad, useSession } from "../api";
import { formatMoment } from "../format";
import { t } from "../texts";
import { ErrorText, LoadedView } from "../ui";
import { useUnsaved } from "../unsaved";

export function SettingsPage() {
  const { loaded, reload, set } = useLoad<StaffSettings>("/staff/settings");
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(settings) => (
        <ul className="cards">
          {settings.items.map((setting) => (
            <li key={setting.key} className="panel card-row">
              <SettingForm setting={setting} onSaved={set} />
            </li>
          ))}
        </ul>
      )}
    </LoadedView>
  );
}

/** Значение в поля формы: всё — строками, как в input */
function draftOf(setting: StaffSetting): string[] {
  const value = setting.value;
  if (Array.isArray(value)) return [String(value[0] ?? ""), String(value[1] ?? "")];
  if (typeof value === "object" && value !== null && "from" in value) return [value.from, value.to];
  return [String(value)];
}

/** Поля формы → значение для API; кривое число уйдёт как есть — ответит сервер */
function settingValue(key: SettingKey, draft: string[]): SettingValue {
  const num = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));
  switch (key) {
    case "sla_reminder_hours":
      return draft.filter((s) => s.trim() !== "").map(num);
    case "quiet_hours":
      return { from: draft[0] ?? "", to: draft[1] ?? "" };
    default:
      return num(draft[0] ?? "");
  }
}

type NumberKey = keyof typeof SETTING_LIMITS;

const limitsOf = (key: SettingKey): readonly [number, number] | null =>
  key === "quiet_hours" ? null : SETTING_LIMITS[key as NumberKey];

/** Значение подходит по границам (и напоминания — по возрастанию); согласованность с другими — сервер */
export function settingFits(key: SettingKey, value: SettingValue): boolean {
  const limits = limitsOf(key);
  if (limits === null) return true;
  const [min, max] = limits;
  const fits = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
  if (Array.isArray(value))
    return value.every(fits) && value.every((n, i) => i === 0 || n > (value[i - 1] ?? 0));
  return fits(value);
}

const invalidOf = (key: SettingKey): Failure => ({
  ok: false,
  status: 422,
  code: "invalid_input",
  details: [key],
});

function SettingForm({ setting, onSaved }: { setting: StaffSetting; onSaved: (s: StaffSettings) => void }) {
  const { api } = useSession();
  const id = useId();
  const [draft, setDraft] = useState(() => draftOf(setting));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saved, setSaved] = useState(false);
  const label = t.settingsLabels[setting.key] ?? setting.key;
  const hintId = `${id}-hint`;
  const invalid = failure?.code === "invalid_input";
  // Значение изменено и не сохранено: «Сохранить» доступна, уход переспросит. Без изменений
  // сохранять нечего — и в журнал не уходит пустая запись
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(setting));
  useUnsaved(dirty);

  const change = (index: number) => (value: string) => {
    const next = [...draft];
    next[index] = value;
    setDraft(next);
    setSaved(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = settingValue(setting.key, draft);
    // Вне границ — сервер ответил бы так же: говорим сразу, без запроса
    if (!settingFits(setting.key, value)) {
      setSaved(false);
      setFailure(invalidOf(setting.key));
      return;
    }
    setBusy(true);
    const result = await api.put<StaffSettings>(`/staff/settings/${setting.key}`, { value });
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) {
      setSaved(true);
      // Поля — как сохранил сервер («04» → 4): иначе форма осталась бы «изменённой»
      const next = result.data.items.find((item) => item.key === setting.key);
      if (next) setDraft(draftOf(next));
      onSaved(result.data);
    }
  };

  // Число — NumberStepper в границах настройки и с единицей, время — TimeField (список «ЧЧ:ММ»)
  const limits = limitsOf(setting.key);
  const unit = t.settingUnits[setting.key];
  const input = (index: number, extra: { label: string; type: "number" | "time" }) => {
    const common = { id: `${id}-${index}`, "aria-invalid": invalid, "aria-describedby": hintId };
    return (
      <div className={`field${extra.type === "number" ? " setting-num" : ""}`} key={index}>
        <label htmlFor={common.id}>{extra.label}</label>
        {extra.type === "time" ? (
          <TimeField
            {...common}
            className="input"
            label={extra.label}
            value={draft[index] || null}
            onChange={change(index)}
          />
        ) : (
          <span className="num-row">
            <NumberStepper
              {...common}
              value={draft[index] ?? ""}
              onChange={change(index)}
              min={limits?.[0] ?? 0}
              max={limits?.[1] ?? Number.MAX_SAFE_INTEGER}
              maxLength={String(limits?.[1] ?? 99999).length}
              decrementLabel={`${extra.label}: ${t.input.less}`}
              incrementLabel={`${extra.label}: ${t.input.more}`}
            />
            {unit ? (
              <span className="num-unit" aria-hidden="true">
                {unit}
              </span>
            ) : null}
          </span>
        )}
      </div>
    );
  };

  return (
    <form className={`setting${invalid ? " field-bad" : ""}`} onSubmit={submit} noValidate>
      <h2 className="setting-title">{label}</h2>
      {/* Границы — до полей: на телефоне «Сохранить» встаёт под полем, подсказка — не под ней */}
      <p id={hintId} className={invalid ? "field-error" : "field-hint"}>
        {invalid ? t.settingInvalid : t.settingsHints[setting.key]}
      </p>
      <div className="setting-inputs">
        {setting.key === "sla_reminder_hours"
          ? [
              input(0, { label: t.reminderFirst, type: "number" }),
              input(1, { label: t.reminderSecond, type: "number" }),
            ]
          : setting.key === "quiet_hours"
            ? [input(0, { label: t.quietFrom, type: "time" }), input(1, { label: t.quietTo, type: "time" })]
            : input(0, { label: t.settingValue, type: "number" })}
        <div className="setting-save">
          <button
            type="submit"
            className="btn btn-primary"
            aria-busy={busy || undefined}
            disabled={busy || !dirty}
          >
            {busy ? t.saving : t.save}
          </button>
        </div>
      </div>
      <p className="sub">{t.updatedBy(formatMoment(setting.updatedAt), setting.updatedBy)}</p>
      {saved && (
        <p className="saved" role="status">
          {t.saved}
        </p>
      )}
      {failure && !invalid && <ErrorText failure={failure} />}
    </form>
  );
}
