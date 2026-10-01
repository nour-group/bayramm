import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { DatabaseError } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, BUSINESS_RULES, handleError, isPgError, type PgError, toApiError } from "./errors";

// Настоящий класс ошибки из pg — поля заполняем, как это делает разбор протокола
function pgError(code: string, extra: Partial<Omit<PgError, "code">> = {}): DatabaseError {
  const err = new DatabaseError(extra.message ?? "db error", 0, "error");
  Object.assign(err, { severity: "ERROR", code, ...extra });
  return err;
}

function mapped(err: unknown) {
  const e = toApiError(err);
  return { status: e.status, code: e.code, details: e.details };
}

afterEach(() => vi.restoreAllMocks());

describe("isPgError", () => {
  it("узнаёт DatabaseError из pg", () => {
    expect(isPgError(pgError("23505"))).toBe(true);
    expect(isPgError(pgError("BR001"))).toBe(true);
  });

  it("не путает с системной ошибкой Node и произвольными объектами", () => {
    expect(isPgError(Object.assign(new Error("pipe"), { code: "EPIPE" }))).toBe(false);
    expect(isPgError({ code: "23505", severity: "ERROR" })).toBe(false);
    expect(isPgError(Object.assign(new Error("x"), { code: "ECONNREFUSED", severity: "ERROR" }))).toBe(false);
  });
});

describe("toApiError: коды Postgres", () => {
  it("23505 → 409 conflict; дубликат заявки — отдельный код", () => {
    expect(mapped(pgError("23505", { constraint: "sessions_token_hash_key" }))).toMatchObject({
      status: 409,
      code: "conflict",
    });
    expect(mapped(pgError("23505", { constraint: "requests_client_listing_date_uq" }))).toMatchObject({
      status: 409,
      code: "duplicate_request",
    });
    expect(mapped(pgError("23505", { constraint: "photos_dedupe" }))).toMatchObject({
      status: 409,
      code: "duplicate_photo",
    });
  });

  it.each([
    ["listings_slug_key", "slug_taken"],
    ["vendor_contacts_stir_key", "stir_taken"],
    ["vendor_users_vendor_phone_key", "phone_taken"],
    ["staff_phone_active", "staff_phone_taken"],
    ["listing_revisions_one_pending", "revision_pending"],
  ])("23505 %s → 409 %s: панель объясняет, что именно занято", (constraint, code) => {
    expect(mapped(pgError("23505", { constraint }))).toMatchObject({ status: 409, code });
  });

  it("42501 (RLS, права) и 23503 → 404: существование чужого не подтверждаем", () => {
    const rls = pgError("42501", {
      message: 'new row violates row-level security policy for table "sessions"',
    });
    expect(mapped(rls)).toMatchObject({ status: 404, code: "not_found" });
    expect(mapped(pgError("23503"))).toMatchObject({ status: 404, code: "not_found" });
  });

  it("бизнес-правила BR0xx → стабильные коды", () => {
    expect(mapped(pgError("BR001"))).toMatchObject({ status: 409, code: "append_only" });
    expect(mapped(pgError("BR002"))).toMatchObject({ status: 409, code: "illegal_transition" });
    expect(mapped(pgError("BR003"))).toMatchObject({ status: 403, code: "forbidden_for_actor" });
    expect(mapped(pgError("BR006"))).toMatchObject({ status: 422, code: "immutable_column" });
    expect(mapped(pgError("BR007"))).toMatchObject({ status: 409, code: "listing_not_active" });
    expect(mapped(pgError("BR008"))).toMatchObject({ status: 403, code: "client_blocked" });
    expect(mapped(pgError("BR009"))).toMatchObject({ status: 422, code: "consent_required" });
    expect(mapped(pgError("BR013"))).toMatchObject({ status: 409, code: "consent_text_not_current" });
    expect(mapped(pgError("BR014"))).toMatchObject({ status: 429, code: "daily_request_limit" });
    expect(mapped(pgError("BR015"))).toMatchObject({ status: 422, code: "guests_over_capacity" });
  });

  it("каждое правило — 4xx", () => {
    for (const [sqlstate, rule] of Object.entries(BUSINESS_RULES)) {
      const e = toApiError(pgError(sqlstate));
      expect(e.status, sqlstate).toBeGreaterThanOrEqual(400);
      expect(e.status, sqlstate).toBeLessThan(500);
      expect(e.code).toBe(rule.code);
    }
  });

  it("publish_blocked отдаёт недостающие пункты, мусор из DETAIL — нет", () => {
    expect(mapped(pgError("BR004", { detail: "price,photos,contract" }))).toEqual({
      status: 422,
      code: "publish_blocked",
      details: ["price", "photos", "contract"],
    });
    expect(mapped(pgError("BR004", { detail: "price,<script>,Photos" })).details).toEqual(["price"]);
    expect(mapped(pgError("BR004")).details).toEqual([]);
  });

  it("неизвестный BR-код — 422, а не 500", () => {
    expect(mapped(pgError("BR999"))).toMatchObject({ status: 422, code: "rule_violation" });
  });

  it("неверные данные (check, not null, класс 22) → 422 invalid_input", () => {
    for (const code of ["23514", "23502", "22P02", "22001", "22003", "22007"]) {
      expect(mapped(pgError(code)), code).toMatchObject({ status: 422, code: "invalid_input" });
    }
  });

  it("база недоступна или перегружена → 503", () => {
    for (const code of ["08006", "08001", "57014", "57P01", "53300"]) {
      expect(mapped(pgError(code)), code).toMatchObject({ status: 503, code: "service_unavailable" });
    }
  });

  it("прочие ошибки базы — 500", () => {
    expect(mapped(pgError("42P01"))).toMatchObject({ status: 500, code: "internal_error" });
    expect(mapped(pgError("XX000"))).toMatchObject({ status: 500, code: "internal_error" });
  });
});

