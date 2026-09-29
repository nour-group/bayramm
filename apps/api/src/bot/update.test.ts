import { describe, expect, it } from "vitest";
import { parseUpdate } from "./update";

const USER = { id: 5001, is_bot: false, first_name: "Test", language_code: "ru" };
const CHAT = { id: 5001, type: "private" };

const update = (message: Record<string, unknown>, updateId = 100) => ({
  update_id: updateId,
  message: { message_id: 1, date: 1, chat: CHAT, from: USER, ...message },
});

describe("parseUpdate", () => {
  it("/start — команда без параметра", () => {
    expect(parseUpdate(update({ text: "/start" }))).toEqual({
      updateId: 100,
      chatId: 5001,
      from: { id: 5001, languageCode: "ru" },
      message: { kind: "start", payload: null },
    });
  });

  it.each([
    ["/start partner", "partner"],
    ["/start@example_test_bot partner", "partner"],
    ["  /start   partner  ", "partner"],
    ["/start vendor_toyxona-1", "vendor_toyxona-1"],
  ])("%s — параметр %s", (text, payload) => {
    expect(parseUpdate(update({ text }))?.message).toEqual({ kind: "start", payload });
  });

  it.each(["/starting", "/start two words", "hello", "/help"])("%s — другое сообщение", (text) => {
    expect(parseUpdate(update({ text }))?.message).toEqual({ kind: "other" });
  });

  it("контакт: номер и чей он (user_id)", () => {
    expect(
      parseUpdate(update({ contact: { phone_number: "998901234567", first_name: "X", user_id: 5001 } }))
        ?.message,
    ).toEqual({ kind: "contact", userId: 5001, phone: "998901234567" });
    expect(
      parseUpdate(update({ contact: { phone_number: "998901234567", first_name: "X" } }))?.message,
    ).toEqual({
      kind: "contact",
      userId: null,
      phone: "998901234567",
    });
  });

  it("без языка Telegram — undefined; сообщение без текста — other", () => {
    const parsed = parseUpdate(update({ from: { id: 5001, is_bot: false, first_name: "X" }, sticker: {} }));
    expect(parsed?.from).toEqual({ id: 5001, languageCode: undefined });
    expect(parsed?.message).toEqual({ kind: "other" });
  });

  it.each([
    ["не объект", "update"],
    ["без update_id", { message: update({}).message }],
    ["дробный update_id", { ...update({ text: "/start" }), update_id: 1.5 }],
    ["отрицательный update_id", { ...update({ text: "/start" }), update_id: -1 }],
    ["не сообщение (edited_message)", { update_id: 1, edited_message: update({}).message }],
    ["группа", update({ text: "/start", chat: { id: -100123, type: "supergroup" } })],
    ["канал", update({ text: "/start", chat: { id: -100123, type: "channel" } })],
    ["от бота", update({ text: "/start", from: { ...USER, is_bot: true } })],
    ["чат не того пользователя", update({ text: "/start", chat: { id: 5002, type: "private" } })],
    ["без from", { update_id: 1, message: { message_id: 1, chat: CHAT, text: "/start" } }],
    ["контакт без номера", update({ contact: { first_name: "X", user_id: 5001 } })],
  ])("%s — null (200 без действий)", (_name, body) => {
    expect(parseUpdate(body)).toBeNull();
  });
});
