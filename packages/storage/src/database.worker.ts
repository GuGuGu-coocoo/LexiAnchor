/// <reference lib="webworker" />

import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';

import type { DatabaseRequest, DatabaseResponse } from './protocol';
import { applyMigrations } from './schema';
import type {
  ApplicationDataSnapshot,
  BookRecord,
  ReadingProgressRecord,
  StorageStatus,
  WordCardRecord,
} from './types';

interface BookRow {
  readonly id: string;
  readonly title: string;
  readonly author: string;
  readonly format: 'epub' | 'pdf';
  readonly language: string | null;
  readonly cover_ref: string | null;
  readonly content_ref: string;
  readonly content_hash: string;
  readonly file_size: number;
  readonly imported_at: string;
  readonly last_opened_at: string | null;
  readonly metadata_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
  readonly version: number;
}

interface ProgressRow {
  readonly id: string;
  readonly book_id: string;
  readonly locator_json: string;
  readonly percentage: number;
  readonly updated_at: string;
  readonly device_id: string;
  readonly version: number;
}

interface WordCardRow {
  readonly id: string;
  readonly term: string;
  readonly normalized_term: string;
  readonly part_of_speech: string;
  readonly definition: string;
  readonly root_or_etymology: string | null;
  readonly dictionary_source: string;
  readonly source_book_id: string | null;
  readonly source_book_title: string;
  readonly source_sentence: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
  readonly version: number;
}

interface DatabaseContext {
  readonly db: Database;
  readonly status: StorageStatus;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createDatabase(): Promise<DatabaseContext> {
  const sqlite3 = await sqlite3InitModule();
  let db: Database;
  let persistence: StorageStatus['persistence'] = 'memory';

  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({
      name: 'lexianchor-sahpool',
      directory: '/lexianchor/sqlite',
      initialCapacity: 6,
    });
    db = new pool.OpfsSAHPoolDb('/lexianchor.sqlite3');
    persistence = 'opfs-sahpool';
  } catch (error) {
    console.warn(
      'Persistent SQLite is unavailable; using an in-memory database.',
      errorMessage(error),
    );
    db = new sqlite3.oo1.DB(':memory:', 'c');
  }

  applyMigrations(db);
  return {
    db,
    status: {
      sqliteVersion: sqlite3.version.libVersion,
      persistence,
    },
  };
}

function mapBook(row: BookRow): BookRecord {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    format: row.format,
    language: row.language,
    coverRef: row.cover_ref,
    contentRef: row.content_ref,
    contentHash: row.content_hash,
    fileSize: row.file_size,
    importedAt: row.imported_at,
    lastOpenedAt: row.last_opened_at,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    version: row.version,
  };
}

function mapProgress(row: ProgressRow): ReadingProgressRecord {
  const locator: unknown = JSON.parse(row.locator_json);

  return {
    id: row.id,
    bookId: row.book_id,
    locator: locator as ReadingProgressRecord['locator'],
    percentage: row.percentage,
    updatedAt: row.updated_at,
    deviceId: row.device_id,
    version: row.version,
  };
}

function mapWordCard(row: WordCardRow): WordCardRecord {
  return {
    id: row.id,
    term: row.term,
    normalizedTerm: row.normalized_term,
    partOfSpeech: row.part_of_speech,
    definition: row.definition,
    rootOrEtymology: row.root_or_etymology,
    dictionarySource: row.dictionary_source,
    sourceBookId: row.source_book_id,
    sourceBookTitle: row.source_book_title,
    sourceSentence: row.source_sentence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    version: row.version,
  };
}

function wordCardSearchExpression(query: string): string {
  return query
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(' AND ');
}

function saveWordCard(db: Database, card: WordCardRecord): void {
  db.exec({
    sql: `
      INSERT INTO word_cards (
        id, term, normalized_term, part_of_speech, definition, root_or_etymology,
        dictionary_source, source_book_id, source_book_title, source_sentence,
        created_at, updated_at, deleted_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET
        term = excluded.term,
        normalized_term = excluded.normalized_term,
        part_of_speech = excluded.part_of_speech,
        definition = excluded.definition,
        root_or_etymology = excluded.root_or_etymology,
        dictionary_source = excluded.dictionary_source,
        source_book_id = COALESCE(excluded.source_book_id, word_cards.source_book_id),
        source_book_title = excluded.source_book_title,
        source_sentence = excluded.source_sentence,
        created_at = MIN(word_cards.created_at, excluded.created_at),
        updated_at = excluded.updated_at,
        deleted_at = NULL,
        version = MAX(word_cards.version + 1, excluded.version)
    `,
    bind: [
      card.id,
      card.term,
      card.normalizedTerm,
      card.partOfSpeech,
      card.definition,
      card.rootOrEtymology,
      card.dictionarySource,
      card.sourceBookId,
      card.sourceBookTitle,
      card.sourceSentence,
      card.createdAt,
      card.updatedAt,
      card.deletedAt,
      card.version,
    ],
  });
}

