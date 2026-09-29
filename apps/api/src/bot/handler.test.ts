// Обработка сообщений бота без базы: fakeDb отвечает на отметку update_id и на
// функции app.telegram_started / app.vendor_user_claim_telegram
import { createHmac } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { fakeDb, type RecordedQuery } from "../testing/fake-db";
import { type BotConfig, type ClaimResult, handleUpdate } from "./handler";
import { BOT_TEXTS, STAFF_STARTED } from "./texts";
import type { BotUpdate } from "./update";

const KEY = "unit-test-id-hash-key-0123456789abcdef";
const CONFIG: BotConfig = {
  idHashKey: KEY,
  webAppUrl: "https://app.example",
  vendorAppUrl: "https://vendor.example",
};
const USER_ID = 5001;
const PHONE = "+998901234567";

const hmac = (message: string) => createHmac("sha256", KEY).update(message).digest();

interface DbState {
  /** update_id уже обработан */
  seen?: boolean;
  started?: { staff: boolean; vendor: boolean };
  claim?: ClaimResult;
}

function db(state: DbState = {}) {
  return fakeDb((q: RecordedQuery) => {
    if (q.sql.includes('insert into "app"."telegram_updates"')) return state.seen ? [] : [{ update_id: 1 }];
    if (q.sql.includes("app.telegram_started")) return [state.started ?? { staff: false, vendor: false }];
    if (q.sql.includes("app.vendor_user_claim_telegram")) {
      return [
        { result: state.claim ?? "not_found", vendor_user_id: state.claim === "claimed" ? "vu-1" : null },
      ];
    }
    return [];
  });
}

const start = (payload: string | null = null, languageCode = "uz"): BotUpdate => ({
  updateId: 100,
  chatId: USER_ID,
  from: { id: USER_ID, languageCode },
  message: { kind: "start", payload },
});

const contact = (
  phone = "998901234567",
  userId: number | null = USER_ID,
  languageCode = "ru",
): BotUpdate => ({
  updateId: 101,
  chatId: USER_ID,
  from: { id: USER_ID, languageCode },
  message: { kind: "contact", userId, phone },
});

let consoleSpies: MockInstance[];
const logged = () => consoleSpies.map((spy) => inspect(spy.mock.calls, { depth: 10 })).join("\n");

beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
});
afterEach(() => vi.restoreAllMocks());

describe("handleUpdate: повтор доставки", () => {
  it("update_id уже был — ничего не делаем и не отвечаем; отметка в той же транзакции", async () => {
    const fake = db({ seen: true });
    expect(await handleUpdate(fake.db, CONFIG, start())).toEqual([]);
    expect(fake.log.filter((entry) => !entry.includes("set_config"))).toEqual([
      "begin",
      expect.stringContaining('insert into "app"."telegram_updates"'),
      "commit",
    ]);
    expect(fake.queries[1]?.parameters).toEqual([100]);
  });

  it("контакт повтором — привязка не вызывается", async () => {
    const fake = db({ seen: true, claim: "claimed" });
    expect(await handleUpdate(fake.db, CONFIG, contact())).toEqual([]);
    expect(fake.queries.some((q) => q.sql.includes("vendor_user_claim_telegram"))).toBe(false);
  });
});

