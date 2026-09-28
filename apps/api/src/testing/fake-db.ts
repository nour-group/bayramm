// Kysely без базы — для юнит-тестов: записывает скомпилированные запросы и
// границы транзакций, строки результата отдаёт из respond. В прод-код не входит.

import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import type { Db } from "../db/client";
import type { DB } from "../db/schema.generated";

export interface RecordedQuery {
  sql: string;
  parameters: readonly unknown[];
}

export interface FakeDb {
  db: Db;
  /** "begin", "commit", "rollback" и SQL запросов — в порядке выполнения. */
  log: string[];
  queries: RecordedQuery[];
}

export function fakeDb(respond: (query: RecordedQuery) => unknown[] = () => []): FakeDb {
  const log: string[] = [];
  const queries: RecordedQuery[] = [];

  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const query = { sql: compiled.sql, parameters: compiled.parameters };
      queries.push(query);
      log.push(compiled.sql);
      return { rows: respond(query) as R[] };
    },
    // biome-ignore lint/correctness/useYield: потоковые запросы в тестах не нужны
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error("fakeDb: streamQuery не поддерживается");
    },
  };

  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {
      log.push("begin");
    },
    async commitTransaction() {
      log.push("commit");
    },
    async rollbackTransaction() {
      log.push("rollback");
    },
    async releaseConnection() {},
    async destroy() {},
  };

  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, log, queries };
}
