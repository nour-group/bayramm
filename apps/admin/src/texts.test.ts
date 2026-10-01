import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apiErrorText, t } from "./texts";

/* Коды ошибок API, которые может получить панель, — у каждого свой понятный текст, а не
   общий «что-то пошло не так». Коды берутся из исходников API: правила базы и уникальные
   ограничения (errors.ts) и ApiError модулей, через которые идут запросы /staff. Новый код
   там без текста здесь роняет тест. */

const API = new URL("../../api/src/", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, API), "utf8");

/** Модули, через которые идут запросы панели: разделы /staff, фото, календарь, сессия */
const STAFF_MODULES = [
  ...readdirSync(new URL("staff/", API))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => `staff/${name}`),
  "photos/service.ts",
  "calendar/version.ts",
  "auth/session.ts",
  "routes/staff.ts",
];

// Только клиентское приложение: заявки и согласия клиента. Панель их не получает
const CLIENT_ONLY = new Set([
  "duplicate_request",
  "daily_request_limit",
  "guests_over_capacity",
  "consent_required",
]);

function apiCodes(): string[] {
  const errors = source("errors.ts");
  const codes = new Set<string>();
  // Правила базы (BUSINESS_RULES), уникальные ограничения, коды HTTP по статусу
  for (const [, code] of errors.matchAll(/code: "([a-z_]+)"/g)) codes.add(code ?? "");
  for (const [, code] of errors.matchAll(/\d{3}: "([a-z_]+)"/g)) codes.add(code ?? "");
  for (const [, code] of errors.matchAll(/new ApiError\(\d{3}, "([a-z_]+)"/g)) codes.add(code ?? "");
  for (const path of STAFF_MODULES)
    for (const [, code] of source(path).matchAll(/new ApiError\(\d{3}, "([a-z_]+)"/g)) codes.add(code ?? "");
  return [...codes].filter((code) => code !== "" && !CLIENT_ONLY.has(code)).sort();
}

describe("тексты ошибок API", () => {
  it("код из API — свой текст; известных кодов много", () => {
    const codes = apiCodes();
    expect(codes.length).toBeGreaterThan(40);
    const missing = codes.filter((code) => t.api[code] === undefined);
    expect(missing).toEqual([]);
  });

  it("неизвестный код — общий текст, а не сам код", () => {
    expect(apiErrorText("something_new")).toBe(t.api.unknown);
  });

  it("тексты — для людей: без кодов и подчёркиваний", () => {
    for (const [code, text] of Object.entries(t.api)) {
      expect(text, code).not.toMatch(/[a-z]+_[a-z]+/);
      expect(text.length, code).toBeGreaterThan(5);
    }
  });
});
