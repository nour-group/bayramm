import { defineConfig } from "vitest/config";

// Интеграционные тесты против локального Postgres из `supabase db start`
// (порт 54322). Запуск: pnpm --filter @bayramm/api test:integration
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/global-setup.ts"],
    // Файлы делят одну базу и роль — по очереди
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
