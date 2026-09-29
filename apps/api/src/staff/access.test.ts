// Права ролей панели оператора: таблица из ТЗ и то, что каждый маршрут /staff/*
// закрыт нужным правом. Отказ — 403 до любого запроса к базе, кроме поиска сессии.

import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticate, requireStaff } from "../auth/session";
import type { StaffRole } from "../db/actor";
import type { AppEnv } from "../env";
import { handleError } from "../errors";
import { sections } from "../routes/staff";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { makeEnv } from "../testing/worker";
import { can, PERMISSIONS, type Permission, permissionsOf } from "./access";

const ID = "aaaaaaaa-0000-0000-0000-000000000001";
const ROLES: readonly StaffRole[] = ["admin", "manager", "moderator"];

// Таблица прав из ТЗ панели (§6): кто заполняет карточку — не публикует её;
// телефоны клиентов — только администратор
const SPEC: Record<Permission, readonly StaffRole[]> = {
  "catalog.read": ["admin", "manager", "moderator"],
  "vendors.write": ["admin", "manager"],
  "vendor_users.write": ["admin", "manager"],
  "listings.write": ["admin", "manager"],
  "listings.submit": ["admin", "manager"],
  "listings.publish": ["admin", "moderator"],
  "listings.moderate": ["admin", "moderator"],
  "listings.draft": ["admin", "manager", "moderator"],
  "photos.moderate": ["admin", "moderator"],
  "vendor_phones.read": ["admin", "manager", "moderator"],
  "requests.read": ["admin", "manager"],
  "client_phones.read": ["admin"],
};

// Маршрут → право, которым он закрыт
const ROUTES: readonly [method: string, path: string, permission: Permission][] = [
  ["GET", "/dictionaries", "catalog.read"],
  ["GET", "/vendors", "catalog.read"],
  ["POST", "/vendors", "vendors.write"],
  ["GET", `/vendors/${ID}`, "catalog.read"],
  ["PATCH", `/vendors/${ID}`, "vendors.write"],
  ["POST", `/vendors/${ID}/checklist`, "vendors.write"],
  ["POST", `/vendors/${ID}/phones`, "vendor_phones.read"],
  ["POST", `/vendors/${ID}/users`, "vendor_users.write"],
  ["PATCH", `/vendors/${ID}/users/${ID}`, "vendor_users.write"],
  ["POST", `/vendors/${ID}/users/${ID}/disable`, "vendor_users.write"],
  ["POST", `/vendors/${ID}/users/${ID}/enable`, "vendor_users.write"],
  ["POST", `/vendors/${ID}/users/${ID}/unlink`, "vendor_users.write"],
  ["POST", `/vendors/${ID}/users/${ID}/phone`, "vendor_phones.read"],
  ["GET", "/listings", "catalog.read"],
  ["POST", "/listings", "listings.write"],
  ["GET", `/listings/${ID}`, "catalog.read"],
  ["PATCH", `/listings/${ID}`, "listings.write"],
  ["POST", `/listings/${ID}/submit`, "listings.submit"],
  ["POST", `/listings/${ID}/publish`, "listings.publish"],
  ["POST", `/listings/${ID}/suspend`, "listings.moderate"],
  ["POST", `/listings/${ID}/reject`, "listings.moderate"],
  ["POST", `/listings/${ID}/draft`, "listings.draft"],
  ["POST", `/listings/${ID}/phone`, "vendor_phones.read"],
  ["GET", `/listings/${ID}/photos`, "catalog.read"],
  ["POST", `/listings/${ID}/photos`, "listings.write"],
  ["PUT", `/listings/${ID}/photos/order`, "listings.write"],
  ["POST", `/listings/${ID}/photos/${ID}/cover`, "listings.write"],
  ["POST", `/listings/${ID}/photos/${ID}/moderation`, "photos.moderate"],
  ["DELETE", `/listings/${ID}/photos/${ID}`, "listings.write"],
  ["GET", `/listings/${ID}/availability`, "catalog.read"],
  ["PUT", `/listings/${ID}/availability`, "listings.write"],
  ["GET", "/requests", "requests.read"],
  ["GET", `/requests/${ID}`, "requests.read"],
  ["POST", `/requests/${ID}/client-phone`, "client_phones.read"],
  ["POST", `/requests/${ID}/vendor-phone`, "requests.read"],
];

function appAs(role: StaffRole) {
  const session = {
    sessionId: "11111111-0000-0000-0000-000000000001",
    clientId: null,
    blocked_at: null,
    deleted_at: null,
    staffId: "00000000-0000-0000-0000-00000000a001",
    staffRole: role,
    staffActive: true,
  };
  const fake = fakeDb((q: RecordedQuery) => (q.sql.includes('from "app"."sessions"') ? [session] : []));
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("db", fake.db);
    await next();
  });
  app.use(authenticate, requireStaff());
  app.route("/", sections);
  app.onError(handleError);
  return { app, fake };
}

async function request(role: StaffRole, method: string, path: string) {
  const { app, fake } = appAs(role);
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${"t".repeat(43)}`, "content-type": "application/json" },
  };
  if (method !== "GET" && method !== "DELETE") init.body = "{}";
  const res = await app.request(path, init, makeEnv());
  // Поиск сессии (под актором system) — не в счёт: он до проверки прав
  const auth = (q: RecordedQuery) => q.sql.includes('from "app"."sessions"') || q.parameters[0] === "system";
  return { res, queries: fake.queries.filter((q) => !auth(q)) };
}

afterEach(() => vi.restoreAllMocks());

describe("права ролей", () => {
  it("совпадают с таблицей из ТЗ", () => {
    expect(PERMISSIONS).toEqual(SPEC);
  });

  it("менеджер заполняет и отправляет на проверку, но не публикует", () => {
    expect(can("manager", "listings.submit")).toBe(true);
    expect(can("manager", "listings.publish")).toBe(false);
    expect(can("moderator", "listings.publish")).toBe(true);
    expect(can("moderator", "listings.write")).toBe(false);
  });

  it("телефон клиента — только администратору", () => {
    expect(ROLES.filter((role) => can(role, "client_phones.read"))).toEqual(["admin"]);
  });

  it("администратор может всё", () => {
    expect(permissionsOf("admin")).toEqual(Object.keys(SPEC));
  });
});

describe("маршруты /staff/* закрыты правами", () => {
  const cases = ROUTES.flatMap(([method, path, permission]) =>
    ROLES.map((role) => [role, method, path, SPEC[permission].includes(role)] as const),
  );

  it.each(cases)("%s: %s %s — доступ %s", async (role, method, path, allowed) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { res, queries } = await request(role, method, path);
    if (allowed) {
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    } else {
      expect(res.status).toBe(403);
      // Отказ — до обработчика: ни одного запроса к данным
      expect(queries).toEqual([]);
    }
  });

  it("чужой путь или кривой id — 404 без запроса к базе", async () => {
    const { res, queries } = await request("admin", "GET", "/listings/not-a-uuid");
    expect(res.status).toBe(404);
    expect(queries).toEqual([]);
  });
});
