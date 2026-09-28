// Подготовка локальной базы к интеграционным тестам.
//
// API ходит в базу ролью bayramm_api. Локально она NOLOGIN (пароль выдаётся вне
// миграций), поэтому на время тестов даём ей одноразовый случайный пароль,
// а после — возвращаем NOLOGIN. Только локальная база: адрес проверяется.
//
//   TEST_ADMIN_DATABASE_URL — postgres локального стека (по умолчанию supabase db start)
//   TEST_API_DATABASE_URL   — готовое подключение ролью bayramm_api; если задано,
//                             роль не трогаем

import { randomBytes } from "node:crypto";
import { Client, escapeLiteral } from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
    apiDatabaseUrl: string;
  }
}

const DEFAULT_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function assertLocal(url: string): URL {
  const parsed = new URL(url);
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    // Тесты пишут и удаляют данные и меняют роль — только на своей машине или в CI
    throw new Error(`интеграционные тесты работают только с локальной базой, а не с ${parsed.hostname}`);
  }
  return parsed;
}

async function asAdmin(url: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (err) {
    throw new Error("нет локального Postgres на 54322 — запустите `npx supabase db start`", { cause: err });
  }
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? DEFAULT_ADMIN_URL;
  assertLocal(adminUrl);
  project.provide("adminDatabaseUrl", adminUrl);

  const presetApiUrl = process.env.TEST_API_DATABASE_URL;
  if (presetApiUrl) {
    assertLocal(presetApiUrl);
    project.provide("apiDatabaseUrl", presetApiUrl);
    return;
  }

  const password = randomBytes(24).toString("hex");
  await asAdmin(adminUrl, `alter role bayramm_api with login password ${escapeLiteral(password)}`);

  const apiUrl = new URL(adminUrl);
  apiUrl.username = "bayramm_api";
  apiUrl.password = password;
  project.provide("apiDatabaseUrl", apiUrl.toString());

  return async () => {
    await asAdmin(adminUrl, "alter role bayramm_api with nologin password null");
  };
}
