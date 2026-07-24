import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { describe, expect, it } from 'vitest';

import { applyMigrations, migrations } from './schema';

describe('storage migrations', () => {
  it('creates the v1 schema and is idempotent', async () => {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(':memory:', 'c');

    try {
      applyMigrations(db, '2026-07-24T00:00:00.000Z');
      applyMigrations(db, '2026-07-24T00:00:00.000Z');

      const appliedVersions = db.exec({
        sql: 'SELECT version FROM schema_migrations ORDER BY version',
        rowMode: 0,
        returnValue: 'resultRows',
      });
      const tableNames = db.exec({
        sql: `
          SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name
        `,
        rowMode: 0,
        returnValue: 'resultRows',
      });

      expect(appliedVersions).toEqual(migrations.map((migration) => migration.version));
      expect(tableNames).toEqual(['books', 'reading_progress', 'schema_migrations', 'word_cards']);
    } finally {
      db.close();
    }
  });

  it('enforces progress percentage bounds and book references', async () => {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(':memory:', 'c');

    try {
      applyMigrations(db);

      expect(() =>
        db.exec(`
          INSERT INTO reading_progress (
            id, book_id, locator_json, percentage, updated_at, device_id, version
          ) VALUES ('progress-1', 'missing-book', '{}', 120, 'now', 'device', 1)
        `),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('prevents duplicate active cards from the same reading context', async () => {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(':memory:', 'c');

    try {
      applyMigrations(db);
      const insert = `
        INSERT INTO word_cards (
          id, term, normalized_term, part_of_speech, definition, dictionary_source,
          source_book_title, source_sentence, created_at, updated_at, version
        ) VALUES (?, 'resilient', 'resilient', 'adjective', 'able to recover',
          'Princeton WordNet 3.1', 'Anchored Pages', 'A resilient reader.', 'now', 'now', 1)
      `;

      db.exec({ sql: insert, bind: ['card-1'] });
      expect(() => db.exec({ sql: insert, bind: ['card-2'] })).toThrow();
      db.exec("UPDATE word_cards SET deleted_at = 'later' WHERE id = 'card-1'");
      expect(() => db.exec({ sql: insert, bind: ['card-2'] })).not.toThrow();
    } finally {
      db.close();
    }
  });
});
