// Подключение к Postgres: Kysely поверх `pg`, свой пул на каждый запрос.
// Worker не может держать соединение между запросами — пулом соединений с базой
// занимается Hyperdrive, здесь пул живёт ровно один запрос.
//
// Кэш запросов Hyperdrive для этой базы должен быть выключен: под RLS результат
// SELECT зависит от актора (GUC транзакции), а ключ кэша — только текст запроса
// и параметры. С кэшем один актор мог бы получить строки, выбранные для другого.

import { Kysely, PostgresDialect } from "kysely";
import { Pool, TypeOverrides } from "pg";
import type { DB } from "./schema.generated";

export type Db = Kysely<DB>;

// OID типа date. Оставляем строкой «YYYY-MM-DD»: pg по умолчанию делает из неё
// Date в локальном часовом поясе и сдвигает дату события (типы — dateParser: string)
const DATE_OID = 1082;

export function createDb(connectionString: string): Db {
  const types = new TypeOverrides();
  types.setTypeParser(DATE_OID, (value: string) => value);

  const pool = new Pool({
    connectionString,
    types,
    // Одно соединение на запрос: запросы внутри запроса идут по очереди, и всё,
    // что выполняется под актором, остаётся в его транзакции (см. withActor)
    max: 1,
    // Запрос к базе в обход открытой транзакции ждал бы соединение вечно —
    // пусть лучше упадёт
    connectionTimeoutMillis: 10_000,
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
