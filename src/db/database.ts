import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";

export type SqliteDatabase = BetterSqlite3.Database;

export function openDatabase(databasePath: string): SqliteDatabase {
  const resolvedPath = databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (resolvedPath !== ":memory:") {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  }

  const database = new BetterSqlite3(resolvedPath);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (resolvedPath !== ":memory:") {
    database.pragma("journal_mode = WAL");
  }

  migrate(database);
  return database;
}

function migrate(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      display_name TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('awaiting_email', 'awaiting_code', 'ready')),
      email_encrypted TEXT,
      email_verified_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      telegram_id INTEGER PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
      pending_email_encrypted TEXT NOT NULL,
      code_mac TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS search_results (
      token TEXT PRIMARY KEY,
      telegram_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL DEFAULT 'fourtoutici',
      file_id TEXT NOT NULL,
      original_name TEXT NOT NULL,
      provider_cover_url TEXT,
      extension TEXT NOT NULL,
      size INTEGER NOT NULL,
      description TEXT NOT NULL,
      downloads INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      delivered_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS search_results_user_idx
      ON search_results(telegram_id, expires_at);
  `);

  ensureColumn(database, "search_results", "provider_id", "TEXT NOT NULL DEFAULT 'fourtoutici'");
  ensureColumn(database, "search_results", "provider_cover_url", "TEXT");
}

function ensureColumn(
  database: SqliteDatabase,
  table: string,
  column: string,
  declaration: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((existing) => existing.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}
