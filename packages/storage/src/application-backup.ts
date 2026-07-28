import { sha256 } from './content-store';
import type {
  ApplicationDataSnapshot,
  BookRecord,
  BookRepository,
  ContentStore,
  ReadingProgressRecord,
  WordCardRecord,
} from './types';
import { createStoredZip, readStoredZip, type ZipStoreEntry } from './zip-store';

const backupSchema = 'lexianchor.backup';
const backupVersion = 1;

export interface ApplicationBackupOptions {
  readonly includeBookFiles: boolean;
  readonly settings: Readonly<Record<string, string>>;
  readonly exportedAt?: string;
}

export interface ApplicationBackupResult {
  readonly settings: Readonly<Record<string, string>>;
  readonly includesBookFiles: boolean;
  readonly counts: {
    readonly books: number;
    readonly progress: number;
    readonly wordCards: number;
  };
}

interface ContentManifestEntry {
  readonly bookId: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

interface BackupManifest {
  readonly schema: typeof backupSchema;
  readonly version: typeof backupVersion;
  readonly exportedAt: string;
  readonly includesBookFiles: boolean;
  readonly counts: ApplicationBackupResult['counts'];
  readonly content: readonly ContentManifestEntry[];
}

type DataLine =
  | { readonly type: 'settings'; readonly value: Readonly<Record<string, string>> }
  | { readonly type: 'book'; readonly value: BookRecord }
  | { readonly type: 'progress'; readonly value: ReadingProgressRecord }
  | { readonly type: 'word-card'; readonly value: WordCardRecord };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isTimestamp(value: unknown): value is string {
  return isString(value) && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value >= 1;
}

function isHash(value: unknown): value is string {
  return isString(value) && /^[a-f0-9]{64}$/.test(value);
}

function isAllowedSettingKey(key: string): boolean {
  return (
    [
      'lexianchor:theme',
      'lexianchor:locale',
      'lexianchor:dictionary-preferences',
      'lexianchor:library-sort',
      'lexianchor:translation-target',
      'lexianchor:reader-preferences',
      'lexianchor:reader-presets',
    ].includes(key) || key.startsWith('lexianchor:reader-preferences:')
  );
}

function parseSettings(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw new Error('Backup settings are invalid.');
  }
  const settings: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isAllowedSettingKey(key) || !isString(item)) {
      throw new Error('Backup settings contain an invalid entry.');
    }
    settings[key] = item;
  }
  return settings;
}

function parseBook(value: unknown): BookRecord {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.title) ||
    !isString(value.author) ||
    (value.format !== 'epub' && value.format !== 'pdf') ||
    !isNullableString(value.language) ||
    !isNullableString(value.coverRef) ||
    !isHash(value.contentRef) ||
    !isHash(value.contentHash) ||
    value.contentRef !== value.contentHash ||
    value.id !== `book-${value.contentHash}` ||
    !isNonNegativeInteger(value.fileSize) ||
    !isTimestamp(value.importedAt) ||
    !isNullableString(value.lastOpenedAt) ||
    (value.lastOpenedAt !== null && !isTimestamp(value.lastOpenedAt)) ||
    !isRecord(value.metadata) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isNullableString(value.deletedAt) ||
    (value.deletedAt !== null && !isTimestamp(value.deletedAt)) ||
    !isPositiveInteger(value.version)
  ) {
    throw new Error('Backup contains an invalid book record.');
  }
  return value as unknown as BookRecord;
}

function parseProgress(value: unknown): ReadingProgressRecord {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.bookId) ||
    !isRecord(value.locator) ||
    !isString(value.locator.href) ||
    typeof value.percentage !== 'number' ||
    !Number.isFinite(value.percentage) ||
    value.percentage < 0 ||
    value.percentage > 100 ||
    !isTimestamp(value.updatedAt) ||
    !isString(value.deviceId) ||
    !isPositiveInteger(value.version)
  ) {
    throw new Error('Backup contains an invalid reading progress record.');
  }
  return value as unknown as ReadingProgressRecord;
}

