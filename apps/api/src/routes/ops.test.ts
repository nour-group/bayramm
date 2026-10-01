// POST /ops/demo без базы: где маршрут есть, ключ, лимит и разбор тела. Всё это
// отсекается до первого запроса к Postgres (HYPERDRIVE в тестах — порт 1: дойди
// запрос до базы, ответ был бы 5xx). Seed и reset с базой — test/integration/demo.test.ts
import { exifSegment, jpegFixture, webpFixture } from "@bayramm/media/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_PHOTO_COUNT, DEMO_VENUES } from "../demo/venues";
import { allowAllLimiter, call, makeEnv } from "../testing/worker";
import { DEMO_MAX_BODY_BYTES } from "./ops";

const KEY = "d".repeat(48);
const staging = (overrides: Partial<Env> = {}) =>
  makeEnv({
    APP_ENV: "staging",
    DEMO_SEED_KEY: KEY,
    SUPABASE_SERVICE_ROLE_KEY: "unit-test-key",
    ...overrides,
  });

function post(init: RequestInit & { authorization?: string } = {}, env = staging()) {
  const { authorization = `Bearer ${KEY}`, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (authorization) headers.set("Authorization", authorization);
  return call("/ops/demo", { method: "POST", ...rest, headers }, env);
}

const json = (body: unknown) => ({
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

function form(mode: string, photos: readonly (Uint8Array | string)[] = []) {
  const data = new FormData();
  data.append("mode", mode);
  for (const photo of photos) {
    data.append("photo", typeof photo === "string" ? photo : new Blob([photo as Uint8Array<ArrayBuffer>]));
  }
  return { body: data };
}

const photo = (n: number) => webpFixture({ width: 640 + n, height: 480 });

async function errorOf(res: Response) {
  return ((await res.json()) as { error: { code: string; details?: string[] } }).error;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("POST /ops/demo: где маршрут есть", () => {
  it.each(["local", "production"] as const)(
    "%s — 404 при верном ключе, лимит не считается",
    async (APP_ENV) => {
      const limiter = allowAllLimiter();
      const { res } = await post(
        { ...json({ mode: "reset" }), headers: { "CF-Connecting-IP": "203.0.113.7", ...json({}).headers } },
        staging({ APP_ENV, RATE_LIMIT_AUTH_IP: limiter }),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
      expect(limiter.calls).toEqual([]);
    },
  );

  it("staging без секрета — 404", async () => {
    for (const DEMO_SEED_KEY of ["", undefined as unknown as string]) {
      const { res } = await post(json({ mode: "reset" }), staging({ DEMO_SEED_KEY }));
      expect(res.status).toBe(404);
    }
  });

  it("GET — 404", async () => {
    const { res } = await call("/ops/demo", { headers: { Authorization: `Bearer ${KEY}` } }, staging());
    expect(res.status).toBe(404);
  });
});

describe("POST /ops/demo: ключ", () => {
  it.each([
    ["без заголовка", ""],
    ["чужой ключ", `Bearer ${"x".repeat(48)}`],
    ["ключ с лишним символом", `Bearer ${KEY}d`],
    ["Basic", `Basic ${KEY}`],
  ])("%s — 401", async (_name, authorization) => {
    const { res } = await post({ ...json({ mode: "reset" }), authorization });
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toEqual({ code: "unauthorized", message: "Authentication required" });
  });

  it("ключ короче 32 символов — ошибка настройки (500), а не вход", async () => {
    const short = "d".repeat(31);
    const { res } = await post(
      { ...json({ mode: "reset" }), authorization: `Bearer ${short}` },
      staging({ DEMO_SEED_KEY: short }),
    );
    expect(res.status).toBe(500);
  });

  it("лимит по IP — до проверки ключа: 429 с Retry-After", async () => {
    const limiter: RateLimit = { limit: async () => ({ success: false }) };
    const { res } = await post(
      {
        ...json({ mode: "reset" }),
        headers: { "CF-Connecting-IP": "203.0.113.7" },
        authorization: "Bearer x",
      },
      staging({ RATE_LIMIT_AUTH_IP: limiter }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("лимит считается по HMAC адреса, а не по самому адресу", async () => {
    const limiter = allowAllLimiter();
    await post(
      { ...json({ mode: "wipe" }), headers: { "CF-Connecting-IP": "203.0.113.7" } },
      staging({ RATE_LIMIT_AUTH_IP: limiter }),
    );
    expect(limiter.calls).toHaveLength(1);
    expect(limiter.calls[0]).toMatch(/^ip:/);
    expect(limiter.calls[0]).not.toContain("203.0.113.7");
  });
});

describe("POST /ops/demo: тело — до базы", () => {
  it.each([
    ["JSON: неизвестный режим", json({ mode: "wipe" })],
    ["JSON: без режима", json({})],
    ["форма: неизвестный режим", form("drop")],
  ])("%s — 422 invalid_input [mode]", async (_name, init) => {
    const { res } = await post(init);
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "invalid_input", details: ["mode"] });
  });

  it.each([
    ["не JSON", json("not json")],
    ["JSON-массив", json([])],
    ["null", json("null")],
  ])("%s — 400 invalid_request", async (_name, init) => {
    const { res } = await post(init);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_request");
  });

  it("фото не картинка — 422 invalid_image, код причины в details", async () => {
    const { res } = await post(form("seed", [new TextEncoder().encode("not an image at all")]));
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "invalid_image", details: ["unsupported_format"] });
  });

  it("фото с EXIF — 422, как любая загрузка", async () => {
    const withExif = jpegFixture({ width: 640, height: 480, segments: [exifSegment()] });
    const { res } = await post(form("seed", [photo(0), withExif]));
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("invalid_image");
  });

  it("поле photo строкой, а не файлом — 422 [photo]", async () => {
    const { res } = await post(form("seed", ["not a file"]));
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "invalid_input", details: ["photo"] });
  });

  it(`фото больше ${DEMO_PHOTO_COUNT} — 422 [photo]`, async () => {
    const photos = Array.from({ length: DEMO_PHOTO_COUNT + 1 }, (_, i) => photo(i));
    const { res } = await post(form("seed", photos));
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "invalid_input", details: ["photo"] });
  });

  it.each([
    ["номер 0", json({ mode: "seed", venue: 0 })],
    ["номер больше числа витрин", json({ mode: "seed", venue: DEMO_VENUES.length + 1 })],
    ["не целое", json({ mode: "seed", venue: 1.5 })],
    ["строка не числом", json({ mode: "seed", venue: "first" })],
    ["зал у reset", json({ mode: "reset", venue: 1 })],
  ])("venue: %s — 422 [venue]", async (_name, init) => {
    const { res } = await post(init);
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "invalid_input", details: ["venue"] });
  });

  it("один зал — не больше трёх фото: 422 [photo]", async () => {
    const data = form("seed", [photo(0), photo(1), photo(2), photo(3)]);
    data.body.append("venue", "1");
    const { res } = await post(data);
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "invalid_input", details: ["photo"] });
  });

  it("reset с фото — 422 [photo]: фото нужны только seed", async () => {
    const { res } = await post(form("reset", [photo(0)]));
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "invalid_input", details: ["photo"] });
  });

  it("тело больше предела — 413", async () => {
    const { res } = await post(json({ mode: "seed", pad: "x".repeat(DEMO_MAX_BODY_BYTES) }));
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe("payload_too_large");
  });
});
