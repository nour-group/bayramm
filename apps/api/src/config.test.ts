import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

const API_CONFIG = join(import.meta.dirname, "../wrangler.jsonc");
const WEB_CONFIG = join(import.meta.dirname, "../../web/wrangler.jsonc");
const VENDOR_CONFIG = join(import.meta.dirname, "../../vendor/wrangler.jsonc");

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

// Единственный домен воркера окружения
const domainOf = (config: string, env: string) => {
  const domains = (read(config, env).routes ?? []).map((route: string | { pattern: string }) =>
    typeof route === "string" ? route : route.pattern,
  );
  expect(domains).toHaveLength(1);
  return domains[0];
};

describe("VENDOR_APP_URL и API_URL в wrangler.jsonc API", () => {
  it("локально — сервер разработки кабинета и wrangler dev", () => {
    expect(read(API_CONFIG).vars.VENDOR_APP_URL).toBe("http://localhost:5174");
    expect(read(API_CONFIG).vars.API_URL).toBe("http://localhost:8787");
  });

  // Кнопки бота открывают кабинет своего окружения; вебхук — на свой же домен API
  it.each(["staging", "production"])("%s — https-домены кабинета вендора и самого API", (env) => {
    const vars = read(API_CONFIG, env).vars;
    expect(vars.VENDOR_APP_URL).toBe(`https://${domainOf(VENDOR_CONFIG, env)}`);
    expect(vars.API_URL).toBe(`https://${domainOf(API_CONFIG, env)}`);
  });
});

describe("cron в wrangler.jsonc API", () => {
  // SLA и outbox — раз в минуту в каждом окружении
  it.each([undefined, "staging", "production"])("%s — раз в минуту", (env) => {
    expect(read(API_CONFIG, env).triggers.crons).toEqual(["* * * * *"]);
  });
});