function parseWordCard(value: unknown): WordCardRecord {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.term) ||
    !isString(value.normalizedTerm) ||
    !isString(value.partOfSpeech) ||
    !isString(value.definition) ||
    !isNullableString(value.rootOrEtymology) ||
    !isString(value.dictionarySource) ||
    !isNullableString(value.sourceBookId) ||
    !isString(value.sourceBookTitle) ||
    !isString(value.sourceSentence) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isNullableString(value.deletedAt) ||
    (value.deletedAt !== null && !isTimestamp(value.deletedAt)) ||
    !isPositiveInteger(value.version)
  ) {
    throw new Error('Backup contains an invalid word-card record.');
  }
  const definitions = Array.isArray(value.definitions)
    ? value.definitions
        .filter(isString)
        .map((definition) => definition.trim())
        .filter(Boolean)
    : [];

  return {
    ...(value as unknown as WordCardRecord),
    definitions: definitions.length > 0 ? definitions : [value.definition],
  };
}

function dataLines(snapshot: ApplicationDataSnapshot, settings: Readonly<Record<string, string>>) {
  const lines: DataLine[] = [{ type: 'settings', value: settings }];
  lines.push(...snapshot.books.map((value) => ({ type: 'book' as const, value })));
  lines.push(...snapshot.progress.map((value) => ({ type: 'progress' as const, value })));
  lines.push(...snapshot.wordCards.map((value) => ({ type: 'word-card' as const, value })));
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

function parseManifest(value: unknown): BackupManifest {
  if (
    !isRecord(value) ||
    value.schema !== backupSchema ||
    value.version !== backupVersion ||
    !isTimestamp(value.exportedAt) ||
    typeof value.includesBookFiles !== 'boolean' ||
    !isRecord(value.counts) ||
    !isNonNegativeInteger(value.counts.books) ||
    !isNonNegativeInteger(value.counts.progress) ||
    !isNonNegativeInteger(value.counts.wordCards) ||
    !Array.isArray(value.content)
  ) {
    throw new Error('This is not a supported LexiAnchor backup.');
  }

  const content = value.content.map((item) => {
    if (
      !isRecord(item) ||
      !isString(item.bookId) ||
      !isString(item.path) ||
      !item.path.startsWith('optional-content/books/') ||
      !isHash(item.sha256) ||
      !isNonNegativeInteger(item.size)
    ) {
      throw new Error('Backup content manifest is invalid.');
    }
    return item as unknown as ContentManifestEntry;
  });

  return {
    schema: backupSchema,
    version: backupVersion,
    exportedAt: value.exportedAt,
    includesBookFiles: value.includesBookFiles,
    counts: {
      books: value.counts.books,
      progress: value.counts.progress,
      wordCards: value.counts.wordCards,
    },
    content,
  };
}

function parseData(value: string): {
  readonly snapshot: ApplicationDataSnapshot;
  readonly settings: Readonly<Record<string, string>>;
} {
  const books: BookRecord[] = [];
  const progress: ReadingProgressRecord[] = [];
  const wordCards: WordCardRecord[] = [];
  let settings: Readonly<Record<string, string>> | null = null;

  for (const rawLine of value.split('\n')) {
    if (!rawLine.trim()) {
      continue;
    }
    const line: unknown = JSON.parse(rawLine);
    if (!isRecord(line) || !isString(line.type) || !('value' in line)) {
      throw new Error('Backup data contains an invalid line.');
    }
    switch (line.type) {
      case 'settings':
        if (settings) {
          throw new Error('Backup contains duplicate settings.');
        }
        settings = parseSettings(line.value);
        break;
      case 'book':
        books.push(parseBook(line.value));
        break;
      case 'progress':
        progress.push(parseProgress(line.value));
        break;
      case 'word-card':
        wordCards.push(parseWordCard(line.value));
        break;
      default:
        throw new Error(`Unsupported backup record type: ${line.type}`);
    }
  }

  if (!settings) {
    throw new Error('Backup settings are missing.');
  }
  const bookIds = new Set(books.map((book) => book.id));
  if (
    bookIds.size !== books.length ||
    progress.some((item) => !bookIds.has(item.bookId)) ||
    wordCards.some((card) => card.sourceBookId !== null && !bookIds.has(card.sourceBookId))
  ) {
    throw new Error('Backup record relationships are invalid.');
  }
  return { snapshot: { books, progress, wordCards }, settings };
}

function countsFor(snapshot: ApplicationDataSnapshot): ApplicationBackupResult['counts'] {
  return {
    books: snapshot.books.length,
    progress: snapshot.progress.length,
    wordCards: snapshot.wordCards.length,
  };
}

export async function createApplicationBackup(
  repository: BookRepository,
  contentStore: ContentStore,
  options: ApplicationBackupOptions,
): Promise<Uint8Array> {
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  if (!isTimestamp(exportedAt)) {
    throw new Error('Backup export time is invalid.');
  }
  const snapshot = await repository.exportDataSnapshot();
  const content: ContentManifestEntry[] = [];
  const entries: ZipStoreEntry[] = [];

  if (options.includeBookFiles) {
    for (const book of snapshot.books.filter((item) => item.deletedAt === null)) {
      const data = await contentStore.get(book.contentRef);
      if (!data) {
        throw new Error(`The local file for “${book.title}” is missing.`);
      }
      const actualHash = await sha256(data);
      if (actualHash !== book.contentHash || data.byteLength !== book.fileSize) {
        throw new Error(`The local file for “${book.title}” failed its integrity check.`);
      }
      const path = `optional-content/books/${book.contentHash}.${book.format}`;
      content.push({
        bookId: book.id,
        path,
        sha256: book.contentHash,
        size: data.byteLength,
      });
      entries.push({ name: path, data: new Uint8Array(data) });
    }
  }

  const manifest: BackupManifest = {
    schema: backupSchema,
    version: backupVersion,
    exportedAt,
    includesBookFiles: options.includeBookFiles,
    counts: countsFor(snapshot),
    content,
  };
  entries.unshift(
    { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) },
    { name: 'data.jsonl', data: new TextEncoder().encode(dataLines(snapshot, options.settings)) },
  );
  return createStoredZip(entries, new Date(exportedAt));
}

