// Права клиента на свои данные через HTTP, на настоящем Postgres ролью bayramm_api:
// выгрузка, отзыв согласия, удаление аккаунта и возврат при новом входе.
// Подробные правила (чужие данные, заявки, контакты) — pgTAP 12_platform_hardening
import { createHmac, randomInt, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminClient,
  bearer,
  call,
  cleanup,
  ID_HASH_KEY,
  loginToken,
  newTelegramUser,
  tgIdHash,
} from "./helpers";

let admin: Client;
// Тексты согласий и клиенты, которым тесты писали согласия, — для уборки
const textIds: string[] = [];
const consentSubjects: string[] = [];

beforeAll(async () => {
  admin = await adminClient();
});

afterAll(async () => {
  // Журнал согласий только на добавление: тестовые записи убираем, выключив
  // триггер на время одной транзакции (владелец таблиц — роль admin-подключения)
  if (consentSubjects.length > 0 || textIds.length > 0) {
    await admin.query("begin");
    await admin.query("alter table app.consents disable trigger consents_append_only");
    await admin.query("delete from app.consents where subject_id = any($1::uuid[])", [consentSubjects]);
    await admin.query("alter table app.consents enable trigger consents_append_only");
    await admin.query("delete from app.consent_texts where id = any($1::uuid[])", [textIds]);
    await admin.query("commit");
  }
  await cleanup(admin);
  await admin.end();
});

async function clientIdOf(telegramId: number): Promise<string> {
  const { rows } = await admin.query<{ id: string }>("select id from app.clients where tg_id_hash = $1", [
    tgIdHash(telegramId),
  ]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("клиент не найден");
  return id;
}

/** Действующее согласие на уведомления в боте, как его записал бы поток согласий */
async function grantBotNotifications(clientId: string): Promise<void> {
  if (textIds.length === 0) {
    const id = randomUUID();
    // Версия — случайная: (цель, версия, язык) уникальны, а база локальная и общая
    await admin.query(
      `insert into app.consent_texts (id, purpose, version, locale, body)
       values ($1, 'bot_notifications', $2, 'ru', 'Тестовый текст: уведомления в боте')`,
      [id, randomInt(100_000, 2_000_000_000)],
    );
    textIds.push(id);
  }
  consentSubjects.push(clientId);
  await admin.query(
    `insert into app.consents (subject_kind, subject_id, purpose, action, text_id, source)
     values ('client', $1, 'bot_notifications', 'grant', $2, 'tma')`,
    [clientId, textIds[0]],
  );
}

async function consentActions(clientId: string) {
  const { rows } = await admin.query<{ action: string; source: string; ip_hash: Buffer | null }>(
    "select action, source, ip_hash from app.consents where subject_id = $1 order by created_at",
    [clientId],
  );
  return rows;
}

function withdraw(token: string, body: unknown, headers: Record<string, string> = {}) {
  return call("/me/consents/withdraw", {
    method: "POST",
    headers: { ...bearer(token).headers, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("GET /me/export", () => {
  it("свои данные файлом JSON, без кэша", async () => {
    const user = newTelegramUser({ first_name: "Export", username: "export_user", language_code: "ru" });
    const token = await loginToken(user);
    const clientId = await clientIdOf(user.id);
    await grantBotNotifications(clientId);

    const res = await call("/me/export", bearer(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="bayramm-my-data-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");

    const doc = (await res.json()) as {
      version: number;
      account: { id: string; locale: string };
      profile: { telegramId: number; firstName: string; username: string; phone: string | null };
      consents: { purpose: string; action: string; source: string }[];
      requests: unknown[];
    };
    expect(doc.version).toBe(1);
    expect(doc.account).toMatchObject({ id: clientId, locale: "ru" });
    expect(doc.profile).toMatchObject({
      telegramId: user.id,
      firstName: "Export",
      username: "export_user",
      phone: null,
    });
    expect(doc.consents).toEqual([
      expect.objectContaining({ purpose: "bot_notifications", action: "grant" }),
    ]);
    expect(doc.requests).toEqual([]);
  });
});

describe("POST /me/consents/withdraw", () => {
  it("кривое тело — 400, журнал не меняется", async () => {
    const token = await loginToken(newTelegramUser());
    for (const body of [{}, { purpose: "vendor_contact" }, { purpose: "request_transfer" }]) {
      const res = await withdraw(token, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("отзыв пишет запись withdraw с псевдонимом IP; повтор — withdrawn: false", async () => {
    const user = newTelegramUser();
    const token = await loginToken(user);
    const clientId = await clientIdOf(user.id);

    // нечего отзывать
    expect(await (await withdraw(token, { purpose: "bot_notifications" })).json()).toEqual({
      withdrawn: false,
    });

    await grantBotNotifications(clientId);
    const ip = "198.51.100.23";
    const first = await withdraw(
      token,
      { purpose: "bot_notifications" },
      { "CF-Connecting-IP": ip, "X-Bayramm-Source": "tma" },
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ withdrawn: true });
    expect(await (await withdraw(token, { purpose: "bot_notifications" })).json()).toEqual({
      withdrawn: false,
    });

    const actions = await consentActions(clientId);
    expect(actions.map((a) => a.action)).toEqual(["grant", "withdraw"]);
    expect(actions[1]?.source).toBe("tma");
    expect(actions[1]?.ip_hash).toEqual(createHmac("sha256", ID_HASH_KEY).update(`ip:${ip}`).digest());
  });
});

describe("DELETE /me", () => {
  it("удаляет профиль, отзывает согласия и сессии; новый вход возвращает аккаунт", async () => {
    const user = newTelegramUser({ first_name: "Leaving" });
    const token = await loginToken(user);
    const otherToken = await loginToken(user);
    const clientId = await clientIdOf(user.id);
    await grantBotNotifications(clientId);

    const res = await call("/me", { method: "DELETE", ...bearer(token) });
    expect(res.status).toBe(204);

    // обе сессии больше не работают
    expect((await call("/me", bearer(token))).status).toBe(401);
    expect((await call("/me", bearer(otherToken))).status).toBe(401);

    const client = await admin.query<{ deleted: boolean; can_message: boolean }>(
      "select deleted_at is not null as deleted, can_message from app.clients where id = $1",
      [clientId],
    );
    expect(client.rows[0]).toEqual({ deleted: true, can_message: false });
    const profile = await admin.query("select 1 from pii.client_profiles where client_id = $1", [clientId]);
    expect(profile.rows).toHaveLength(0);
    const open = await admin.query("select 1 from app.sessions where client_id = $1 and revoked_at is null", [
      clientId,
    ]);
    expect(open.rows).toHaveLength(0);
    // без X-Bayramm-Source — сайт
    expect((await consentActions(clientId)).map((a) => [a.action, a.source])).toEqual([
      ["grant", "tma"],
      ["withdraw", "web"],
    ]);

    // Новый вход: тот же псевдонимный аккаунт, профиль заново, согласий нет
    const fresh = await loginToken({ ...user, first_name: "Back" });
    const me = await call("/me", bearer(fresh));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: clientId, firstName: "Back" });
    const exported = (await (await call("/me/export", bearer(fresh))).json()) as {
      consents: { action: string }[];
    };
    expect(exported.consents.map((c) => c.action)).toEqual(["grant", "withdraw"]);
  });
});
