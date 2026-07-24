import type { BookRecord, ReadingProgressRecord, StorageStatus } from './types';

export type DatabaseRequest =
  | { readonly id: number; readonly type: 'initialize' }
  | { readonly id: number; readonly type: 'list-books' }
  | { readonly id: number; readonly type: 'save-book'; readonly book: BookRecord }
  | { readonly id: number; readonly type: 'get-progress'; readonly bookId: string }
  | {
      readonly id: number;
      readonly type: 'save-progress';
      readonly progress: ReadingProgressRecord;
    }
  | { readonly id: number; readonly type: 'close' };

export type DatabaseResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result: StorageStatus | BookRecord[] | ReadingProgressRecord | null | undefined;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: string;
    };
