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
          WHERE type = 'table'
            AND name IN ('books', 'reading_progress', 'word_cards', 'word_cards_fts')
          ORDER BY name
        `,
        rowMode: 0,
        returnValue: 'resultRows',
      });

      expect(appliedVersions).toEqual(migrations.map((migration) => migration.version));
      expect(tableNames).toEqual(['books', 'reading_progress', 'word_cards', 'word_cards_fts']);
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

  it('backfills full-text search when upgrading an existing v2 database', async () => {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(':memory:', 'c');

    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `);

      for (const migration of migrations.slice(0, 2)) {
        db.exec(migration.sql);
        db.exec({
          sql: 'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)',
          bind: [migration.version, '2026-07-27T00:00:00.000Z'],
        });
      }

      db.exec(`
        INSERT INTO word_cards (
          id, term, normalized_term, part_of_speech, definition, dictionary_source,
          source_book_title, source_sentence, created_at, updated_at, version
        ) VALUES (
          'card-before-fts', 'Attentive', 'attentive', 'adjective',
          'Paying close attention.', 'test', 'Existing Library',
          'An attentive reader notices details.', 'now', 'now', 1
        );
      `);

      applyMigrations(db, '2026-07-28T00:00:00.000Z');
      const matches = db.exec({
        sql: `
          SELECT word_cards.id
          FROM word_cards
          JOIN word_cards_fts ON word_cards_fts.rowid = word_cards.rowid
          WHERE word_cards_fts MATCH '"attentive"*'
        `,
        rowMode: 0,
        returnValue: 'resultRows',
      });

      expect(matches).toEqual(['card-before-fts']);
      expect(db.selectValue('SELECT MAX(version) FROM schema_migrations')).toBe(3);
    } finally {
      db.close();
    }
  });

  it('keeps full-text word-card search interactive with 100,000 records', async () => {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(':memory:', 'c');

    try {
      applyMigrations(db);
      db.exec(`
        WITH digits(value) AS (
          VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
        ),
        sequence(value) AS (
          SELECT
            ones.value
            + tens.value * 10
            + hundreds.value * 100
            + thousands.value * 1000
            + ten_thousands.value * 10000
          FROM digits AS ones
          CROSS JOIN digits AS tens
          CROSS JOIN digits AS hundreds
          CROSS JOIN digits AS thousands
          CROSS JOIN digits AS ten_thousands
        )
        INSERT INTO word_cards (
          id, term, normalized_term, part_of_speech, definition, dictionary_source,
          source_book_title, source_sentence, created_at, updated_at, version
        )
        SELECT
          printf('stress-card-%06d', value),
          CASE WHEN value = 98765 THEN 'Needleword' ELSE printf('term-%06d', value) END,
          CASE WHEN value = 98765 THEN 'needleword' ELSE printf('term-%06d', value) END,
          'noun',
          printf('Definition number %d', value),
          'LexiAnchor stress fixture',
          printf('Book %d', value % 500),
          printf('Sentence context number %d', value),
          '2026-07-28T00:00:00.000Z',
          '2026-07-28T00:00:00.000Z',
          1
        FROM sequence;
      `);

      const startedAt = performance.now();
      const results = db.exec({
        sql: `
          SELECT word_cards.id
          FROM word_cards
          JOIN word_cards_fts ON word_cards_fts.rowid = word_cards.rowid
          WHERE word_cards_fts MATCH '"needleword"*'
            AND word_cards.deleted_at IS NULL
          LIMIT 200
        `,
        rowMode: 0,
        returnValue: 'resultRows',
      });
      const elapsedMilliseconds = performance.now() - startedAt;
      const count = db.selectValue('SELECT COUNT(*) FROM word_cards');

      expect(count).toBe(100_000);
      expect(results).toEqual(['stress-card-098765']);
      expect(elapsedMilliseconds).toBeLessThan(1_000);
    } finally {
      db.close();
    }
  });
});
