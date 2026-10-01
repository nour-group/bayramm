import { HSTS, httpsRedirect } from "@bayramm/edge/https";
import { Hono } from "hono";
import { Client } from "pg";
import { scheduled } from "./cron";
import type { AppEnv } from "./env";
import { handleError, notFound } from "./errors";
import { reportApiError } from "./notify/api-errors";
import { mountRateLimits } from "./ratelimit";
import { auth } from "./routes/auth";
import { catalog } from "./routes/catalog";
import { me } from "./routes/me";
import { ops } from "./routes/ops";
import { reference } from "./routes/reference";
import { requests } from "./routes/requests";
import { staff } from "./routes/staff";
import { telegram } from "./routes/telegram";
import { vendor } from "./routes/vendor";

// Веб проксирует /api/* сюда, отрезая префикс: /api/me → /me
const app = new Hono<AppEnv>();

// Только HTTPS (packages/edge, https.ts): по http — редирект до маршрутов (308 сохраняет метод
// POST вебхука и входа), ответы — со Strict-Transport-Security. Первым: раньше /health и лимитов
app.use(async (c, next) => {
  const insecure = httpsRedirect(c.req.raw);
  if (insecure) return insecure;
  await next();
  c.res.headers.set("Strict-Transport-Security", HSTS);
});

type DbStatus = "ok" | "error" | "not_configured";

async function checkDb(
  hyperdrive: Hyperdrive | undefined,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<DbStatus> {
  if (!hyperdrive) return "not_configured";
  const client = new Client({ connectionString: hyperdrive.connectionString });
  try {
    await client.connect();
    await client.query("select 1");
    return "ok";
  } catch (err) {
    // Причину пишем в лог, наружу не отдаём — в ошибке может быть хост базы
    console.error("health: db check failed", err);
    return "error";
  } finally {
    waitUntil(client.end().catch(() => {}));
  }
}

app.get("/health", async (c) => {
  const db = await checkDb(c.env.HYPERDRIVE, (p) => c.executionCtx.waitUntil(p));
  const ok = db !== "error";
  return c.json(
    {
      ok,
      service: "bayramm-api",
      env: c.env.APP_ENV,
      sha: c.env.GIT_SHA,
      db,
      time: new Date().toISOString(),
    },
    ok ? 200 : 503,
  );
});

// Лимиты частоты — до маршрутов: POST /auth/*, POST /requests (src/ratelimit.ts)
mountRateLimits(app);

app.route("/auth", auth);
app.route("/me", me);
// Клиент: справочники и тексты согласий (/dictionaries, /consent-texts), каталог, заявки
app.route("/", reference);
app.route("/catalog", catalog);
app.route("/requests", requests);
app.route("/staff", staff);
app.route("/telegram", telegram);
// Служебное: демо-данные staging (только APP_ENV=staging и секрет DEMO_SEED_KEY)
app.route("/ops", ops);
app.route("/vendor", vendor);

app.notFound((c) => c.json(notFound().toBody(), 404));
// Ответ 5xx — ещё и счётчик ошибок с оповещением команде в боте (не чаще раза в 30 минут):
// после ответа, запрос его не ждёт (notify/api-errors.ts)
app.onError((err, c) => {
  const res = handleError(err, c);
  if (res.status >= 500) reportApiError(c);
  return res;
});

// Воркер: fetch — приложение Hono, scheduled — cron раз в минуту (SLA и outbox).
// Экспорт — само приложение с обработчиком cron: тесты зовут app.request как раньше
export default Object.assign(app, { scheduled });
