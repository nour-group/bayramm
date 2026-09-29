/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Только для `pnpm dev:web`: live — ходить в настоящий API через /api (нужен `pnpm dev:api`),
   * иначе — демо-данные в памяти. В сборке всегда настоящий API
   */
  readonly VITE_API?: "live" | "mock";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
