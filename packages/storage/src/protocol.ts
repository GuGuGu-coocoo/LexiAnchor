import type {
  BookRecord,
  DeleteBookOptions,
  ReadingProgressRecord,
  StorageStatus,
  WordCardRecord,
} from './types';

export type DatabaseRequest =
  | { readonly id: number; readonly type: 'initialize' }
  | { readonly id: number; readonly type: 'list-books' }
  | { readonly id: number; readonly type: 'save-book'; readonly book: BookRecord }
  | {
      readonly id: number;
      readonly type: 'delete-book';
      readonly bookId: string;
      readonly deletedAt: string;
      readonly options: DeleteBookOptions;
    }
  | { readonly id: number; readonly type: 'get-progress'; readonly bookId: string }
  | {
      readonly id: number;
      readonly type: 'save-progress';
      readonly progress: ReadingProgressRecord;
    }
  | { readonly id: number; readonly type: 'list-word-cards'; readonly query: string }
  | { readonly id: number; readonly type: 'save-word-card'; readonly card: WordCardRecord }
  | {
      readonly id: number;
      readonly type: 'import-word-cards';
      readonly cards: readonly WordCardRecord[];
    }
  | { readonly id: number; readonly type: 'update-word-card'; readonly card: WordCardRecord }
  | {
      readonly id: number;
      readonly type: 'delete-word-card';
      readonly cardId: string;
      readonly deletedAt: string;
    }
  | { readonly id: number; readonly type: 'close' };

export type DatabaseResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result:
        StorageStatus | BookRecord[] | ReadingProgressRecord | WordCardRecord[] | null | undefined;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: string;
    };
