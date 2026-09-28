/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Бот виджета входа; задаётся при сборке (telegram.config.ts) */
  readonly VITE_TG_BOT_USERNAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
