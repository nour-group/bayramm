// Права ролей панели оператора: таблица прав и то, что каждый маршрут /staff/*
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

// Ожидаемые права ролей: кто заполняет карточку — не публикует её;
// телефоны клиентов — только администратор
const SPEC: Record<Permission, readonly StaffRole[]> = {
  "catalog.read": ["admin", "manager", "moderator"],
  "vendors.write": ["admin", "manager"],
  "vendors.delete": ["admin"],
  "vendor_users.write": ["admin", "manager"],
  "listings.write": ["admin", "manager"],
  "listings.submit": ["admin", "manager"],
  "listings.publish": ["admin", "moderator"],
  "listings.moderate": ["admin", "moderator"],
  "listings.draft": ["admin", "manager", "moderator"],
  "listings.delete": ["admin", "manager"],
  "photos.moderate": ["admin", "moderator"],
  "vendor_phones.read": ["admin", "manager", "moderator"],
  "requests.read": ["admin", "manager"],
  "requests.write": ["admin", "manager"],
  "client_phones.read": ["admin"],
  "clients.read": ["admin", "manager"],
  "clients.block": ["admin", "manager"],
  "outbox.read": ["admin", "manager"],
  "outbox.retry": ["admin"],
  "audit.read": ["admin"],
  "settings.write": ["admin"],
  "team.manage": ["admin"],
  "revisions.moderate": ["admin", "moderator"],
  "metrics.read": ["admin", "manager", "moderator"],
};

// Маршрут → право, которым он закрыт
const ROUTES: readonly [method: string, path: string, permission: Permission][] = [
  ["GET", "/dictionaries", "catalog.read"],
  ["GET", "/vendors", "catalog.read"],
  ["POST", "/vendors", "vendors.write"],
  ["GET", `/vendors/${ID}`, "catalog.read"],
  ["PATCH", `/vendors/${ID}`, "vendors.write"],
  ["DELETE", `/vendors/${ID}`, "vendors.delete"],
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
  ["DELETE", `/listings/${ID}`, "listings.delete"],
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
  ["POST", `/requests/${ID}/remind`, "requests.write"],
  ["POST", `/requests/${ID}/contacted`, "requests.write"],
  ["POST", `/requests/${ID}/notes`, "requests.write"],
  ["GET", "/revisions", "catalog.read"],
  ["GET", `/revisions/${ID}`, "catalog.read"],
  ["POST", `/revisions/${ID}/approve`, "revisions.moderate"],
  ["POST", `/revisions/${ID}/decline`, "revisions.moderate"],
  ["GET", "/clients", "clients.read"],
  ["GET", `/clients/${ID}`, "clients.read"],
  ["POST", `/clients/${ID}/phone`, "client_phones.read"],
  ["POST", `/clients/${ID}/block`, "clients.block"],
  ["POST", `/clients/${ID}/unblock`, "clients.block"],
  ["GET", "/outbox", "outbox.read"],
  ["POST", `/outbox/${ID}/retry`, "outbox.retry"],
  ["GET", "/audit", "audit.read"],
  ["GET", "/audit/pii", "audit.read"],
  ["GET", "/settings", "settings.write"],
  ["PUT", "/settings/sla_hours", "settings.write"],
  ["GET", "/team", "team.manage"],
  ["POST", "/team", "team.manage"],
  ["POST", `/team/${ID}/role`, "team.manage"],
  ["POST", `/team/${ID}/deactivate`, "team.manage"],
  ["POST", `/team/${ID}/activate`, "team.manage"],
  ["DELETE", `/team/${ID}`, "team.manage"],
  ["GET", "/metrics", "metrics.read"],
  ["GET", "/metrics/vendors", "metrics.read"],
  ["GET", `/metrics/vendors/${ID}`, "metrics.read"],
];

function appAs(role: StaffRole) {
  const accountId = "acacacac-0000-0000-0000-000000000001";
  const session = {
    sessionId: "11111111-0000-0000-0000-000000000001",
    accountId,
    app: "admin",
    via: "staff_elevation",
    proofAt: new Date(),
    accountDisabledAt: null,
    accountDeletedAt: null,
    clientId: null,
    clientBlocked: null,
    clientDeleted: null,
    staffId: "00000000-0000-0000-0000-00000000a001",
    staffRole: role,
    staffActive: true,
    staffAccountId: accountId,
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
  it("совпадают с ожидаемой таблицей прав", () => {
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

  it("команда, настройки, журнал, повтор уведомлений и удаление вендора — только администратору", () => {
    for (const permission of [
      "team.manage",
      "settings.write",
      "audit.read",
      "outbox.retry",
      "vendors.delete",
    ] as const) {
      expect(
        ROLES.filter((role) => can(role, permission)),
        permission,
      ).toEqual(["admin"]);
    }
  });

  it("с заявками и клиентами работают администратор и менеджер, правки карточек решает модератор", () => {
    expect(can("manager", "requests.write")).toBe(true);
    expect(can("moderator", "requests.write")).toBe(false);
    expect(can("moderator", "clients.read")).toBe(false);
    expect(can("moderator", "revisions.moderate")).toBe(true);
    expect(can("manager", "revisions.moderate")).toBe(false);
  });

  it("витрину удаляют те, кто её заполняет (администратор, менеджер); модератор — нет", () => {
    expect(ROLES.filter((role) => can(role, "listings.delete"))).toEqual(["admin", "manager"]);
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
