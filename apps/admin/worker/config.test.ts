import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

const CONFIG = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

// Итоговый конфиг окружения — с наследованием, как его увидит wrangler deploy
const read = (env?: string) => unstable_readConfig({ config: CONFIG, env }, { hideWarnings: true });

const ENVS = [
  { env: undefined, name: "bayramm-admin-dev", api: "bayramm-api-dev" },
  { env: "staging", name: "bayramm-admin-staging", api: "bayramm-api-staging" },
  { env: "production", name: "bayramm-admin", api: "bayramm-api" },
] as const;

describe("wrangler.jsonc панели оператора: до Cloudflare Access адреса в интернете нет", () => {
  for (const { env, name, api } of ENVS) {
    const label = env ?? "local";

    it(`${label}: воркер ${name}`, () => {
      expect(read(env).name).toBe(name);
    });

    it(`${label}: нет *.workers.dev и preview-адресов`, () => {
      const config = read(env);
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
    });

    it(`${label}: нет ни маршрутов, ни своих доменов`, () => {
      const config = read(env);
      expect(config.routes ?? []).toEqual([]);
      expect(config.route).toBeUndefined();
    });

    it(`${label}: воркер первым, фолбэк SPA, /api → ${api}`, () => {
      const config = read(env);
      expect(config.assets?.run_worker_first).toBe(true);
      expect(config.assets?.not_found_handling).toBe("single-page-application");
      expect(config.services).toEqual([{ binding: "API", service: api }]);
    });
  }

  it("в исходном файле нет ключей маршрутов ни в одном окружении", () => {
    const raw = readFileSync(CONFIG, "utf8");
    expect(raw).not.toMatch(/"routes?"\s*:/);
    expect(raw).not.toMatch(/custom_domain/);
    expect(raw).not.toMatch(/"workers_dev"\s*:\s*true/);
    expect(raw).not.toMatch(/"preview_urls"\s*:\s*true/);
  });
});
