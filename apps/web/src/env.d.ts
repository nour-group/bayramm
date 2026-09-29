/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Только для `pnpm dev:web`: live — ходить в настоящий API через /api (нужен `pnpm dev:api`),
   * иначе — демо-данные в памяти. В сборке всегда настоящий API
   */
  readonly VITE_API?: "live" | "mock";
  /** Только для демо-API: куда хаб входа ведёт в кабинет и панель (сквозные тесты — свои порты) */
  readonly VITE_VENDOR_APP_URL?: string;
  readonly VITE_ADMIN_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