export async function restoreApplicationBackup(
  input: ArrayBuffer | Uint8Array,
  repository: BookRepository,
  contentStore: ContentStore,
): Promise<ApplicationBackupResult> {
  const files = readStoredZip(input);
  const manifestFile = files.get('manifest.json');
  const dataFile = files.get('data.jsonl');
  if (!manifestFile || !dataFile) {
    throw new Error('The backup is missing manifest.json or data.jsonl.');
  }
  const manifest = parseManifest(JSON.parse(new TextDecoder().decode(manifestFile)));
  const parsed = parseData(new TextDecoder('utf-8', { fatal: true }).decode(dataFile));
  const counts = countsFor(parsed.snapshot);
  if (
    counts.books !== manifest.counts.books ||
    counts.progress !== manifest.counts.progress ||
    counts.wordCards !== manifest.counts.wordCards
  ) {
    throw new Error('Backup record counts do not match the manifest.');
  }

  const contentByBook = new Map<string, ArrayBuffer>();
  for (const item of manifest.content) {
    const book = parsed.snapshot.books.find((candidate) => candidate.id === item.bookId);
    const file = files.get(item.path);
    if (
      !book ||
      book.deletedAt !== null ||
      item.sha256 !== book.contentHash ||
      item.size !== book.fileSize ||
      !file ||
      file.byteLength !== item.size ||
      (await sha256(file.slice().buffer)) !== item.sha256 ||
      contentByBook.has(item.bookId)
    ) {
      throw new Error('A backed-up book failed its integrity check.');
    }
    contentByBook.set(item.bookId, file.slice().buffer);
  }

  const activeBooks = parsed.snapshot.books.filter((book) => book.deletedAt === null);
  if (
    (!manifest.includesBookFiles && manifest.content.length > 0) ||
    (manifest.includesBookFiles && activeBooks.some((book) => !contentByBook.has(book.id)))
  ) {
    throw new Error('The backup does not contain all declared book files.');
  }

  for (const [bookId, data] of contentByBook) {
    const book = parsed.snapshot.books.find((candidate) => candidate.id === bookId);
    if (book) {
      await contentStore.put(book.contentRef, data);
    }
  }

  const books: BookRecord[] = [];
  for (const book of parsed.snapshot.books) {
    const contentExists =
      book.deletedAt !== null ||
      contentByBook.has(book.id) ||
      (await contentStore.get(book.contentRef)) !== null;
    books.push(
      contentExists
        ? book
        : {
            ...book,
            updatedAt: manifest.exportedAt,
            deletedAt: manifest.exportedAt,
            version: book.version + 1,
          },
    );
  }

  await repository.restoreDataSnapshot({ ...parsed.snapshot, books });
  return {
    settings: parsed.settings,
    includesBookFiles: manifest.includesBookFiles,
    counts,
  };
}
