import { defineConfig } from "vitest/config";

// Юнит-тесты: без базы и Docker (scripts — служебные скрипты workflow). С настоящим
// Postgres — vitest.integration.config.ts
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] },
});
