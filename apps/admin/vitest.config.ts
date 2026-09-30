import { defineConfig } from "vitest/config";

// Отдельно от vite.config.ts: плагин Cloudflare поднимает свой сервер и конфликтует с Vitest
export default defineConfig({
  test: {
    include: ["worker/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
    // Экраны — ленивые куски (screens.ts): в тестах jsdom они загружены заранее
    setupFiles: ["src/test-setup.ts"],
  },
});
