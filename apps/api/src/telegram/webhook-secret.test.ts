import { createHmac, randomBytes } from "node:crypto";
import { verifyWebhookSecret, WEBHOOK_SECRET_HEADER } from "@bayramm/tg";
import { describe, expect, it } from "vitest";
import { telegramIdHash, toBase64Url } from "../auth/crypto";
import { webhookSecret } from "./webhook-secret";

// Свой ключ на каждый прогон
const KEY = randomBytes(32).toString("base64url");

describe("webhookSecret", () => {
  it("HMAC-SHA256(ID_HASH_KEY, «telegram-webhook:v1») в base64url", async () => {
    const expected = createHmac("sha256", KEY).update("telegram-webhook:v1").digest("base64url");
    expect(await webhookSecret(KEY)).toBe(expected);
  });

  it("годится для setWebhook: 1–256 символов из [A-Za-z0-9_-], и его принимает проверка @bayramm/tg", async () => {
    const secret = await webhookSecret(KEY);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const request = new Request("https://api.example/telegram/webhook", {
      headers: { [WEBHOOK_SECRET_HEADER]: secret },
    });
    await expect(verifyWebhookSecret(request, secret)).resolves.toBe(true);
  });

  it("не совпадает ни с ключом, ни с псевдонимами; зависит от ключа", async () => {
    const secret = await webhookSecret(KEY);
    expect(secret).not.toContain(KEY);
    expect(secret).not.toBe(toBase64Url(await telegramIdHash(KEY, 1)));
    expect(await webhookSecret(`${KEY}x`)).not.toBe(secret);
  });

  it("без ключа — ошибка настройки", async () => {
    await expect(webhookSecret("")).rejects.toThrow(/ID_HASH_KEY/);
  });
});
