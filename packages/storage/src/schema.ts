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
  {
    version: 2,
    sql: `
      CREATE TABLE word_cards (
        id TEXT PRIMARY KEY,
        term TEXT NOT NULL,
        normalized_term TEXT NOT NULL,
        part_of_speech TEXT NOT NULL,
        definition TEXT NOT NULL,
        root_or_etymology TEXT,
        dictionary_source TEXT NOT NULL,
        source_book_id TEXT REFERENCES books(id) ON DELETE SET NULL,
        source_book_title TEXT NOT NULL,
        source_sentence TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
      );

      CREATE INDEX word_cards_recent_idx
        ON word_cards(created_at DESC)
        WHERE deleted_at IS NULL;

      CREATE INDEX word_cards_term_idx
        ON word_cards(normalized_term COLLATE NOCASE)
        WHERE deleted_at IS NULL;

      CREATE UNIQUE INDEX word_cards_context_unique
        ON word_cards(normalized_term, source_book_title, source_sentence)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE VIRTUAL TABLE word_cards_fts USING fts5(
        term,
        definition,
        root_or_etymology,
        source_book_title,
        source_sentence,
        content='word_cards',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      INSERT INTO word_cards_fts(
        rowid, term, definition, root_or_etymology, source_book_title, source_sentence
      )
      SELECT rowid, term, definition, root_or_etymology, source_book_title, source_sentence
      FROM word_cards;

      CREATE TRIGGER word_cards_fts_after_insert
      AFTER INSERT ON word_cards
      BEGIN
        INSERT INTO word_cards_fts(
          rowid, term, definition, root_or_etymology, source_book_title, source_sentence
        ) VALUES (
          new.rowid, new.term, new.definition, new.root_or_etymology,
          new.source_book_title, new.source_sentence
        );
      END;

      CREATE TRIGGER word_cards_fts_after_delete
      AFTER DELETE ON word_cards
      BEGIN
        INSERT INTO word_cards_fts(
          word_cards_fts, rowid, term, definition, root_or_etymology,
          source_book_title, source_sentence
        ) VALUES (
          'delete', old.rowid, old.term, old.definition, old.root_or_etymology,
          old.source_book_title, old.source_sentence
        );
      END;

      CREATE TRIGGER word_cards_fts_after_update
      AFTER UPDATE ON word_cards
      BEGIN
        INSERT INTO word_cards_fts(
          word_cards_fts, rowid, term, definition, root_or_etymology,
          source_book_title, source_sentence
        ) VALUES (
          'delete', old.rowid, old.term, old.definition, old.root_or_etymology,
          old.source_book_title, old.source_sentence
        );
        INSERT INTO word_cards_fts(
          rowid, term, definition, root_or_etymology, source_book_title, source_sentence
        ) VALUES (
          new.rowid, new.term, new.definition, new.root_or_etymology,
          new.source_book_title, new.source_sentence
        );
      END;
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE word_cards
      ADD COLUMN definitions_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE word_cards
      ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1);
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
