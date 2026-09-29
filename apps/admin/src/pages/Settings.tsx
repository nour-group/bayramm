/* Настройки — только администратор. Каждая — своей формой: значение проверяет сервер и
   ещё раз база (границы и согласованность: напоминания раньше срока ответа, минимум фото
   не больше максимума). Ошибка — у той настройки, которую меняли. */

import type { SettingKey, SettingValue, StaffSetting, StaffSettings } from "@bayramm/shared/api/staff";
import { type FormEvent, useId, useState } from "react";
import { type Failure, useLoad, useSession } from "../api";
import { formatMoment } from "../format";
import { t } from "../texts";
import { ErrorText, LoadedView } from "../ui";

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

  const change = (index: number) => (value: string) => {
    const next = [...draft];
    next[index] = value;
    setDraft(next);
    setSaved(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await api.put<StaffSettings>(`/staff/settings/${setting.key}`, {
      value: settingValue(setting.key, draft),
    });
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) {
      setSaved(true);
      onSaved(result.data);
    }
  };

  const input = (index: number, extra: { label: string; type: "number" | "time" }) => (
    <div className="field" key={index}>
      <label htmlFor={`${id}-${index}`}>{extra.label}</label>
      <input
        id={`${id}-${index}`}
        className="input"
        type={extra.type}
        inputMode={extra.type === "number" ? "numeric" : undefined}
        value={draft[index] ?? ""}
        aria-invalid={invalid}
        aria-describedby={hintId}
        onChange={(event) => change(index)(event.target.value)}
      />
    </div>
  );

  return (
    <form className={`setting${invalid ? " field-bad" : ""}`} onSubmit={submit} noValidate>
      <h2 className="setting-title">{label}</h2>
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
          <button type="submit" className="btn" disabled={busy}>
            {t.save}
          </button>
        </div>
      </div>
      <p id={hintId} className={invalid ? "field-error" : "field-hint"}>
        {invalid ? t.settingInvalid : t.settingsHints[setting.key]}
      </p>
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
