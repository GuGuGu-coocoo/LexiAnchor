import type { DatabaseRequest, DatabaseResponse } from './protocol';
import type {
  BookRecord,
  BookRepository,
  ReadingProgressRecord,
  StorageStatus,
  WordCardRecord,
  WordCardRepository,
} from './types';

type RequestInput =
  | Omit<Extract<DatabaseRequest, { type: 'initialize' }>, 'id'>
  | Omit<Extract<DatabaseRequest, { type: 'list-books' }>, 'id'>
  | Omit<Extract<DatabaseRequest, { type: 'save-book' }>, 'id'>
  | Omit<Extract<DatabaseRequest, { type: 'get-progress' }>, 'id'>
  | Omit<Extract<DatabaseRequest, { type: 'save-progress' }>, 'id'>
  | Omit<Extract<DatabaseRequest, { type: 'list-word-cards' }>, 'id'>
  | Omit<Extract<DatabaseRequest, { type: 'save-word-card' }>, 'id'>
  | Omit<Extract<DatabaseRequest, { type: 'import-word-cards' }>, 'id'>
  | Omit<Extract<DatabaseRequest, { type: 'update-word-card' }>, 'id'>
  | Omit<Extract<DatabaseRequest, { type: 'delete-word-card' }>, 'id'>
  | Omit<Extract<DatabaseRequest, { type: 'close' }>, 'id'>;

export class SqliteBookRepository implements BookRepository, WordCardRepository {
  private readonly worker = new Worker(new URL('./database.worker.ts', import.meta.url), {
    type: 'module',
    name: 'lexianchor-sqlite',
  });
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  private nextRequestId = 1;

  constructor() {
    this.worker.addEventListener('message', (event: MessageEvent<DatabaseResponse>) => {
      const response = event.data;
      const request = this.pending.get(response.id);

      if (!request) {
        return;
      }

      this.pending.delete(response.id);

      if (response.ok) {
        request.resolve(response.result);
      } else {
        request.reject(new Error(response.error));
      }
    });

    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'The storage worker stopped unexpectedly.');

      for (const request of this.pending.values()) {
        request.reject(error);
      }

      this.pending.clear();
    });
  }

  initialize(): Promise<StorageStatus> {
    return this.request({ type: 'initialize' });
  }

  listBooks(): Promise<BookRecord[]> {
    return this.request({ type: 'list-books' });
  }

  saveBook(book: BookRecord): Promise<void> {
    return this.request({ type: 'save-book', book });
  }

  getProgress(bookId: string): Promise<ReadingProgressRecord | null> {
    return this.request({ type: 'get-progress', bookId });
  }

  saveProgress(progress: ReadingProgressRecord): Promise<void> {
    return this.request({ type: 'save-progress', progress });
  }

  listWordCards(query = ''): Promise<WordCardRecord[]> {
    return this.request({ type: 'list-word-cards', query });
  }

  saveWordCard(card: WordCardRecord): Promise<void> {
    return this.request({ type: 'save-word-card', card });
  }

  importWordCards(cards: readonly WordCardRecord[]): Promise<void> {
    return this.request({ type: 'import-word-cards', cards });
  }

  updateWordCard(card: WordCardRecord): Promise<void> {
    return this.request({ type: 'update-word-card', card });
  }

  deleteWordCard(cardId: string, deletedAt: string): Promise<void> {
    return this.request({ type: 'delete-word-card', cardId, deletedAt });
  }

  async close(): Promise<void> {
    await this.request({ type: 'close' });
    this.worker.terminate();
  }

  private request<Result>(input: RequestInput): Promise<Result> {
    const id = this.nextRequestId++;
    const request = { ...input, id } as DatabaseRequest;

    return new Promise<Result>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (result) => resolve(result as Result),
        reject,
      });
      this.worker.postMessage(request);
    });
  }
}
