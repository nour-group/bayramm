import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

const CONFIG = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

// Итоговый конфиг окружения — с наследованием, как его увидит wrangler deploy
const read = (env?: string) => unstable_readConfig({ config: CONFIG, env }, { hideWarnings: true });

const ENVS = [
  { env: undefined, api: "bayramm-api-dev", domain: undefined },
  { env: "staging", api: "bayramm-api-staging", domain: "staging.bayramm.uz" },
  { env: "production", api: "bayramm-api", domain: "bayramm.uz" },
] as const;

describe("wrangler.jsonc клиента", () => {
  for (const { env, api, domain } of ENVS) {
    const name = env ?? "local";

    it(`${name}: воркер первым, фолбэк SPA в ASSETS`, () => {
      const { assets } = read(env);
      expect(assets?.run_worker_first).toBe(true);
      expect(assets?.not_found_handling).toBe("single-page-application");
    });

    it(`${name}: /api → ${api}`, () => {
      expect(read(env).services).toEqual([{ binding: "API", service: api }]);
    });

    it(`${name}: домен ${domain ?? "не задан"}`, () => {
      const routes = read(env).routes ?? [];
      expect(routes).toEqual(domain ? [{ pattern: domain, custom_domain: true }] : []);
    });
  }
});
