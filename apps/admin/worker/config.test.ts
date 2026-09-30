import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

const CONFIG = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

// Итоговый конфиг окружения — с наследованием, как его увидит wrangler deploy
const read = (env?: string) => unstable_readConfig({ config: CONFIG, env }, { hideWarnings: true });

const ENVS = [
  { env: undefined, name: "bayramm-admin-dev", api: "bayramm-api-dev", domain: undefined },
  {
    env: "staging",
    name: "bayramm-admin-staging",
    api: "bayramm-api-staging",
    domain: "admin-staging.bayramm.uz",
  },
  { env: "production", name: "bayramm-admin", api: "bayramm-api", domain: "admin.bayramm.uz" },
] as const;

describe("wrangler.jsonc панели оператора", () => {
  for (const { env, name, api, domain } of ENVS) {
    const label = env ?? "local";

    it(`${label}: воркер ${name}`, () => {
      expect(read(env).name).toBe(name);
    });

    it(`${label}: нет *.workers.dev и preview-адресов`, () => {
      const config = read(env);
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
    });

    it(`${label}: домен ${domain ?? "не задан"} и больше никаких маршрутов`, () => {
      const config = read(env);
      expect(config.routes ?? []).toEqual(domain ? [{ pattern: domain, custom_domain: true }] : []);
      expect(config.route).toBeUndefined();
    });

    it(`${label}: логи Workers Logs включены — каждый запрос (сотрудников единицы)`, () => {
      expect(read(env).observability).toMatchObject({ enabled: true, head_sampling_rate: 1 });
    });

    it(`${label}: воркер первым, фолбэк SPA, /api → ${api}`, () => {
      const config = read(env);
      expect(config.assets?.run_worker_first).toBe(true);
      expect(config.assets?.not_found_handling).toBe("single-page-application");
      expect(config.services).toEqual([{ binding: "API", service: api }]);
    });
  }

  it("в исходном файле только эти два домена и ни одного публичного адреса workers.dev", () => {
    const raw = readFileSync(CONFIG, "utf8");
    const patterns = [...raw.matchAll(/"pattern"\s*:\s*"([^"]+)"/g)].map(([, pattern]) => pattern);
    expect(patterns).toEqual(["admin-staging.bayramm.uz", "admin.bayramm.uz"]);
    expect(raw).not.toMatch(/"route"\s*:/);
    expect(raw).not.toMatch(/"workers_dev"\s*:\s*true/);
    expect(raw).not.toMatch(/"preview_urls"\s*:\s*true/);
  });
});
