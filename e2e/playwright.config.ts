import { defineConfig } from "@playwright/test";

/* Сквозные проверки в браузере. Всё локально и без сети: три сервера разработки Vite,
   у клиента — демо-API в памяти (VITE_API=mock), у кабинета и панели /api перехватывает
   сам тест (support/). Запросы наружу (telegram.org, media) подменяет фикстура offline.
   Порты — не 5173…: не подхватить чужой сервер разработки с настоящим API. */

const CI = Boolean(process.env.CI);

export const PORTS = { web: 4310, vendor: 4311, admin: 4312 } as const;
const origin = (port: number) => `http://localhost:${port}`;

const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;
// Телефон: сенсорный экран и мобильная раскладка вьюпорта (meta viewport учитывается)
const phone = { viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } as const;
const desktop = { viewport: DESKTOP } as const;

function devServer(app: keyof typeof PORTS, env: Record<string, string> = {}) {
  return {
    command: `pnpm --filter @bayramm/${app} exec vite --port ${PORTS[app]} --strictPort`,
    cwd: "..",
    url: origin(PORTS[app]),
    env,
    // Локально можно держать серверы запущенными между прогонами; в CI — всегда свои
    reuseExistingServer: !CI,
    timeout: 120_000,
    stdout: "ignore" as const,
    stderr: "pipe" as const,
  };
}

export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: CI ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    locale: "ru-RU",
    timezoneId: "Asia/Tashkent",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Без анимаций: переходы не мешают замерам и снимкам
    reducedMotion: "reduce",
    colorScheme: "light",
  },
  projects: [
    { name: "web-phone", testDir: "web", use: { ...phone, baseURL: origin(PORTS.web) } },
    { name: "web-desktop", testDir: "web", use: { ...desktop, baseURL: origin(PORTS.web) } },
    { name: "vendor-phone", testDir: "vendor", use: { ...phone, baseURL: origin(PORTS.vendor) } },
    { name: "admin-desktop", testDir: "admin", use: { ...desktop, baseURL: origin(PORTS.admin) } },
  ],
  webServer: [
    // Демо-API явно: .env.local с VITE_API=live не должен увести тесты на настоящий сервер
    devServer("web", { VITE_API: "mock" }),
    devServer("vendor"),
    devServer("admin"),
  ],
});
