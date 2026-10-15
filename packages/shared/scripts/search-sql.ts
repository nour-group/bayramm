/* SQL поиска из TS: блок функций для новой миграции и блок векторов для pgTAP —
   pnpm --silent --filter @bayramm/shared search:sql > фрагмент.sql */

import { searchSql, searchVectorsSql } from "../src/search/sql.ts";

console.log(searchSql());
console.log();
console.log(searchVectorsSql());
