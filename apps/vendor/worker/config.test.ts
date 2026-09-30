import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

const CONFIG = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

// Итоговый конфиг окружения — с наследованием, как его увидит wrangler deploy
const read = (env?: string) => unstable_readConfig({ config: CONFIG, env }, { hideWarnings: true });

const ENVS = [
  { env: undefined, name: "bayramm-vendor-dev", api: "bayramm-api-dev", domain: undefined },
  {
    env: "staging",
    name: "bayramm-vendor-staging",
    api: "bayramm-api-staging",
    domain: "vendor-staging.bayramm.uz",
  },
  { env: "production", name: "bayramm-vendor", api: "bayramm-api", domain: "vendor.bayramm.uz" },
] as const;

describe("wrangler.jsonc кабинета вендора", () => {
  for (const { env, name, api, domain } of ENVS) {
    const label = env ?? "local";

    it(`${label}: воркер ${name}`, () => {
      expect(read(env).name).toBe(name);
    });

    it(`${label}: воркер первым, фолбэк SPA в ASSETS`, () => {
      const { assets } = read(env);
      expect(assets?.binding).toBe("ASSETS");
      expect(assets?.run_worker_first).toBe(true);
      expect(assets?.not_found_handling).toBe("single-page-application");
    });

    it(`${label}: /api → ${api}`, () => {
      expect(read(env).services).toEqual([{ binding: "API", service: api }]);
    });

    it(`${label}: домен ${domain ?? "не задан"}`, () => {
      const routes = read(env).routes ?? [];
      expect(routes).toEqual(domain ? [{ pattern: domain, custom_domain: true }] : []);
    });

    it(`${label}: логи Workers Logs включены — каждый запрос (партнёров немного)`, () => {
      expect(read(env).observability).toMatchObject({ enabled: true, head_sampling_rate: 1 });
    });
  }
});
