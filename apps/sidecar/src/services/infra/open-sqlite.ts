import { createRequire } from "node:module";

export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface BunSqliteDatabase {
  exec(sql: string): void;
  query(sql: string): SqliteStatement;
  close(): void;
}

/** Opens a SQLite database on Bun (bun:sqlite) and Node (node:sqlite) behind one structural surface. */
export function openSqlite(path: string): SqliteDatabase {
  const runtimeRequire = createRequire(import.meta.url);
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const BunDatabase = (runtimeRequire("bun:sqlite") as {
      Database: new (path: string) => BunSqliteDatabase;
    }).Database;
    const db = new BunDatabase(path);
    return { exec: (sql) => db.exec(sql), prepare: (sql) => db.query(sql), close: () => db.close() };
  }
  const DatabaseSync = (runtimeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  }).DatabaseSync;
  return new DatabaseSync(path);
}
