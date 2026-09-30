// Служебные маршруты окружения — их вызывают workflow GitHub, а не приложения.
//
//   POST /ops/demo  (Bearer <DEMO_SEED_KEY>)  → 200 { mode, … только счётчики }
//
// Демо-залы staging (demo/): seed — завести, reset — убрать всё демо. Маршрут есть
// только на staging (APP_ENV) и только с секретом DEMO_SEED_KEY; в других окружениях
// и без секрета — 404 при любом ключе, как будто его нет. Ключ не тот — 401, как у
// /telegram/sync (auth/service-key.ts): код открыт, скрывать нечего, а 401 отличает
// «ключи в GitHub и в воркере разошлись» от «секрет не задан». Лимит — по IP, счётчик
// входа (RATE_LIMIT_AUTH_IP): перебор ключа упирается в него.
//
// Тело — multipart/form-data: поле mode (seed | reset); для seed — venue (номер зала
// с 1; без него — все залы) и фото в полях photo: зала venue или по
// DEMO_PHOTOS_PER_VENUE на зал, по порядку залов. Или JSON { "mode", "venue"? } без фото.
// Workflow заводит залы по одному: так каждый запрос остаётся коротким по времени CPU.
// Каждое фото проверяется по байтам до базы (assertUploadable) — как любая загрузка;
// всё тело — не больше DEMO_MAX_BODY_BYTES.

import { assertUploadable, ImageError } from "@bayramm/media";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { requireServiceKey } from "../auth/service-key";
import { database } from "../db/middleware";
import { resetDemo, seedDemo } from "../demo/service";
import { DEMO_PHOTO_COUNT, DEMO_PHOTOS_PER_VENUE, DEMO_VENUES } from "../demo/venues";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { imageApiError } from "../photos/service";
import { limitByIp } from "../ratelimit";
import { invalidInput } from "../staff/input";
import { listingPhotoStorage } from "../storage/supabase";

// Фото workflow — по несколько десятков КБ; 12 МБ — с большим запасом, но не
// DEMO_PHOTO_COUNT × 10 МБ: столько демо не нужно
export const DEMO_MAX_BODY_BYTES = 12 * 1024 * 1024;

const MODES = ["seed", "reset"] as const;
type DemoMode = (typeof MODES)[number];

const invalidBody = () =>
  new ApiError(400, "invalid_request", "Body must be multipart/form-data or a JSON object");

// Только staging и только с секретом — иначе маршрута нет
const demoEnabled = createMiddleware<AppEnv>(async (c, next) => {
  if (c.env.APP_ENV !== "staging" || !c.env.DEMO_SEED_KEY) throw notFound();
  await next();
});

const limitDemoBody = bodyLimit({
  maxSize: DEMO_MAX_BODY_BYTES,
  onError: (c) => c.json(new ApiError(413, "payload_too_large", "Request body is too large").toBody(), 413),
});

interface DemoBody {
  readonly mode: DemoMode;
  /** Номер зала с 1; undefined — все */
  readonly venue: number | undefined;
  readonly photos: readonly Uint8Array[];
}

function parseMode(value: unknown): DemoMode {
  const mode = MODES.find((m) => m === value);
  if (mode === undefined) throw invalidInput(["mode"]);
  return mode;
}

/** Номер зала: 1…DEMO_VENUES.length числом (JSON) или строкой (форма); нет — undefined */
function parseVenue(value: unknown, mode: DemoMode): number | undefined {
  if (value === undefined || value === null) return undefined;
  const venue = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : value;
  // Зал выбирают только для seed: reset убирает всё демо разом
  if (mode !== "seed" || typeof venue !== "number" || !Number.isInteger(venue)) throw invalidInput(["venue"]);
  if (venue < 1 || venue > DEMO_VENUES.length) throw invalidInput(["venue"]);
  return venue;
}

/** Фото из формы: только файлы, не больше max, каждое — проверенное по байтам */
async function readPhotos(values: readonly (File | string)[], max: number): Promise<Uint8Array[]> {
  if (values.length > max) throw invalidInput(["photo"]);
  const photos: Uint8Array[] = [];
  for (const value of values) {
    if (typeof value === "string") throw invalidInput(["photo"]);
    const bytes = new Uint8Array(await value.arrayBuffer());
    try {
      assertUploadable(bytes);
    } catch (err) {
      if (err instanceof ImageError) throw imageApiError(err);
      throw err;
    }
    photos.push(bytes);
  }
  return photos;
}

export async function readDemoBody(request: Request): Promise<DemoBody> {
  const type = request.headers.get("content-type") ?? "";
  if (/^multipart\/form-data/i.test(type)) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw invalidBody();
    }
    const mode = parseMode(form.get("mode"));
    const venue = parseVenue(form.get("venue"), mode);
    const photos = await readPhotos(
      form.getAll("photo"),
      venue === undefined ? DEMO_PHOTO_COUNT : DEMO_PHOTOS_PER_VENUE,
    );
    // Фото нужны только seed: reset с фото — скорее ошибка в вызове
    if (mode === "reset" && photos.length > 0) throw invalidInput(["photo"]);
    return { mode, venue, photos };
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw invalidBody();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalidBody();
  const fields = body as Record<string, unknown>;
  const mode = parseMode(fields.mode);
  return { mode, venue: parseVenue(fields.venue, mode), photos: [] };
}

export const ops = new Hono<AppEnv>();

ops.post(
  "/demo",
  demoEnabled,
  limitByIp("RATE_LIMIT_AUTH_IP"),
  requireServiceKey("DEMO_SEED_KEY"),
  limitDemoBody,
  database,
  async (c) => {
    const body = await readDemoBody(c.req.raw);
    const deps = { db: c.var.db, storage: listingPhotoStorage(c.env) };
    const summary =
      body.mode === "seed" ? await seedDemo(deps, body.photos, body.venue) : await resetDemo(deps);
    // В ответе и в логе — только счётчики
    console.info("ops.demo", JSON.stringify(summary));
    return c.json(summary, 200, { "cache-control": "no-store" });
  },
);
