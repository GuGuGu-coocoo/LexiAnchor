import type { Database } from '@sqlite.org/sqlite-wasm';

interface Migration {
  readonly version: number;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE books (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        format TEXT NOT NULL CHECK (format IN ('epub', 'pdf')),
        language TEXT,
        cover_ref TEXT,
        content_ref TEXT NOT NULL UNIQUE,
        content_hash TEXT NOT NULL UNIQUE,
        file_size INTEGER NOT NULL CHECK (file_size >= 0),
        imported_at TEXT NOT NULL,
        last_opened_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
      );

      CREATE INDEX books_recent_idx
        ON books(last_opened_at DESC, imported_at DESC)
        WHERE deleted_at IS NULL;

      CREATE TABLE reading_progress (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL UNIQUE REFERENCES books(id) ON DELETE CASCADE,
        locator_json TEXT NOT NULL,
        percentage REAL NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
        updated_at TEXT NOT NULL,
        device_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
      );
    `,
  },
] as const;

export function applyMigrations(db: Pick<Database, 'exec'>, appliedAt = new Date().toISOString()) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const rows = db.exec({
    sql: 'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
    rowMode: 'object',
    returnValue: 'resultRows',
  });
  const currentVersion = Number(rows[0]?.version ?? 0);

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }

    db.exec('BEGIN IMMEDIATE');

    try {
      db.exec(migration.sql);
      db.exec({
        sql: 'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)',
        bind: [migration.version, appliedAt],
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