describe("handleUpdate: /start", () => {
  it("по-узбекски по умолчанию: приветствие с кнопкой Mini App и просьба к партнёрам с request_contact", async () => {
    const fake = db();
    const replies = await handleUpdate(fake.db, CONFIG, start(null, "en"));
    const t = BOT_TEXTS.uz;
    expect(replies).toEqual([
      {
        chat_id: USER_ID,
        text: t.welcome,
        reply_markup: { inline_keyboard: [[{ text: t.openApp, web_app: { url: "https://app.example" } }]] },
      },
      {
        chat_id: USER_ID,
        text: t.partnerPrompt,
        reply_markup: {
          keyboard: [[{ text: "Men hamkorman", request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      },
    ]);
    // /start отмечен под актором system с псевдонимом Telegram ID, а не с самим ID
    const started = fake.queries.find((q) => q.sql.includes("app.telegram_started"));
    expect(started?.parameters).toEqual([new Uint8Array(hmac(String(USER_ID))), USER_ID]);
    expect(fake.queries[0]?.parameters).toEqual(["system", "", ""]);
  });

  it("по-русски для ru", async () => {
    const replies = await handleUpdate(db().db, CONFIG, start(null, "ru-RU"));
    expect(replies.map((reply) => reply.text)).toEqual([BOT_TEXTS.ru.welcome, BOT_TEXTS.ru.partnerPrompt]);
    expect(replies[1]?.reply_markup).toMatchObject({
      keyboard: [[{ text: "Я партнёр", request_contact: true }]],
    });
  });

  it("/start partner — сразу просьба поделиться номером", async () => {
    const replies = await handleUpdate(db().db, CONFIG, start("partner"));
    expect(replies.map((reply) => reply.text)).toEqual([BOT_TEXTS.uz.partnerPrompt]);
  });

  it("привязанному вендору — кнопка кабинета вместо просьбы", async () => {
    const replies = await handleUpdate(
      db({ started: { staff: false, vendor: true } }).db,
      CONFIG,
      start("partner"),
    );
    expect(replies).toEqual([
      {
        chat_id: USER_ID,
        text: BOT_TEXTS.uz.vendorLinked,
        reply_markup: {
          inline_keyboard: [[{ text: "Kabinetni ochish", web_app: { url: "https://vendor.example" } }]],
        },
      },
    ]);
  });

  it("сотруднику — ещё и строка про оповещения команды", async () => {
    const replies = await handleUpdate(db({ started: { staff: true, vendor: false } }).db, CONFIG, start());
    expect(replies.at(-1)).toEqual({ chat_id: USER_ID, text: STAFF_STARTED });
  });

  it("любое другое сообщение — как /start", async () => {
    const other: BotUpdate = { ...start(), message: { kind: "other" } };
    const replies = await handleUpdate(db().db, CONFIG, other);
    expect(replies.map((reply) => reply.text)).toEqual([BOT_TEXTS.uz.welcome, BOT_TEXTS.uz.partnerPrompt]);
  });
});

describe("handleUpdate: контакт вендора", () => {
  it("свой номер найден — привязка: номер в нормальной форме, хэши; клавиатуру убрать, кнопка кабинета", async () => {
    const fake = db({ claim: "claimed" });
    const replies = await handleUpdate(fake.db, CONFIG, contact());
    const t = BOT_TEXTS.ru;
    expect(replies).toEqual([
      { chat_id: USER_ID, text: t.claimed, reply_markup: { remove_keyboard: true } },
      {
        chat_id: USER_ID,
        text: t.cabinetHint,
        reply_markup: {
          inline_keyboard: [[{ text: "Открыть кабинет", web_app: { url: "https://vendor.example" } }]],
        },
      },
    ]);
    const claim = fake.queries.find((q) => q.sql.includes("app.vendor_user_claim_telegram"));
    expect(claim?.parameters).toEqual([
      new Uint8Array(hmac(PHONE)),
      PHONE,
      new Uint8Array(hmac(String(USER_ID))),
      USER_ID,
      USER_ID,
    ]);
    // /start не отмечается: контакт — отдельный путь
    expect(fake.queries.some((q) => q.sql.includes("telegram_started"))).toBe(false);
  });

  it("уже привязан этим же аккаунтом — тот же ответ", async () => {
    const replies = await handleUpdate(db({ claim: "linked" }).db, CONFIG, contact());
    expect(replies.map((reply) => reply.text)).toEqual([BOT_TEXTS.ru.claimed, BOT_TEXTS.ru.cabinetHint]);
  });

  it.each([
    ["not_found", BOT_TEXTS.ru.notFound],
    ["linked_elsewhere", BOT_TEXTS.ru.linkedElsewhere],
    ["telegram_taken", BOT_TEXTS.ru.telegramTaken],
  ] as const)("%s — вежливый отказ, клавиатуру убрать", async (claim, text) => {
    const replies = await handleUpdate(db({ claim }).db, CONFIG, contact());
    expect(replies).toEqual([{ chat_id: USER_ID, text, reply_markup: { remove_keyboard: true } }]);
  });

  it("чужой контакт (или без user_id) — отказ без запроса к привязке, клавиатура снова", async () => {
    for (const userId of [5002, null]) {
      const fake = db({ claim: "claimed" });
      const replies = await handleUpdate(fake.db, CONFIG, contact("998901234567", userId));
      expect(replies).toEqual([
        {
          chat_id: USER_ID,
          text: BOT_TEXTS.ru.notOwnContact,
          reply_markup: expect.objectContaining({
            keyboard: [[{ text: "Я партнёр", request_contact: true }]],
          }),
        },
      ]);
      expect(fake.queries.some((q) => q.sql.includes("vendor_user_claim_telegram"))).toBe(false);
    }
  });

  it("не узбекский номер — «не найден» без запроса к привязке", async () => {
    const fake = db({ claim: "claimed" });
    const replies = await handleUpdate(fake.db, CONFIG, contact("79001234567"));
    expect(replies.map((reply) => reply.text)).toEqual([BOT_TEXTS.ru.notFound]);
    expect(fake.queries.some((q) => q.sql.includes("vendor_user_claim_telegram"))).toBe(false);
  });

  it("в логе нет ни номера, ни Telegram ID", async () => {
    for (const claim of ["claimed", "not_found", "linked_elsewhere"] as const) {
      await handleUpdate(db({ claim }).db, CONFIG, contact());
    }
    await handleUpdate(db().db, CONFIG, contact("998901234567", 5002));
    const log = logged();
    for (const secret of ["901234567", String(USER_ID)]) expect(log).not.toContain(secret);
  });
});
