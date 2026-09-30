import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ICON_NAMES } from "./icons";

/* Проверки по исходникам: то, что не видно в отрисовке одного экрана. */

const SRC = fileURLToPath(new URL(".", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const sources = files(SRC).map((path) => ({
  path: path.slice(SRC.length),
  code: readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""),
}));

describe("исходники клиента", () => {
  it("без innerHTML и dangerouslySetInnerHTML", () => {
    const hits = sources.filter(({ code }) =>
      /innerHTML|dangerouslySetInnerHTML|outerHTML|insertAdjacentHTML/.test(code),
    );
    expect(hits.map((s) => s.path)).toEqual([]);
  });

  it("токен и черновик — не в localStorage: между визитами — только язык и избранное гостя", () => {
    expect(sources.filter(({ code }) => /localStorage/.test(code)).map((s) => s.path)).toEqual([
      "storage.ts",
    ]);
    const users = sources
      .filter(({ path, code }) => path !== "storage.ts" && /\blocal(Get|Set|Remove)\w*\(/.test(code))
      .map((s) => s.path)
      .sort();
    expect(users).toEqual(["context.tsx", "favorites.tsx"]);
  });

  it("initData не пишется в лог и в хранилище", () => {
    const hits = sources.filter(({ code }) =>
      /console\.\w+\([^)]*initData|sessionSet\w*\([^)]*initData/.test(code),
    );
    expect(hits.map((s) => s.path)).toEqual([]);
    expect(sources.filter(({ code }) => /console\.(log|info|debug)/.test(code)).map((s) => s.path)).toEqual(
      [],
    );
  });

  it("демо-API подключается только динамически и только в разработке", () => {
    const importers = sources.filter(({ code }) =>
      /["']\.\/api\/mock["']|["']\.\.\/api\/mock["']|["']\.\/mock["']/.test(code),
    );
    expect(importers.map((s) => s.path)).toEqual(["bootstrap.ts"]);
    const bootstrap = importers[0]?.code ?? "";
    expect(bootstrap).toMatch(
      /if \(import\.meta\.env\.DEV[^)]*\) \{\s*const \{[^}]+\} = await import\("\.\/api\/mock"\)/,
    );
  });

  it("иконки: каждая вшитая где-то используется, мёртвых нет", () => {
    const code = sources
      .filter((s) => s.path !== "icons.tsx")
      .map((s) => s.code)
      .join("\n");
    const dead = ICON_NAMES.filter((name) => !code.includes(`"${name}"`) && !code.includes(`'${name}'`));
    expect(dead).toEqual([]);
  });

  it("вызовы SDK Telegram — через проверку наличия метода", () => {
    const telegram = sources.find((s) => s.path === "telegram.ts")?.code ?? "";
    const calls = [
      ...telegram.matchAll(/(?:webApp|button|BackButton|MainButton|HapticFeedback)\??\.(\w+)\??\.?\(/g),
    ];
    expect(calls.length).toBeGreaterThan(5);
    const unguarded = [...telegram.matchAll(/(?:webApp|button)\.(?!isVersionAtLeast)(\w+)\(/g)].map(
      ([m]) => m,
    );
    expect(unguarded).toEqual([]);
  });
});
