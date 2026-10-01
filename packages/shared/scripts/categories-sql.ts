/* Сид app.categories и app.service_types из конфигурации категорий — для новой миграции:
   pnpm --silent --filter @bayramm/shared categories:sql > фрагмент.sql */

import { categoriesSeedSql } from "../src/categories/sql.ts";

console.log(categoriesSeedSql());
