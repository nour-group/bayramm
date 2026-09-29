import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

const API_CONFIG = join(import.meta.dirname, "../wrangler.jsonc");
const WEB_CONFIG = join(import.meta.dirname, "../../web/wrangler.jsonc");

// Итоговый конфиг окружения — с наследованием, как его увидит wrangler deploy
const read = (config: string, env?: string) => unstable_readConfig({ config, env }, { hideWarnings: true });

describe("WEB_APP_URL в wrangler.jsonc API", () => {
  it("локально — сервер разработки клиента", () => {
    expect(read(API_CONFIG).vars.WEB_APP_URL).toBe("http://localhost:5173");
  });

  // Кнопка меню бота открывает клиент своего окружения: https и домен воркера web
  it.each(["staging", "production"])("%s — https-домен клиентского приложения", (env) => {
    const url = read(API_CONFIG, env).vars.WEB_APP_URL;
    const webDomains = (read(WEB_CONFIG, env).routes ?? []).map((route: string | { pattern: string }) =>
      typeof route === "string" ? route : route.pattern,
    );
    expect(webDomains).toHaveLength(1);
    expect(url).toBe(`https://${webDomains[0]}`);
  });
});
