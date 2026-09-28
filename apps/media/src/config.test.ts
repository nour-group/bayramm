import { fileURLToPath } from "node:url";
import { MEDIA_ORIGINS } from "@bayramm/media";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

const CONFIG = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

// Итоговый конфиг окружения — с наследованием, как его увидит wrangler deploy
const read = (env?: string) => unstable_readConfig({ config: CONFIG, env }, { hideWarnings: true });

const ENVS = [
  { env: undefined, name: "bayramm-media-dev", supabase: "http://127.0.0.1:54321", domain: undefined },
  {
    env: "staging",
    name: "bayramm-media-staging",
    supabase: "https://ovuzkqcxiwgdpqovsudr.supabase.co",
    domain: "media-staging.bayramm.uz",
  },
  {
    env: "production",
    name: "bayramm-media",
    supabase: "https://muxftjxhsfizpxqxqkbo.supabase.co",
    domain: "media.bayramm.uz",
  },
] as const;

describe("wrangler.jsonc воркера media", () => {
  for (const { env, name, supabase, domain } of ENVS) {
    const label = env ?? "local";

    it(`${label}: воркер ${name}`, () => {
      expect(read(env).name).toBe(name);
    });

    it(`${label}: Storage ${supabase}`, () => {
      expect(read(env).vars).toEqual({ SUPABASE_URL: supabase });
    });

    it(`${label}: домен ${domain ?? "не задан"}`, () => {
      expect(read(env).routes ?? []).toEqual(domain ? [{ pattern: domain, custom_domain: true }] : []);
    });

    it(`${label}: без placement — отвечает ближайший к зрителю дата-центр`, () => {
      expect(read(env).placement).toBeUndefined();
    });
  }

  it("домены совпадают с MEDIA_ORIGINS, которыми пользуются приложения", () => {
    expect(MEDIA_ORIGINS.staging).toBe("https://media-staging.bayramm.uz");
    expect(MEDIA_ORIGINS.production).toBe("https://media.bayramm.uz");
    expect(MEDIA_ORIGINS.local).toBe(`http://localhost:${read().dev.port}`);
  });
});
