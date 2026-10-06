import { defineConfig } from "@playwright/test";

/* Проверка демо-витрин на живом staging (не локальные серверы): её запускает workflow
   «Demo data (staging)» после seed и режимом check. Сеть настоящая — сайт, API, media,
   поэтому без подмен и с повтором; часы — настоящие (занятые дни — от дня seed).
   Адрес — STAGING_URL, по умолчанию staging.bayramm.uz. */

const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;
const phone = { viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } as const;
const desktop = { viewport: DESKTOP } as const;

export default defineConfig({
  testDir: "staging",
  outputDir: "test-results/staging",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 1,
  // Два потока: «Связаться» ограничено 30 открытиями в минуту с адреса
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: process.env.STAGING_URL ?? "https://staging.bayramm.uz",
    locale: "ru-RU",
    timezoneId: "Asia/Tashkent",
    reducedMotion: "reduce",
    colorScheme: "light",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "staging-phone", use: phone },
    { name: "staging-desktop", use: desktop },
  ],
});
