// @vitest-environment jsdom
import { CLIENT_SOURCE_HEADER, type CreateRequest } from "@bayramm/shared/api";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import { createHttpApi, telegramSignIn } from "./http";
import { createTelegramAuth, guestAuth, SESSION_KEY } from "./session";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Поддельный fetch: очередь ответов по пути, всё увиденное — в seen */
function fakeFetch(routes: Record<string, (() => Response)[]>) {
  const seen: Seen[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input, "https://bayramm.uz");
    seen.push({
      url: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const queue = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    const next = queue?.shift();
    if (!next) throw new TypeError("Failed to fetch");
    return next();
  };
  return { fetch, seen };
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SESSION = { token: "tok-1", expiresAt: "2026-10-08T07:00:00.000Z" };
const NOW = Date.parse("2026-10-01T07:00:00Z");
const BODY: CreateRequest = {
  listingId: "l-1",
  occasionCode: "toy",
  eventDate: "2026-10-15",
  guests: 100,
  contactName: "Азиза",
  contactPhone: "+998901234567",
  comment: "детский стол",
  requestTransferConsentId: "c-1",
};

function setup(routes: Record<string, (() => Response)[]>, userId: number | null = 42) {
  const { fetch, seen } = fakeFetch(routes);
  const auth = createTelegramAuth({
    initData: "query_id=1&hash=abc",
    userId,
    signIn: telegramSignIn(fetch),
    now: () => NOW,
  });
  return { api: createHttpApi({ auth, fetch, source: "tma" }), seen, auth };
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("HTTP-клиент API", () => {
  it("каталог: параметры в строке запроса, без токена", async () => {
    const { api, seen } = setup({
      "GET /api/catalog/listings": [json(200, { items: [], nextCursor: null })],
    });
    await api.catalog({
      date: "2026-10-08",
      guests: 200,
      district: "chilonzor",
      sort: "price_asc",
      limit: 20,
    });
    expect(seen[0]?.url).toBe(
      "/api/catalog/listings?district=chilonzor&date=2026-10-08&guests=200&sort=price_asc&limit=20",
    );
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it("площадка и согласия: адреса по контракту", async () => {
    const { api, seen } = setup({
      "GET /api/catalog/listings/lola-zali": [json(200, { slug: "lola-zali" })],
      "GET /api/consent-texts": [json(200, { items: [] })],
      "GET /api/telegram/bot": [json(200, { username: "bayramm_bot", miniAppUrl: "https://bayramm.uz" })],
    });
    await api.listing("lola-zali");
    await api.consentTexts("uz");
    await api.bot();
    expect(seen.map((s) => s.url)).toEqual([
      "/api/catalog/listings/lola-zali",
      "/api/consent-texts?locale=uz",
      "/api/telegram/bot",
    ]);
  });

  it("заявка: вход по initData, затем Bearer; токен — в sessionStorage, не в localStorage", async () => {
    const { api, seen } = setup({
      "POST /api/auth/telegram": [json(200, SESSION)],
      "POST /api/requests": [json(201, { id: "r-1", publicNo: 7, status: "new", slaDueAt: "x" })],
    });
    const created = await api.createRequest(BODY);
    expect(created.id).toBe("r-1");
    expect(seen[0]).toMatchObject({
      url: "/api/auth/telegram",
      method: "POST",
      body: { initData: "query_id=1&hash=abc" },
    });
    expect(seen[1]).toMatchObject({ url: "/api/requests", method: "POST", body: BODY });
    expect(seen[1]?.headers.authorization).toBe("Bearer tok-1");
    // Заявка из Mini App помечена источником tma (контракт: CLIENT_SOURCE_HEADER)
    expect(seen[1]?.headers[CLIENT_SOURCE_HEADER]).toBe("tma");
    expect(JSON.parse(window.sessionStorage.getItem(SESSION_KEY) ?? "{}")).toMatchObject({
      token: "tok-1",
      userId: 42,
    });
    expect(window.localStorage.length).toBe(0);
  });

  it("действующий токен не запрашивается заново; несколько запросов — один вход", async () => {
    const { api, seen } = setup({
      "POST /api/auth/telegram": [json(200, SESSION)],
      "GET /api/requests": [json(200, { items: [] }), json(200, { items: [] }), json(200, { items: [] })],
    });
    await Promise.all([api.myRequests(), api.myRequests()]);
    await api.myRequests();
    expect(seen.filter((s) => s.url === "/api/auth/telegram")).toHaveLength(1);
  });

  it("токен другого пользователя Telegram не используется", async () => {
    window.sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ userId: 7, token: "чужой", expiresAt: SESSION.expiresAt }),
    );
    const { api, seen } = setup({
      "POST /api/auth/telegram": [json(200, SESSION)],
      "GET /api/requests": [json(200, { items: [] })],
    });
    await api.myRequests();
    expect(seen.at(-1)?.headers.authorization).toBe("Bearer tok-1");
  });

  it("401 — один повторный вход и повтор запроса; второй 401 — ошибка", async () => {
    const { api, seen } = setup({
      "POST /api/auth/telegram": [json(200, SESSION), json(200, { ...SESSION, token: "tok-2" })],
      "GET /api/requests": [json(401, { error: { code: "unauthorized" } }), json(200, { items: [] })],
    });
    await expect(api.myRequests()).resolves.toEqual({ items: [] });
    expect(seen.at(-1)?.headers.authorization).toBe("Bearer tok-2");

    const again = setup({
      "POST /api/auth/telegram": [json(200, SESSION), json(200, SESSION)],
      "GET /api/requests": [json(401, {}), json(401, {})],
    });
    window.sessionStorage.clear();
    await expect(again.api.myRequests()).rejects.toMatchObject({ status: 401, code: "http_401" });
  });

  it("409 duplicate_request: код и id уже отправленной заявки", async () => {
    const { api } = setup({
      "POST /api/auth/telegram": [json(200, SESSION)],
      "POST /api/requests": [
        json(409, { error: { code: "duplicate_request", message: "dup" }, existingId: "r-0" }),
      ],
    });
    const error = await api.createRequest(BODY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "duplicate_request", existingId: "r-0" });
  });

  it("сеть недоступна — code network; ответ не JSON — bad_response", async () => {
    const { api } = setup({ "GET /api/dictionaries": [() => new Response("<html>", { status: 200 })] });
    await expect(api.dictionaries()).rejects.toMatchObject({ code: "bad_response" });
    await expect(api.dictionaries()).rejects.toMatchObject({ status: 0, code: "network" });
  });

  it("каталог и сайт: источник не шлётся", async () => {
    const { fetch, seen } = fakeFetch({
      "GET /api/catalog/listings": [json(200, { items: [], nextCursor: null })],
    });
    await createHttpApi({ auth: guestAuth, fetch }).catalog({});
    expect(seen[0]?.headers[CLIENT_SOURCE_HEADER]).toBeUndefined();
  });

  it("вне Telegram заявки не уходят в сеть: no_session", async () => {
    const { fetch, seen } = fakeFetch({});
    const api = createHttpApi({ auth: guestAuth, fetch });
    await expect(api.myRequests()).rejects.toMatchObject({ status: 401, code: "no_session" });
    expect(seen).toHaveLength(0);
  });

  it("отзыв заявки: POST /requests/:id/withdraw", async () => {
    const { api, seen } = setup({
      "POST /api/auth/telegram": [json(200, SESSION)],
      "POST /api/requests/r-1/withdraw": [json(200, { id: "r-1", status: "withdrawn" })],
    });
    await expect(api.withdrawRequest("r-1")).resolves.toMatchObject({ status: "withdrawn" });
    expect(seen.at(-1)).toMatchObject({ url: "/api/requests/r-1/withdraw", method: "POST" });
  });

  it("свой профиль и данные: GET/PATCH /me, выгрузка, отзыв согласия — с сессией", async () => {
    const me = { id: "c-1", locale: "uz", notifications: true };
    const { api, seen } = setup({
      "POST /api/auth/telegram": [json(200, SESSION)],
      "GET /api/me": [json(200, me)],
      "PATCH /api/me": [json(200, { ...me, locale: "ru" })],
      "GET /api/me/export": [json(200, { version: 1 })],
      "POST /api/me/consents/withdraw": [json(200, { withdrawn: true })],
    });
    await api.me();
    await expect(api.updateMe({ locale: "ru" })).resolves.toMatchObject({ locale: "ru" });
    await expect(api.exportMyData()).resolves.toEqual({ version: 1 });
    await expect(api.withdrawConsent({ purpose: "bot_notifications" })).resolves.toEqual({ withdrawn: true });
    expect(seen.slice(1).map((s) => [s.method, s.url, s.body, s.headers.authorization])).toEqual([
      ["GET", "/api/me", undefined, "Bearer tok-1"],
      ["PATCH", "/api/me", { locale: "ru" }, "Bearer tok-1"],
      ["GET", "/api/me/export", undefined, "Bearer tok-1"],
      ["POST", "/api/me/consents/withdraw", { purpose: "bot_notifications" }, "Bearer tok-1"],
    ]);
  });

  it("удаление аккаунта: DELETE /me → 204; дальше в этой вкладке вход закрыт", async () => {
    const { api, seen } = setup({
      "POST /api/auth/telegram": [json(200, SESSION), json(200, SESSION)],
      "DELETE /api/me": [() => new Response(null, { status: 204 })],
    });
    await expect(api.deleteAccount()).resolves.toBeUndefined();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
    // Новый вход создал бы аккаунт заново — его нет, запросов в сеть тоже
    await expect(api.myRequests()).rejects.toMatchObject({ status: 401, code: "account_deleted" });
    await expect(api.updateMe({ locale: "ru" })).rejects.toMatchObject({ code: "account_deleted" });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /api/auth/telegram", "DELETE /api/me"]);
  });
});
