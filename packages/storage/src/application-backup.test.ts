import { describe, expect, it } from 'vitest';

import { createApplicationBackup, restoreApplicationBackup } from './application-backup';
import { sha256 } from './content-store';
import type {
  ApplicationDataSnapshot,
  BookRepository,
  ContentStore,
  ReadingProgressRecord,
  StorageStatus,
} from './types';

function repositories(initial: ApplicationDataSnapshot) {
  let snapshot = structuredClone(initial);
  const repository: BookRepository = {
    initialize: () =>
      Promise.resolve({ sqliteVersion: 'test', persistence: 'memory' } satisfies StorageStatus),
    listBooks: () => Promise.resolve([...snapshot.books]),
    saveBook: () => Promise.resolve(),
    deleteBook: () => Promise.resolve(),
    getProgress: (bookId) =>
      Promise.resolve(snapshot.progress.find((item) => item.bookId === bookId) ?? null),
    saveProgress: () => Promise.resolve(),
    exportDataSnapshot: () => Promise.resolve(structuredClone(snapshot)),
    restoreDataSnapshot: (value) => {
      snapshot = structuredClone(value);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  return { repository, snapshot: () => snapshot };
}

function contentStores() {
  const values = new Map<string, ArrayBuffer>();
  const store: ContentStore = {
    put: (key, data) => {
      values.set(key, data.slice(0));
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(values.get(key)?.slice(0) ?? null),
    delete: (key) => {
      values.delete(key);
      return Promise.resolve();
    },
  };
  return { store, values };
}

async function fixture() {
  const bookData = new TextEncoder().encode('project-owned EPUB fixture').buffer;
  const hash = await sha256(bookData);
  const now = '2026-07-26T00:00:00.000Z';
  const progress: ReadingProgressRecord = {
    id: `progress-book-${hash}`,
    bookId: `book-${hash}`,
    locator: { href: 'chapter.xhtml', progression: 0.5 },
    percentage: 50,
    updatedAt: now,
    deviceId: 'device-test',
    version: 2,
  };
  const snapshot: ApplicationDataSnapshot = {
    books: [
      {
        id: `book-${hash}`,
        title: 'Anchored Reading',
        author: '',
        format: 'epub',
        language: null,
        coverRef: null,
        contentRef: hash,
        contentHash: hash,
        fileSize: bookData.byteLength,
        importedAt: now,
        lastOpenedAt: now,
        metadata: { originalFileName: 'anchored.epub' },
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
      },
    ],
    progress: [progress],
    wordCards: [
      {
        id: 'card-1',
        term: 'anchor',
        normalizedTerm: 'anchor',
        partOfSpeech: 'noun',
        definition: 'a source of stability',
        rootOrEtymology: null,
        dictionarySource: 'test',
        sourceBookId: `book-${hash}`,
        sourceBookTitle: 'Anchored Reading',
        sourceSentence: 'An anchor is useful.',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
      },
    ],
  };
  return { snapshot, bookData, hash };
}

describe('application backup', () => {
  it('round-trips settings, records, and an integrity-checked book', async () => {
    const { snapshot, bookData, hash } = await fixture();
    const sourceRepository = repositories(snapshot);
    const sourceContent = contentStores();
    await sourceContent.store.put(hash, bookData);
    const backup = await createApplicationBackup(sourceRepository.repository, sourceContent.store, {
      includeBookFiles: true,
      settings: { 'lexianchor:theme': 'eye-care' },
      exportedAt: '2026-07-26T01:00:00.000Z',
    });
    const targetRepository = repositories({ books: [], progress: [], wordCards: [] });
    const targetContent = contentStores();
    const restored = await restoreApplicationBackup(
      backup,
      targetRepository.repository,
      targetContent.store,
    );

    expect(restored.settings).toEqual({ 'lexianchor:theme': 'eye-care' });
    expect(restored.counts).toEqual({ books: 1, progress: 1, wordCards: 1 });
    expect(targetRepository.snapshot()).toEqual(snapshot);
    expect(new Uint8Array(targetContent.values.get(hash) ?? new ArrayBuffer(0))).toEqual(
      new Uint8Array(bookData),
    );
  });

  it('keeps progress but hides a book when its file was not included', async () => {
    const { snapshot } = await fixture();
    const sourceRepository = repositories(snapshot);
    const sourceContent = contentStores();
    const backup = await createApplicationBackup(sourceRepository.repository, sourceContent.store, {
      includeBookFiles: false,
      settings: {},
      exportedAt: '2026-07-26T01:00:00.000Z',
    });
    const targetRepository = repositories({ books: [], progress: [], wordCards: [] });

    await restoreApplicationBackup(backup, targetRepository.repository, contentStores().store);

    expect(targetRepository.snapshot().books[0]?.deletedAt).toBe('2026-07-26T01:00:00.000Z');
    expect(targetRepository.snapshot().progress).toHaveLength(1);
  });
});
