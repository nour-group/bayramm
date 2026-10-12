/* Настройки — только администратор. Одним списком по группам (ответ вендора, фото, данные):
   строка — название с границами («1–72 ч»), число с «−» и «+» и единица. Каждая строка — своей
   формой: «Сохранить» появляется, только когда её значение изменили. Значение проверяет сервер и
   ещё раз база (границы и согласованность: напоминания раньше срока ответа, минимум фото
   не больше максимума). Ошибка — у той настройки, которую меняли.
   Число — в границах SETTING_LIMITS (те же у API); вне границ или напоминания не по возрастанию —
   ошибка до запроса. */

import {
  SETTING_LIMITS,
  type SettingKey,
  type SettingValue,
  type StaffSetting,
  type StaffSettings,
} from "@bayramm/shared/api/staff";
import { NumberStepper, TimeField, useToast } from "@bayramm/ui/react";
import { type FormEvent, useId, useState } from "react";
import { type Failure, useLoad, useSession } from "../api";
import { t } from "../texts";
import { ErrorText, LoadedView } from "../ui";
import { useUnsaved } from "../unsaved";

/** Группы строк: что настраивают рядом. Ключ вне групп (новее сборки панели) попадает в «Данные» */
const GROUPS: readonly { readonly id: string; readonly keys: readonly SettingKey[] }[] = [
  { id: "vendor", keys: ["sla_hours", "sla_reminder_hours", "quiet_hours", "ops_reminder_pause_minutes"] },
  { id: "photos", keys: ["min_photos", "max_photos"] },
  {
    id: "data",
    keys: [
      "client_requests_per_day",
      "request_contact_retention_days",
      "session_retention_days",
      "otp_retention_hours",
    ],
  },
];

export function SettingsPage() {
  const { loaded, reload, set } = useLoad<StaffSettings>("/staff/settings");
  return (
    <LoadedView loaded={loaded} onRetry={reload}>
      {(settings) => {
        const grouped = new Set(GROUPS.flatMap((group) => group.keys));
        const rest = settings.items.filter((setting) => !grouped.has(setting.key));
        return (
          <div className="stack">
            {GROUPS.map((group) => {
              const items = settings.items.filter(
                (setting) =>
                  group.keys.includes(setting.key) || (group.id === "data" && rest.includes(setting)),
              );
              return items.length === 0 ? null : (
                <section key={group.id} className="panel" aria-labelledby={`settings-${group.id}`}>
                  <h2 id={`settings-${group.id}`}>{t.settingGroups[group.id]}</h2>
                  <ul className="settings-list">
                    {items.map((setting) => (
                      <li key={setting.key} className="setting-item">
                        <SettingForm setting={setting} onSaved={set} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        );
      }}
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
  const toast = useToast();
  const id = useId();
  const [draft, setDraft] = useState(() => draftOf(setting));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const label = t.settingsLabels[setting.key] ?? setting.key;
  const hintId = `${id}-hint`;
  const invalid = failure?.code === "invalid_input";
  // Значение изменено и не сохранено: «Сохранить» появляется, уход переспросит. Без изменений
  // сохранять нечего — и в журнал не уходит пустая запись
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(setting));
  useUnsaved(dirty);

  const change = (index: number) => (value: string) => {
    const next = [...draft];
    next[index] = value;
    setDraft(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = settingValue(setting.key, draft);
    // Вне границ — сервер ответил бы так же: говорим сразу, без запроса
    if (!settingFits(setting.key, value)) {
      setFailure(invalidOf(setting.key));
      return;
    }
    setBusy(true);
    const result = await api.put<StaffSettings>(`/staff/settings/${setting.key}`, { value });
    setBusy(false);
    setFailure(result.ok ? null : result);
    if (result.ok) {
      toast(`${label}: ${t.saved.toLowerCase()}`, { tone: "success" });
      // Поля — как сохранил сервер («04» → 4): иначе форма осталась бы «изменённой»
      const next = result.data.items.find((item) => item.key === setting.key);
      if (next) setDraft(draftOf(next));
      onSaved(result.data);
    }
  };

  // Число — NumberStepper в границах настройки и с единицей, время — TimeField (список «ЧЧ:ММ»).
  // Подпись у поля — только когда их несколько (два напоминания, «с» и «до»); одно — по названию строки
  const limits = limitsOf(setting.key);
  const unit = t.settingUnits[setting.key];
  const several = setting.key === "sla_reminder_hours" || setting.key === "quiet_hours";
  const input = (index: number, extra: { label: string; type: "number" | "time" }) => {
    const common = { id: `${id}-${index}`, "aria-invalid": invalid, "aria-describedby": hintId };
    const name = several ? extra.label : label;
    return (
      <div className={`field${extra.type === "number" ? " setting-num" : ""}`} key={index}>
        <label htmlFor={common.id} className={several ? undefined : "visually-hidden"}>
          {name}
        </label>
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
              decrementLabel={`${name}: ${t.input.less}`}
              incrementLabel={`${name}: ${t.input.more}`}
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
    <form className={`setting-row${invalid ? " field-bad" : ""}`} onSubmit={submit} noValidate>
      <div className="setting-text">
        <h3 className="setting-title">{label}</h3>
        <p id={hintId} className={invalid ? "field-error" : "field-hint"}>
          {invalid ? t.settingInvalid : t.settingsHints[setting.key]}
        </p>
      </div>
      <div className="setting-controls">
        {setting.key === "sla_reminder_hours"
          ? [
              input(0, { label: t.reminderFirst, type: "number" }),
              input(1, { label: t.reminderSecond, type: "number" }),
            ]
          : setting.key === "quiet_hours"
            ? [input(0, { label: t.quietFrom, type: "time" }), input(1, { label: t.quietTo, type: "time" })]
            : input(0, { label: t.settingValue, type: "number" })}
        {dirty || busy ? (
          <button type="submit" className="btn btn-primary" aria-busy={busy || undefined} disabled={busy}>
            {busy ? t.saving : t.save}
          </button>
        ) : null}
      </div>
      {failure && !invalid && <ErrorText failure={failure} />}
    </form>
  );
}
