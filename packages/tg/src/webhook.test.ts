import { describe, expect, it } from "vitest";
import { verifyWebhookSecret, WEBHOOK_SECRET_HEADER } from "./index";

// Выдуманное значение для тестов
const EXPECTED = "aaaa_bbbb-cccc";

function update(headers: Record<string, string> = {}) {
  return new Request("https://api.example.test/tg/webhook", { method: "POST", headers, body: "{}" });
}

describe("verifyWebhookSecret", () => {
  it("совпадает → true", async () => {
    expect(await verifyWebhookSecret(update({ [WEBHOOK_SECRET_HEADER]: EXPECTED }), EXPECTED)).toBe(true);
  });

  it("имя заголовка без учёта регистра", async () => {
    const request = update({ "x-telegram-bot-api-secret-token": EXPECTED });
    expect(await verifyWebhookSecret(request, EXPECTED)).toBe(true);
  });

  it.each([
    ["другое значение", "aaaa_bbbb-cccd"],
    ["префикс секрета", "aaaa_bbbb"],
    ["секрет с хвостом", `${EXPECTED}x`],
    ["другой регистр", EXPECTED.toUpperCase()],
    ["пустой заголовок", ""],
  ])("%s → false", async (_name, value) => {
    expect(await verifyWebhookSecret(update({ [WEBHOOK_SECRET_HEADER]: value }), EXPECTED)).toBe(false);
  });

  it("нет заголовка → false", async () => {
    expect(await verifyWebhookSecret(update(), EXPECTED)).toBe(false);
  });

  it.each(["", "with space", "a".repeat(257), "кириллица"])(
    "ожидаемый секрет %j не годится для setWebhook → исключение",
    async (secret) => {
      await expect(
        verifyWebhookSecret(update({ [WEBHOOK_SECRET_HEADER]: EXPECTED }), secret),
      ).rejects.toThrow();
    },
  );
});