const contextPromise = createDatabase();

async function handleRequest(request: DatabaseRequest) {
  const context = await contextPromise;

  switch (request.type) {
    case 'initialize':
      return context.status;
    case 'list-books': {
      const rows = context.db.exec({
        sql: `
          SELECT * FROM books
          WHERE deleted_at IS NULL
          ORDER BY COALESCE(last_opened_at, imported_at) DESC, title COLLATE NOCASE
        `,
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as unknown as BookRow[];
      return rows.map(mapBook);
    }
    case 'save-book': {
      const book = request.book;
      context.db.exec({
        sql: `
          INSERT INTO books (
            id, title, author, format, language, cover_ref, content_ref, content_hash,
            file_size, imported_at, last_opened_at, metadata_json, created_at, updated_at,
            deleted_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            author = excluded.author,
            language = excluded.language,
            cover_ref = excluded.cover_ref,
            last_opened_at = excluded.last_opened_at,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at,
            version = MAX(books.version + 1, excluded.version)
        `,
        bind: [
          book.id,
          book.title,
          book.author,
          book.format,
          book.language,
          book.coverRef,
          book.contentRef,
          book.contentHash,
          book.fileSize,
          book.importedAt,
          book.lastOpenedAt,
          JSON.stringify(book.metadata),
          book.createdAt,
          book.updatedAt,
          book.deletedAt,
          book.version,
        ],
      });
      return undefined;
    }
    case 'delete-book': {
      context.db.exec('BEGIN IMMEDIATE');

      try {
        context.db.exec({
          sql: `
            UPDATE books
            SET deleted_at = ?, updated_at = ?, version = version + 1
            WHERE id = ? AND deleted_at IS NULL
          `,
          bind: [request.deletedAt, request.deletedAt, request.bookId],
        });

        if (!request.options.keepProgress) {
          context.db.exec({
            sql: 'DELETE FROM reading_progress WHERE book_id = ?',
            bind: [request.bookId],
          });
        }

        if (!request.options.keepWordCards) {
          context.db.exec({
            sql: `
              UPDATE word_cards
              SET deleted_at = ?, updated_at = ?, version = version + 1
              WHERE source_book_id = ? AND deleted_at IS NULL
            `,
            bind: [request.deletedAt, request.deletedAt, request.bookId],
          });
        }

        context.db.exec('COMMIT');
      } catch (error) {
        context.db.exec('ROLLBACK');
        throw error;
      }
      return undefined;
    }
    case 'get-progress': {
      const rows = context.db.exec({
        sql: 'SELECT * FROM reading_progress WHERE book_id = ? LIMIT 1',
        bind: [request.bookId],
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as unknown as ProgressRow[];
      return rows[0] ? mapProgress(rows[0]) : null;
    }
    case 'save-progress': {
      const progress = request.progress;
      context.db.exec('BEGIN IMMEDIATE');

      try {
        context.db.exec({
          sql: `
            INSERT INTO reading_progress (
              id, book_id, locator_json, percentage, updated_at, device_id, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(book_id) DO UPDATE SET
              locator_json = excluded.locator_json,
              percentage = excluded.percentage,
              updated_at = excluded.updated_at,
              device_id = excluded.device_id,
              version = reading_progress.version + 1
          `,
          bind: [
            progress.id,
            progress.bookId,
            JSON.stringify(progress.locator),
            progress.percentage,
            progress.updatedAt,
            progress.deviceId,
            progress.version,
          ],
        });
        context.db.exec({
          sql: `
            UPDATE books
            SET last_opened_at = ?, updated_at = ?, version = version + 1
            WHERE id = ? AND deleted_at IS NULL
          `,
          bind: [progress.updatedAt, progress.updatedAt, progress.bookId],
        });
        context.db.exec('COMMIT');
      } catch (error) {
        context.db.exec('ROLLBACK');
        throw error;
      }
      return undefined;
    }
    case 'export-data-snapshot': {
      const bookRows = context.db.exec({
        sql: `
          SELECT * FROM books
          WHERE deleted_at IS NULL
             OR EXISTS (SELECT 1 FROM reading_progress WHERE reading_progress.book_id = books.id)
             OR EXISTS (
               SELECT 1 FROM word_cards
               WHERE word_cards.source_book_id = books.id
                 AND word_cards.deleted_at IS NULL
             )
          ORDER BY created_at, id
        `,
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as unknown as BookRow[];
      const progressRows = context.db.exec({
        sql: 'SELECT * FROM reading_progress ORDER BY updated_at, id',
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as unknown as ProgressRow[];
      const wordCardRows = context.db.exec({
        sql: `
          SELECT * FROM word_cards
          WHERE deleted_at IS NULL
          ORDER BY created_at, id
        `,
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as unknown as WordCardRow[];
      const snapshot: ApplicationDataSnapshot = {
        books: bookRows.map(mapBook),
        progress: progressRows.map(mapProgress),
        wordCards: wordCardRows.map(mapWordCard),
      };
      return snapshot;
    }
    case 'restore-data-snapshot': {
      const { books, progress, wordCards } = request.snapshot;
      context.db.exec('BEGIN IMMEDIATE');

      try {
        for (const book of books) {
          context.db.exec({
            sql: `
              INSERT INTO books (
                id, title, author, format, language, cover_ref, content_ref, content_hash,
                file_size, imported_at, last_opened_at, metadata_json, created_at, updated_at,
                deleted_at, version
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                author = excluded.author,
                format = excluded.format,
                language = excluded.language,
                cover_ref = excluded.cover_ref,
                content_ref = excluded.content_ref,
                content_hash = excluded.content_hash,
                file_size = excluded.file_size,
                imported_at = excluded.imported_at,
                last_opened_at = excluded.last_opened_at,
                metadata_json = excluded.metadata_json,
                created_at = MIN(books.created_at, excluded.created_at),
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at,
                version = MAX(books.version, excluded.version)
            `,
            bind: [
              book.id,
              book.title,
              book.author,
              book.format,
              book.language,
              book.coverRef,
              book.contentRef,
              book.contentHash,
              book.fileSize,
              book.importedAt,
              book.lastOpenedAt,
              JSON.stringify(book.metadata),
              book.createdAt,
              book.updatedAt,
              book.deletedAt,
              book.version,
            ],
          });
        }

        for (const item of progress) {
          context.db.exec({
            sql: `
              INSERT INTO reading_progress (
                id, book_id, locator_json, percentage, updated_at, device_id, version
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(book_id) DO UPDATE SET
                locator_json = excluded.locator_json,
                percentage = excluded.percentage,
                updated_at = excluded.updated_at,
                device_id = excluded.device_id,
                version = MAX(reading_progress.version, excluded.version)
            `,
            bind: [
              item.id,
              item.bookId,
              JSON.stringify(item.locator),
              item.percentage,
              item.updatedAt,
              item.deviceId,
              item.version,
            ],
          });
        }

        for (const card of wordCards) {
          saveWordCard(context.db, card);
        }

        context.db.exec('COMMIT');
      } catch (error) {
        context.db.exec('ROLLBACK');
        throw error;
      }
      return undefined;
    }
    case 'list-word-cards': {
      const query = request.query.trim();
      const rows = context.db.exec({
        sql: query
          ? `
              SELECT word_cards.*
              FROM word_cards
              JOIN word_cards_fts ON word_cards_fts.rowid = word_cards.rowid
              WHERE word_cards_fts MATCH ?
                AND word_cards.deleted_at IS NULL
              ORDER BY word_cards.created_at DESC, word_cards.term COLLATE NOCASE
              LIMIT 200
            `
          : `
              SELECT * FROM word_cards
              WHERE deleted_at IS NULL
              ORDER BY created_at DESC, term COLLATE NOCASE
              LIMIT 200
            `,
        bind: query ? [wordCardSearchExpression(query)] : undefined,
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as unknown as WordCardRow[];
      return rows.map(mapWordCard);
    }
    case 'save-word-card': {
      saveWordCard(context.db, request.card);
      return undefined;
    }
    case 'import-word-cards':
      context.db.exec('BEGIN IMMEDIATE');

      try {
        for (const card of request.cards) {
          saveWordCard(context.db, card);
        }
        context.db.exec('COMMIT');
      } catch (error) {
        context.db.exec('ROLLBACK');
        throw error;
      }
      return undefined;
    case 'update-word-card': {
      const card = request.card;
      context.db.exec({
        sql: `
          UPDATE word_cards
          SET term = ?,
              normalized_term = ?,
              part_of_speech = ?,
              definition = ?,
              root_or_etymology = ?,
              source_book_title = ?,
              source_sentence = ?,
              updated_at = ?,
              deleted_at = NULL,
              version = version + 1
          WHERE id = ? AND deleted_at IS NULL
        `,
        bind: [
          card.term,
          card.normalizedTerm,
          card.partOfSpeech,
          card.definition,
          card.rootOrEtymology,
          card.sourceBookTitle,
          card.sourceSentence,
          card.updatedAt,
          card.id,
        ],
      });
      return undefined;
    }
    case 'delete-word-card':
      context.db.exec({
        sql: `
          UPDATE word_cards
          SET deleted_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND deleted_at IS NULL
        `,
        bind: [request.deletedAt, request.deletedAt, request.cardId],
      });
      return undefined;
    case 'close':
      context.db.close();
      return undefined;
  }
}

self.addEventListener('message', (event: MessageEvent<DatabaseRequest>) => {
  const request = event.data;

  void handleRequest(request)
    .then((result) => {
      const response: DatabaseResponse = { id: request.id, ok: true, result };
      self.postMessage(response);
    })
    .catch((error: unknown) => {
      const response: DatabaseResponse = {
        id: request.id,
        ok: false,
        error: errorMessage(error),
      };
      self.postMessage(response);
    });
});