describe("toApiError: прочее", () => {
  it("ApiError проходит как есть", () => {
    const err = new ApiError(418, "teapot", "short and stout");
    expect(toApiError(err)).toBe(err);
  });

  it("дополнительные поля — рядом с error и не подменяют его", () => {
    const err = new ApiError(409, "duplicate_request", "exists", undefined, { existingId: "r1", error: "x" });
    expect(err.toBody()).toEqual({
      existingId: "r1",
      error: { code: "duplicate_request", message: "exists" },
    });
    expect(new ApiError(400, "bad", "bad", ["guests"]).toBody()).toEqual({
      error: { code: "bad", message: "bad", details: ["guests"] },
    });
  });

  it("HTTPException из middleware Hono → код по статусу", () => {
    expect(mapped(new HTTPException(413))).toMatchObject({ status: 413, code: "payload_too_large" });
    expect(mapped(new HTTPException(401))).toMatchObject({ status: 401, code: "unauthorized" });
    expect(mapped(new HTTPException(400))).toMatchObject({ status: 400, code: "invalid_request" });
    expect(mapped(new HTTPException(502))).toMatchObject({ status: 500, code: "internal_error" });
  });

  it("любая другая ошибка — 500 internal_error", () => {
    expect(mapped(new TypeError("boom"))).toMatchObject({ status: 500, code: "internal_error" });
    expect(mapped("string thrown")).toMatchObject({ status: 500, code: "internal_error" });
  });
});

describe("handleError", () => {
  function appThrowing(err: unknown) {
    const app = new Hono();
    app.get("/", () => {
      throw err;
    });
    app.onError(handleError);
    return app;
  }

  it("отвечает в едином формате { error: { code, message } }", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await appThrowing(pgError("BR002")).request("/");
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({
      error: { code: "illegal_transition", message: "Status transition is not allowed" },
    });
  });

  it("не отдаёт и не пишет в лог DETAIL и текст ошибки базы — там бывают значения", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = pgError("23505", {
      message: 'duplicate key value violates unique constraint "client_profiles_telegram_id_key"',
      detail: "Key (telegram_id)=(100000001) already exists.",
      constraint: "client_profiles_telegram_id_key",
      schema: "pii",
      table: "client_profiles",
    });
    const res = await appThrowing(err).request("/");
    const text = await res.text();
    expect(res.status).toBe(409);
    expect(text).not.toContain("100000001");
    expect(text).not.toContain("telegram_id");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("100000001");
    expect(warn.mock.calls[0]?.[1]).toEqual({
      sqlstate: "23505",
      constraint: "client_profiles_telegram_id_key",
      table: "pii.client_profiles",
      column: undefined,
    });
  });

  it("500 без подробностей наружу", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await appThrowing(new Error("connect to db.internal:5432 failed")).request("/");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("db.internal");
    expect(JSON.parse(text)).toEqual({ error: { code: "internal_error", message: "Internal error" } });
    expect(error).toHaveBeenCalled();
  });
});

// Список BR-кодов живёт в миграциях. Новый код без перевода в HTTP — тест красный
describe("BR-коды совпадают с миграциями", () => {
  const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
  const sources = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(migrationsDir, f), "utf8"));

  it("каждый errcode = 'BRxxx' из миграций есть в BUSINESS_RULES", () => {
    const raised = new Set(
      sources.flatMap((s) => [...s.matchAll(/errcode\s*=\s*'(BR\d{3})'/g)].map((m) => m[1])),
    );
    expect(raised.size).toBeGreaterThan(0);
    for (const code of raised) expect(BUSINESS_RULES, String(code)).toHaveProperty(String(code));
  });

  it("имена в заголовках миграций совпадают с кодами API", () => {
    // Блок «Коды ошибок …» в заголовке — до первой пустой строки комментария
    const headers = sources.flatMap((s) => [...s.matchAll(/Коды ошибок[\s\S]*?\n--\n/g)].map((m) => m[0]));
    const pairs = headers.flatMap((h) => [...h.matchAll(/(BR\d{3}) ([a-z_]+)/g)].map((m) => [m[1], m[2]]));
    expect(pairs.length).toBe(Object.keys(BUSINESS_RULES).length);
    for (const [sqlstate, name] of pairs) expect(BUSINESS_RULES[String(sqlstate)]?.code).toBe(name);
  });
});
