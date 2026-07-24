import type { DocumentFormat, ReaderLocator } from '@lexianchor/reader-core';

export interface BookRecord {
  readonly id: string;
  readonly title: string;
  readonly author: string;
  readonly format: DocumentFormat;
  readonly language: string | null;
  readonly coverRef: string | null;
  readonly contentRef: string;
  readonly contentHash: string;
  readonly fileSize: number;
  readonly importedAt: string;
  readonly lastOpenedAt: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly version: number;
}

export interface ReadingProgressRecord {
  readonly id: string;
  readonly bookId: string;
  readonly locator: ReaderLocator;
  readonly percentage: number;
  readonly updatedAt: string;
  readonly deviceId: string;
  readonly version: number;
}

export interface StorageStatus {
  readonly sqliteVersion: string;
  readonly persistence: 'opfs-sahpool' | 'memory';
}

export interface BookRepository {
  initialize(): Promise<StorageStatus>;
  listBooks(): Promise<BookRecord[]>;
  saveBook(book: BookRecord): Promise<void>;
  getProgress(bookId: string): Promise<ReadingProgressRecord | null>;
  saveProgress(progress: ReadingProgressRecord): Promise<void>;
  close(): Promise<void>;
}

export interface ContentStore {
  put(key: string, data: ArrayBuffer): Promise<void>;
  get(key: string): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
}

export interface SyncChange {
  readonly entityType: 'book' | 'reading-progress' | 'reader-preference' | 'word-card';
  readonly entityId: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface SyncProvider {
  push(changes: readonly SyncChange[]): Promise<void>;
  pull(since: string | null): Promise<readonly SyncChange[]>;
}
