// Бот на настоящем Postgres, ролью bayramm_api: вебхук (/start, привязка вендора по
// контакту, повтор update_id) и отправитель outbox с оповещением о недоставленном.
// Telegram подменён fetch'ем
import { createHmac, randomInt, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_TEXTS, STAFF_TEXTS } from "../../src/bot/texts";
import { createDb } from "../../src/db/client";
import { dispatchOutbox } from "../../src/notify/outbox";
import { telegramClient } from "../../src/telegram/client";
import { webhookSecret } from "../../src/telegram/webhook-secret";
import {
  adminClient,
  apiDatabaseUrl,
  BOT_TOKEN,
  bearer,
  call,
  cleanup,
  cleanupStaff,
  ID_HASH_KEY,
  inviteStaff,
  loginToken,
  newStaffUsername,
  newTelegramUser,
  tgIdHash,
} from "./helpers";

const TG_PREFIX = `https://api.telegram.org/bot${BOT_TOKEN}/`;

let admin: Client;
let sent: { chat_id: number; text: string; reply_markup?: unknown }[];

// Вымышленные на каждый прогон: номер, Telegram ID вендора и сотрудника
const phone = `+99800${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
const vendorTgId = 6_000_000_000 + randomInt(0, 999_999_999);
const staffTgId = 6_000_000_000 + randomInt(0, 999_999_999);
const updateIds: number[] = [];
let vendorId: string;
let vendorUserId: string;
let staffId: string;

const phoneHash = (value: string) => createHmac("sha256", ID_HASH_KEY).update(value).digest();

function nextUpdateId(): number {
  const id = randomInt(1, 2 ** 40);
  updateIds.push(id);
  return id;
}

function message(fromId: number, patch: Record<string, unknown>) {
  return {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: fromId, type: "private" },
    from: { id: fromId, is_bot: false, first_name: "Test", language_code: "ru" },
    ...patch,
  };
}

async function webhook(update: Record<string, unknown>): Promise<Response> {
  return call("/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": await webhookSecret(ID_HASH_KEY),
    },
    body: JSON.stringify(update),
  });
}

beforeAll(async () => {
  admin = await adminClient();
  const account = await admin.query<{ id: string }>(
    "insert into app.vendor_accounts default values returning id",
  );
  vendorId = account.rows[0]?.id ?? "";
  const user = await admin.query<{ id: string }>(
    "insert into app.vendor_users (vendor_id, phone_hash) values ($1, $2) returning id",
    [vendorId, phoneHash(phone)],
  );
  vendorUserId = user.rows[0]?.id ?? "";
  await admin.query("insert into pii.vendor_user_profiles (vendor_user_id, phone) values ($1, $2)", [
    vendorUserId,
    phone,
  ]);
  // Администратор, уже вошедший в панель через Telegram
  staffId = await inviteStaff(admin, { username: newStaffUsername(), role: "admin" });
  await admin.query("update app.staff set tg_id_hash = $2, tg_linked_at = now() where id = $1", [
    staffId,
    tgIdHash(staffTgId),
  ]);
});

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (!url.startsWith(TG_PREFIX)) throw new Error(`неожиданный запрос: ${url}`);
      const params = JSON.parse(String(init.body)) as (typeof sent)[number];
      sent.push(params);
      return Response.json({ ok: true, result: { message_id: sent.length } });
    }),
  );
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await admin.query("delete from app.outbox where recipient_id = any($1::uuid[])", [[vendorUserId, staffId]]);
  await admin.query("delete from app.telegram_updates where update_id = any($1::bigint[])", [updateIds]);
  await admin.query("delete from app.vendor_users where id = $1", [vendorUserId]);
  await admin.query("delete from app.vendor_accounts where id = $1", [vendorId]);
  await cleanupStaff(admin);
  await cleanup(admin);
  await admin.end();
});

describe("вебхук: /start", () => {
  it("сотрудник пишет боту — чат для оповещений команды записан", async () => {
    const res = await webhook({ update_id: nextUpdateId(), message: message(staffTgId, { text: "/start" }) });
    expect(res.status).toBe(200);
    expect(sent.map((m) => m.text)).toEqual([STAFF_TEXTS.ru.staffCard("admin")]);
    const { rows } = await admin.query(
      "select telegram_chat_id from pii.staff_profiles where staff_id = $1",
      [staffId],
    );
    expect(rows[0]?.telegram_chat_id).toBe(String(staffTgId));
  });

  it("приглашение по имени пользователя принимается первым сообщением боту; /stats — сводка", async () => {
    const username = newStaffUsername();
    const invitedId = await inviteStaff(admin, { username, role: "manager" });
    const tgId = 6_000_000_000 + randomInt(0, 999_999_999);
    const from = { id: tgId, is_bot: false, first_name: "Test", language_code: "uz", username };
    const res = await webhook({
      update_id: nextUpdateId(),
      message: { ...message(tgId, { text: "/start" }), from },
    });
    expect(res.status).toBe(200);
    expect(sent.map((m) => m.text)).toEqual([STAFF_TEXTS.uz.staffCard("manager")]);
    const { rows } = await admin.query(
      "select s.tg_linked_at is not null as linked, p.telegram_chat_id from app.staff s join pii.staff_profiles p on p.staff_id = s.id where s.id = $1",
      [invitedId],
    );
    expect(rows[0]?.linked).toBe(true);
    expect(rows[0]?.telegram_chat_id).toBe(String(tgId));

    sent = [];
    await webhook({ update_id: nextUpdateId(), message: { ...message(tgId, { text: "/stats" }), from } });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("Bayramm — qisqa hisobot");
  });

  it("чужое имя пользователя не даёт прав: не сотрудник — обычное приветствие, /stats без сводки", async () => {
    const tgId = 6_000_000_000 + randomInt(0, 999_999_999);
    const from = {
      id: tgId,
      is_bot: false,
      first_name: "Test",
      language_code: "ru",
      username: newStaffUsername(),
    };
    await webhook({ update_id: nextUpdateId(), message: { ...message(tgId, { text: "/stats" }), from } });
    expect(sent.map((m) => m.text)).toEqual([BOT_TEXTS.ru.welcome, BOT_TEXTS.ru.partnerPrompt]);
  });
});

describe("вебхук: язык ответа", () => {
  it("язык, сохранённый клиентом в профиле, главнее языка Telegram", async () => {
    const user = newTelegramUser({ language_code: "uz" });
    const token = await loginToken(user);
    const patched = await call("/me", {
      method: "PATCH",
      headers: { ...bearer(token).headers, "content-type": "application/json" },
      body: JSON.stringify({ locale: "ru" }),
    });
    expect(patched.status).toBe(200);
    const from = { id: user.id, is_bot: false, first_name: "Test", language_code: "uz" };
    await webhook({ update_id: nextUpdateId(), message: { ...message(user.id, { text: "/start" }), from } });
    expect(sent.map((m) => m.text)).toEqual([BOT_TEXTS.ru.welcome, BOT_TEXTS.ru.partnerPrompt]);
  });
});

describe("вебхук: привязка вендора по контакту", () => {
  const linked = async () =>
    (
      await admin.query<{
        tg_user_hash: Buffer | null;
        telegram_user_id: string | null;
        telegram_chat_id: string | null;
      }>(
        `select u.tg_user_hash, p.telegram_user_id, p.telegram_chat_id
         from app.vendor_users u join pii.vendor_user_profiles p on p.vendor_user_id = u.id where u.id = $1`,
        [vendorUserId],
      )
    ).rows[0];

  it("чужой контакт — отказ, ничего не записано", async () => {
    const res = await webhook({
      update_id: nextUpdateId(),
      message: message(vendorTgId, {
        contact: { phone_number: phone.slice(1), first_name: "X", user_id: vendorTgId + 1 },
      }),
    });
    expect(res.status).toBe(200);
    expect(sent.map((m) => m.text)).toEqual([BOT_TEXTS.ru.notOwnContact]);
    expect((await linked())?.tg_user_hash).toBeNull();
  });

  it("свой контакт — привязка; ответ с кнопкой кабинета; повтор update_id ничего не делает", async () => {
    const update = {
      update_id: nextUpdateId(),
      message: message(vendorTgId, {
        contact: { phone_number: phone.slice(1), first_name: "X", user_id: vendorTgId },
      }),
    };
    expect((await webhook(update)).status).toBe(200);
    expect(sent).toEqual([
      { chat_id: vendorTgId, text: BOT_TEXTS.ru.claimed, reply_markup: { remove_keyboard: true } },
      {
        chat_id: vendorTgId,
        text: BOT_TEXTS.ru.cabinetHint,
        reply_markup: {
          inline_keyboard: [[{ text: "Открыть кабинет", web_app: { url: "http://localhost:5174" } }]],
        },
      },
    ]);
    const row = await linked();
    expect(row?.tg_user_hash).toEqual(tgIdHash(vendorTgId));
    expect(row?.telegram_user_id).toBe(String(vendorTgId));
    expect(row?.telegram_chat_id).toBe(String(vendorTgId));

    sent = [];
    expect((await webhook(update)).status).toBe(200);
    expect(sent).toEqual([]);
  });

  it("другой аккаунт с тем же номером — отказ, привязка не меняется", async () => {
    const other = vendorTgId + 7;
    await webhook({
      update_id: nextUpdateId(),
      message: message(other, { contact: { phone_number: phone.slice(1), first_name: "X", user_id: other } }),
    });
    expect(sent.map((m) => m.text)).toEqual([BOT_TEXTS.ru.linkedElsewhere]);
    expect((await linked())?.tg_user_hash).toEqual(tgIdHash(vendorTgId));
  });

  it("привязанный вендор пишет /start — кнопка кабинета вместо просьбы о номере", async () => {
    await webhook({ update_id: nextUpdateId(), message: message(vendorTgId, { text: "/start partner" }) });
    expect(sent.map((m) => m.text)).toEqual([BOT_TEXTS.ru.vendorLinked]);
  });
});

describe("outbox: отправка и оповещение о недоставленном", () => {
  it("строку без заявки не собрать — dead; администратору с чатом уходит оповещение", async () => {
    const id = randomUUID();
    await admin.query(
      `insert into app.outbox (id, kind, recipient_kind, recipient_id, payload, dedupe_key)
       values ($1, 'vendor.request_new', 'vendor_user', $2, '{}', $3)`,
      [id, vendorUserId, `test:${id}`],
    );
    const db = createDb(apiDatabaseUrl);
    try {
      const deps = {
        db,
        telegram: telegramClient({ token: BOT_TOKEN }),
        urls: { webAppUrl: "http://localhost:5173", vendorAppUrl: "http://localhost:5174" },
      };
      const first = await dispatchOutbox(deps);
      expect(first).toMatchObject({ dead: 1, sent: 0 });
      expect(sent).toEqual([]);

      const { rows } = await admin.query(
        "select status, last_error, attempts from app.outbox where id = $1",
        [id],
      );
      expect(rows[0]).toEqual({ status: "dead", last_error: "skipped: bad_payload", attempts: 1 });

      const second = await dispatchOutbox(deps);
      expect(second).toMatchObject({ sent: 1, dead: 0 });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.chat_id).toBe(staffTgId);
      expect(sent[0]?.text).toContain("vendor.request_new");
      expect(sent[0]?.text).toContain("skipped: bad_payload");

      const alert = await admin.query(
        "select status, provider_msg_id from app.outbox where kind = 'ops.outbox_dead' and payload->>'outbox_id' = $1",
        [id],
      );
      expect(alert.rows).toEqual([{ status: "sent", provider_msg_id: "1" }]);

      // Больше отправлять нечего
      expect(await dispatchOutbox(deps)).toMatchObject({ claimed: 0 });
    } finally {
      await db.destroy();
    }
  });
});
