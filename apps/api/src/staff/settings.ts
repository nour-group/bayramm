// Настройки платформы (app.settings) — только администратор. Меняет их база
// (app.staff_set_setting): только эти ключи, границы — app.setting_value_ok, плюс
// согласованность между ключами. Здесь те же правила — чтобы ответить 422 с именем
// ключа до базы; окончательно решает она.
//
//   GET /staff/settings           все изменяемые настройки
//   PUT /staff/settings/:key      { value } → все настройки; 422 invalid_input (details — [key])

import { normalizeTelegram, normalizeUzPhone } from "@bayramm/shared";
import {
  SETTING_LIMITS,
  type SettingKey,
  type SettingValue,
  type StaffSetting,
  type StaffSettings,
  TEAM_CONTACT_KEYS,
  type TeamContactKey,
} from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { sql } from "kysely";
import { staffOf } from "../auth/session";
import { GUEST, type Tx, withActor } from "../db/actor";
import type { Db } from "../db/client";
import type { AppEnv } from "../env";
import { isPgError, notFound } from "../errors";
import { requirePermission } from "./access";
import { invalidInput, limitJson, readBody } from "./input";
import { iso, staffName } from "./shared";

export const settings = new Hono<AppEnv>();

/** Числовые настройки и их границы — как в app.setting_value_ok (те же границы у формы панели) */
const { sla_reminder_hours: REMINDER_HOURS, ...INT_LIMITS } = SETTING_LIMITS;
export const INT_SETTINGS: Readonly<Record<keyof typeof INT_LIMITS, readonly [number, number]>> = INT_LIMITS;

/** Порядок показа в панели */
export const SETTING_KEYS = [
  "sla_hours",
  "sla_reminder_hours",
  "quiet_hours",
  "ops_reminder_pause_minutes",
  "min_photos",
  "max_photos",
  "client_requests_per_day",
  "request_contact_retention_days",
  "session_retention_days",
  "otp_retention_hours",
  "team_telegram",
  "team_phone",
] as const satisfies readonly SettingKey[];

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

const isTeamKey = (key: SettingKey): key is TeamContactKey =>
  (TEAM_CONTACT_KEYS as readonly string[]).includes(key);

/**
 * Контакт команды: "" — не указан; Telegram — имя без «@» (как вписали: @name, t.me/name — тоже),
 * телефон — +998XXXXXXXXX (пробелы и скобки можно). Как в app.setting_value_ok
 */
function parseTeamContact(key: TeamContactKey, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "") return "";
  return (key === "team_phone" ? normalizeUzPhone(text) : normalizeTelegram(text)) ?? undefined;
}

/** Значение настройки из тела запроса; не подходит по форме или границам — undefined */
export function parseSettingValue(key: SettingKey, value: unknown): SettingValue | undefined {
  if (isTeamKey(key)) return parseTeamContact(key, value);
  switch (key) {
    case "sla_reminder_hours": {
      if (!Array.isArray(value) || value.length > 2) return undefined;
      if (!value.every((h) => isInt(h, ...REMINDER_HOURS))) return undefined;
      const hours = value as number[];
      if (hours.length === 2 && (hours[0] ?? 0) >= (hours[1] ?? 0)) return undefined;
      return hours;
    }
    case "quiet_hours": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
      const { from, to, ...rest } = value as Record<string, unknown>;
      if (Object.keys(rest).length > 0) return undefined;
      if (typeof from !== "string" || typeof to !== "string" || !TIME_RE.test(from) || !TIME_RE.test(to)) {
        return undefined;
      }
      return { from, to };
    }
    default: {
      const [min, max] = INT_SETTINGS[key];
      return isInt(value, min, max) ? value : undefined;
    }
  }
}

async function loadSettings(trx: Tx): Promise<StaffSettings> {
  const rows = await trx
    .selectFrom("app.settings as s")
    .select(["s.key", "s.value", "s.updated_at", staffName("s.updated_by").as("updated_by_name")])
    .where("s.key", "in", SETTING_KEYS)
    .execute();
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return {
    items: SETTING_KEYS.flatMap((key): StaffSetting[] => {
      const row = byKey.get(key);
      return row
        ? [
            {
              key,
              value: row.value as SettingValue,
              updatedAt: iso(row.updated_at),
              updatedBy: row.updated_by_name,
            },
          ]
        : [];
    }),
  };
}

settings.get("/", requirePermission("settings.write"), async (c) => {
  return c.json(await withActor(c.var.db, staffOf(c), loadSettings));
});

settings.put("/:key", requirePermission("settings.write"), limitJson, async (c) => {
  const key = SETTING_KEYS.find((k) => k === c.req.param("key"));
  if (!key) throw notFound();
  const body = await readBody(c.req.raw);
  const value = parseSettingValue(key, body.value);
  if (value === undefined) throw invalidInput([key]);

  try {
    const result = await withActor(c.var.db, staffOf(c), async (trx) => {
      await sql`select app.staff_set_setting(${key}::text, ${JSON.stringify(value)}::jsonb)`.execute(trx);
      return loadSettings(trx);
    });
    return c.json(result);
  } catch (err) {
    // Вне границ или не согласуется с другими настройками — ошибка этого ключа
    if (isPgError(err) && err.code === "23514") throw invalidInput([key]);
    throw err;
  }
});

/**
 * Контакт команды для партнёров — всем, без входа (GET /auth/methods): контакт компании, не ПДн.
 * Не указан — null; база недоступна — тоже null (вход от этого не ломается)
 */
export async function readTeamContact(
  db: Db,
): Promise<{ readonly telegram: string | null; readonly phone: string | null }> {
  try {
    const rows = await withActor(db, GUEST, (trx) =>
      trx.selectFrom("app.settings").select(["key", "value"]).where("key", "in", TEAM_CONTACT_KEYS).execute(),
    );
    const value = (key: TeamContactKey) => {
      const raw = rows.find((row) => row.key === key)?.value;
      return typeof raw === "string" && raw !== "" ? raw : null;
    };
    return { telegram: value("team_telegram"), phone: value("team_phone") };
  } catch (err) {
    console.warn("auth.methods: team contact unavailable", err instanceof Error ? err.name : typeof err);
    return { telegram: null, phone: null };
  }
}
