import { Hono } from "hono";
import { Client } from "pg";
import type { AppEnv } from "./env";
import { handleError, notFound } from "./errors";
import { auth } from "./routes/auth";
import { me } from "./routes/me";

// Веб проксирует /api/* сюда, отрезая префикс: /api/me → /me
const app = new Hono<AppEnv>();

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

app.route("/auth", auth);
app.route("/me", me);

app.notFound((c) => c.json(notFound().toBody(), 404));
app.onError(handleError);

export default app;
