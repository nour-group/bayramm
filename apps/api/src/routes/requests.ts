// Заявки клиента (Authorization: Bearer <токен клиента> из POST /auth/telegram):
//
//   POST /requests                → 201 RequestCreated
//   GET  /requests                → 200 ClientRequests
//   POST /requests/:id/withdraw   → 200 ClientRequest
//
// Без токена — 401, сессия сотрудника — 403, чужая заявка — 404. Откуда пришла
// заявка (tma или web), говорит заголовок X-Bayramm-Source (CLIENT_SOURCE_HEADER
// контракта): "tma" шлёт Mini App внутри Telegram, всё остальное — web. Ответы
// с данными клиента не кэшируются.

import { CLIENT_SOURCE_HEADER, type ClientRequests, type ClientSource } from "@bayramm/shared/api";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authenticate, requireClient } from "../auth/session";
import { database } from "../db/middleware";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { outboxKick } from "../notify/kick";
import { parseCreateRequest } from "../requests/input";
import { createRequest, listClientRequests, withdrawRequest } from "../requests/service";
import { tashkentToday } from "../time";

// Заявка — пара сотен байт; комментарий до 1000 символов (до 4 байт каждый)
const MAX_BODY_BYTES = 16 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const limitBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json(new ApiError(413, "payload_too_large", "Request body is too large").toBody(), 413),
});

/** Источник по заголовку: только явное "tma" — Mini App, иначе сайт */
export function clientSource(header: string | undefined): ClientSource {
  return header?.trim().toLowerCase() === "tma" ? "tma" : "web";
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Body must be JSON");
  }
}

export const requests = new Hono<AppEnv>();

// Первым: и ответы с ошибкой входа (401/403) тоже не кэшируются
requests.use(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});
requests.use(database, authenticate);

// Уведомление вендору ставит триггер базы; outboxKick отправляет его сразу после ответа
requests.post("/", limitBody, outboxKick, async (c) => {
  const { actor } = requireClient(c);
  const input = parseCreateRequest(await readJson(c.req.raw), tashkentToday());
  const created = await createRequest(
    c.var.db,
    actor,
    input,
    clientSource(c.req.header(CLIENT_SOURCE_HEADER)),
  );
  return c.json(created, 201);
});

requests.get("/", async (c) => {
  const { actor } = requireClient(c);
  const items = await listClientRequests(c.var.db, actor);
  return c.json({ items } satisfies ClientRequests);
});

requests.post("/:id/withdraw", async (c) => {
  const { actor } = requireClient(c);
  const id = c.req.param("id");
  // Не uuid — такой заявки нет; до базы (там ::uuid упал бы с 22P02)
  if (!UUID_RE.test(id)) throw notFound();
  const request = await withdrawRequest(
    c.var.db,
    actor,
    id.toLowerCase(),
    clientSource(c.req.header(CLIENT_SOURCE_HEADER)),
  );
  return c.json(request);
});
