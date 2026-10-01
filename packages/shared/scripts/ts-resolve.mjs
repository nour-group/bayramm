/* Импорты без расширения в исходниках пакета (так их пишет TypeScript с moduleResolution
   Bundler) → файлы .ts: Node снимает типы сам, но расширение не угадывает. Только для
   служебных скриптов пакета: node --import ./scripts/ts-resolve.mjs <скрипт>.ts
   (Node ≥ 22.18: снятие типов и module.registerHooks) */

import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context);
        } catch {
          // следующий вариант
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
