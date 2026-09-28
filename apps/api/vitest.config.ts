import { defineConfig } from "vitest/config";

// Юнит-тесты: без базы и Docker. С настоящим Postgres — vitest.integration.config.ts
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
