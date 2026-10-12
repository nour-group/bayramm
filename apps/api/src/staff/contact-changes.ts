// Запросы партнёров на смену публичных контактов витрины — решение команды. Контракт —
// @bayramm/shared/api/staff (ContactChange…).
//
//   GET  /staff/listings/:id/contact-change                 ждущий запрос или null — без значений (catalog.read)
//   POST /staff/listings/:id/contact-change/reveal { reason? } значения запроса и нынешние контакты (в журнал)
//   POST /staff/listings/:id/contact-change/approve         применить к витрине
//   POST /staff/listings/:id/contact-change/decline { reason } отклонить — причину увидит партнёр
//   GET  /staff/contact-changes?limit=&offset=              очередь ждущих запросов, старые сверху
//
// Партнёр просит сменить телефон и Telegram витрины, которая на проверке или на сайте
// (vendor/contacts.ts): клиенты до решения видят прежние контакты. Номер — ПДн: список и
// состояние его не несут, значения отдаёт только «Показать» — функция базы пишет чтение в
// журнал доступа к ПДн (кто, когда, зачем). Решают те, кто решает по правкам карточек
// (revisions.moderate: администратор, модератор) — база проверяет роль ещё раз. Журнал
// действий — id и поля, без номеров; к ПДн обращается только модуль ПДн (db/pii)

import type {
  ContactChange,
  ContactChangeList,
  ContactChangeResponse,
  ContactChangeReveal,
} from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { staffOf } from "../auth/session";
import { type Tx, withActor } from "../db/actor";
import {
  approveContactChange,
  type ContactChangeState,
  contactChangeState,
  declineContactChange,
  listContactChanges,
  readContactChange,
  readListingContacts,
} from "../db/pii";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { requirePermission } from "./access";
import { Input, invalidInput, limitJson, paging, readBody } from "./input";
import { iso, pathId } from "./shared";
import { readReason } from "./vendors";

/** Причина отказа — как в базе (столбец reason таблицы запросов) */
export const CONTACT_REASON_MAX = 500;

export const contactChanges = new Hono<AppEnv>();
export const contactChangeQueue = new Hono<AppEnv>();

async function listingExists(trx: Tx, id: string): Promise<void> {
  const found = await trx.selectFrom("app.listings").select("id").where("id", "=", id).executeTakeFirst();
  if (!found) throw notFound();
}

const notPending = () =>
  new ApiError(409, "contact_change_not_pending", "There is no pending contact change for this listing");

/** Ждущий запрос без значений; решённый или отозванный — null */
function pendingView(state: ContactChangeState | null): ContactChange | null {
  if (state === null || state.status !== "pending") return null;
  return {
    id: state.id,
    submittedAt: iso(state.submittedAt),
    phoneChanged: state.phoneChanged,
    telegramChanged: state.telegramChanged,
  };
}

contactChanges.get("/:id/contact-change", requirePermission("catalog.read"), async (c) => {
  const id = pathId(c.req.param("id"));
  const change = await withActor(c.var.db, staffOf(c), async (trx) => {
    await listingExists(trx, id);
    return pendingView(await contactChangeState(trx, id));
  });
  return c.json({ change } satisfies ContactChangeResponse);
});

// «Показать»: значения запроса и то, что у витрины сейчас, — одним ответом, чтобы решить «было → стало»
contactChanges.post(
  "/:id/contact-change/reveal",
  requirePermission("revisions.moderate"),
  limitJson,
  async (c) => {
    const id = pathId(c.req.param("id"));
    const reason = await readReason(c.req.raw);
    const body = await withActor(c.var.db, staffOf(c), async (trx) => {
      await listingExists(trx, id);
      const asked = await readContactChange(trx, id, reason);
      if (asked === null) throw notPending();
      const current = await readListingContacts(trx, id, reason);
      return { phone: asked.phone, telegram: asked.telegram, current } satisfies ContactChangeReveal;
    });
    return c.json(body);
  },
);

contactChanges.post("/:id/contact-change/approve", requirePermission("revisions.moderate"), async (c) => {
  const id = pathId(c.req.param("id"));
  await withActor(c.var.db, staffOf(c), async (trx) => {
    await listingExists(trx, id);
    await approveContactChange(trx, id);
  });
  return c.json({ change: null } satisfies ContactChangeResponse);
});

contactChanges.post(
  "/:id/contact-change/decline",
  requirePermission("revisions.moderate"),
  limitJson,
  async (c) => {
    const id = pathId(c.req.param("id"));
    const input = new Input(await readBody(c.req.raw));
    const reason = input.text("reason", { max: CONTACT_REASON_MAX, multiline: true, required: true });
    input.done();
    if (typeof reason !== "string") throw invalidInput(["reason"]);
    await withActor(c.var.db, staffOf(c), async (trx) => {
      await listingExists(trx, id);
      await declineContactChange(trx, id, reason);
    });
    return c.json({ change: null } satisfies ContactChangeResponse);
  },
);

contactChangeQueue.get("/", requirePermission("revisions.moderate"), async (c) => {
  const { limit, offset } = paging((key) => c.req.query(key));
  const list = await withActor(c.var.db, staffOf(c), (trx) => listContactChanges(trx, limit, offset));
  const body: ContactChangeList = {
    total: list.total,
    items: list.items.map((row) => ({
      id: row.changeId,
      submittedAt: iso(row.submittedAt),
      phoneChanged: row.phoneChanged,
      telegramChanged: row.telegramChanged,
      listing: {
        id: row.listingId,
        name: row.listingName,
        status: row.listingStatus,
        categoryCode: row.categoryCode,
      },
      vendor: { id: row.vendorId, code: row.vendorCode },
    })),
  };
  return c.json(body);
});
