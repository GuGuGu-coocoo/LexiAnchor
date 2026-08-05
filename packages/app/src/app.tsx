import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ExpandedEnglishDictionaryProvider,
  FreeDictEnglishChineseProvider,
  FreeDictEnglishFrenchProvider,
  StarDictProvider,
  type FreeDictTeiProvider,
  type DictionaryProvider,
  type StarDictInstallStatus,
} from '@lexianchor/dictionary';
import { normalizeProgress } from '@lexianchor/domain';
import type { RecentBook } from '@lexianchor/domain';
import {
  detectSystemLocale,
  supportedLocales,
  translate,
  type Locale,
  type MessageKey,
} from '@lexianchor/i18n';
import type { PlatformBridge, UpdateCheckResult } from '@lexianchor/platform';
import type { ReaderLocator, ReaderSource } from '@lexianchor/reader-core';
import {
  createApplicationBackup,
  OpfsContentStore,
  parseWordCardExport,
  restoreApplicationBackup,
  serializeWordCards,
  sha256,
  SqliteBookRepository,
  type BookRecord,
  type DeleteBookOptions,
  type ReadingProgressRecord,
  type StorageStatus,
  type WordCardRecord,
} from '@lexianchor/storage';
import { epubSpikeUrl, pdfScanUrl, pdfTextUrl } from '@lexianchor/test-fixtures';
import {
  BergamotTranslationProvider,
  translationModelResources,
  type TranslationModelInstallStatus,
  type TranslationModelProgress,
  type TranslationTargetLanguage,
} from '@lexianchor/translation';
import '@lexianchor/ui/styles.css';

import type { OnlineTranslationProvider, WordCardDraft } from './selection-tools';
import {
  formatStorageBytes,
  readStorageHealth,
  requestPersistentStorage,
  type StorageHealth,
} from './storage-health';
import type { Theme } from './theme';
import { WordCardDetailDialog } from './word-card-detail-dialog';

type Section = 'home' | 'library' | 'cards' | 'settings';
type IconName = Section | 'expand' | 'lock' | 'book-open';
type DictionaryId =
  'english-wiktionary' | 'freedict-eng-fra-0.1.6' | 'freedict-eng-zho-2025.11.23' | 'user-stardict';
type DownloadableDictionaryId = 'freedict-eng-fra-0.1.6' | 'freedict-eng-zho-2025.11.23';
type DictionaryInstallState = Readonly<Record<DownloadableDictionaryId, boolean>>;
type TranslationInstallState = Readonly<
  Record<TranslationTargetLanguage, TranslationModelInstallStatus>
>;
type LibrarySort = 'recent' | 'imported' | 'title' | 'progress';

interface DictionaryPreferences {
  readonly order: readonly DictionaryId[];
  readonly enabled: Readonly<Record<DictionaryId, boolean>>;
}

export interface AppProps {
  readonly platform: PlatformBridge;
}

interface LibraryEntry {
  readonly book: BookRecord;
  readonly progress: ReadingProgressRecord | null;
}

interface OpenBookSession {
  readonly source: ReaderSource;
  readonly bookId?: string;
  readonly initialLocator?: ReaderLocator;
}

interface WordCardEditDraft {
  readonly term: string;
  readonly partOfSpeech: string;
  readonly definitions: readonly string[];
  readonly rootOrEtymology: string;
  readonly sourceBookTitle: string;
  readonly sourceSentence: string;
}

interface BookMetadataDraft {
  readonly title: string;
  readonly author: string;
  readonly language: string;
}

type StarDictImportResponse =
  | { readonly ok: true; readonly status: StarDictInstallStatus }
  | { readonly ok: false; readonly error: string };

const demoRecentBook: RecentBook = {
  id: 'phase-zero-demo',
  title: 'English Learning Notes',
  author: 'LexiAnchor',
  format: 'EPUB',
  progressPercent: 38,
  updatedAt: '2026-07-24T00:00:00.000Z',
};

const sampleEpub: ReaderSource = {
  data: epubSpikeUrl,
  name: 'Anchored Reading.epub',
  format: 'epub',
};

const sampleTextPdf: ReaderSource = {
  data: pdfTextUrl,
  name: 'Anchored Pages.pdf',
  format: 'pdf',
};

const sampleScanPdf: ReaderSource = {
  data: pdfScanUrl,
  name: 'Image-only Sample.pdf',
  format: 'pdf',
};

const localeLabels: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  fr: 'Français',
};

const ReaderPage = lazy(() =>
  import('./reader-page').then((module) => ({ default: module.ReaderPage })),
);

const englishDictionaryProvider = new ExpandedEnglishDictionaryProvider();
const freeDictFrenchProvider = new FreeDictEnglishFrenchProvider();
const freeDictChineseProvider = new FreeDictEnglishChineseProvider();
const userStarDictProvider = new StarDictProvider();
const localTranslationProvider = new BergamotTranslationProvider();
const downloadableDictionaryIds: readonly DownloadableDictionaryId[] = [
  'freedict-eng-fra-0.1.6',
  'freedict-eng-zho-2025.11.23',
];
const freeDictProviders: Readonly<Record<DownloadableDictionaryId, FreeDictTeiProvider>> = {
  'freedict-eng-fra-0.1.6': freeDictFrenchProvider,
  'freedict-eng-zho-2025.11.23': freeDictChineseProvider,
};
const dictionaryProvidersById: Readonly<Record<DictionaryId, DictionaryProvider>> = {
  'english-wiktionary': englishDictionaryProvider,
  ...freeDictProviders,
  'user-stardict': userStarDictProvider,
};
const dictionaryIds: readonly DictionaryId[] = [
  'english-wiktionary',
  ...downloadableDictionaryIds,
  'user-stardict',
];
const emptyTranslationStatus: TranslationModelInstallStatus = {
  installed: false,
  partial: false,
  installedParts: 0,
  totalParts: 0,
  storedBytes: 0,
};

let bookRepository: SqliteBookRepository | undefined;
const contentStore = new OpfsContentStore();
const openBookContentCache = new Map<string, ArrayBuffer>();

function repository(): SqliteBookRepository {
  bookRepository ??= new SqliteBookRepository();
  return bookRepository;
}

async function loadLibrary(): Promise<LibraryEntry[]> {
  const books = await repository().listBooks();
  return Promise.all(
    books.map(async (book) => ({
      book,
      progress: await repository().getProgress(book.id),
    })),
  );
}

function deviceId(): string {
  const key = 'lexianchor:device-id';
  const stored = globalThis.localStorage?.getItem(key);

  if (stored) {
    return stored;
  }

  const id = crypto.randomUUID();
  globalThis.localStorage?.setItem(key, id);
  return id;
}

function originalFileName(book: BookRecord): string {
  const storedName = book.metadata.originalFileName;
  return typeof storedName === 'string'
    ? storedName
    : `${book.title}.${book.format === 'pdf' ? 'pdf' : 'epub'}`;
}

function readStoredLocale(): Locale {
  const stored = globalThis.localStorage?.getItem('lexianchor:locale');
  return supportedLocales.find((locale) => locale === stored) ?? detectSystemLocale();
}

function readStoredTheme(): Theme {
  const stored = globalThis.localStorage?.getItem('lexianchor:theme');
  const themes: readonly Theme[] = ['system', 'light', 'dark', 'eye-care'];
  return themes.find((theme) => theme === stored) ?? 'system';
}

function readOnlineTranslationProvider(): OnlineTranslationProvider {
  const stored = globalThis.localStorage?.getItem('lexianchor:online-translation-provider');
  return stored === 'bing' || stored === 'baidu' ? stored : 'google';
}

function exportableSettings(): Readonly<Record<string, string>> {
  const settings: Record<string, string> = {};
  const storage = globalThis.localStorage;
  const allowed = new Set([
    'lexianchor:theme',
    'lexianchor:locale',
    'lexianchor:dictionary-preferences',
    'lexianchor:library-sort',
    'lexianchor:translation-target',
    'lexianchor:online-translation-provider',
    'lexianchor:reader-preferences',
    'lexianchor:reader-presets',
  ]);

  if (!storage) {
    return settings;
  }

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);

    if (!key || (!allowed.has(key) && !key.startsWith('lexianchor:reader-preferences:'))) {
      continue;
    }

    const value = storage.getItem(key);
    if (value !== null) {
      settings[key] = value;
    }
  }

  return settings;
}

function readDictionaryPreferences(): DictionaryPreferences {
  const fallback: DictionaryPreferences = {
    order: dictionaryIds,
    enabled: {
      'english-wiktionary': true,
      'freedict-eng-fra-0.1.6': true,
      'freedict-eng-zho-2025.11.23': true,
      'user-stardict': true,
    },
  };
  const stored = globalThis.localStorage?.getItem('lexianchor:dictionary-preferences');

  if (!stored) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(stored) as Partial<DictionaryPreferences>;
    const order = [
      ...(parsed.order ?? []).filter((id): id is DictionaryId => dictionaryIds.includes(id)),
      ...dictionaryIds.filter((id) => !parsed.order?.includes(id)),
    ];
    return {
      order,
      enabled: {
        'english-wiktionary':
          parsed.enabled?.['english-wiktionary'] ?? fallback.enabled['english-wiktionary'],
        'freedict-eng-fra-0.1.6':
          parsed.enabled?.['freedict-eng-fra-0.1.6'] ?? fallback.enabled['freedict-eng-fra-0.1.6'],
        'freedict-eng-zho-2025.11.23':
          parsed.enabled?.['freedict-eng-zho-2025.11.23'] ??
          fallback.enabled['freedict-eng-zho-2025.11.23'],
        'user-stardict': parsed.enabled?.['user-stardict'] ?? fallback.enabled['user-stardict'],
      },
    };
  } catch {
    return fallback;
  }
}

function isDownloadableDictionary(id: DictionaryId): id is DownloadableDictionaryId {
  return downloadableDictionaryIds.some((candidate) => candidate === id);
}

function installStarDictInWorker(
  ifo: string,
  idx: ArrayBuffer,
  dict: ArrayBuffer,
): Promise<StarDictInstallStatus> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./stardict-import.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<StarDictImportResponse>) => {
      worker.terminate();
      if (event.data.ok) {
        resolve(event.data.status);
      } else {
        reject(new Error(event.data.error));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'The StarDict import worker failed.'));
    };
    worker.postMessage({ ifo, idx, dict }, [idx, dict]);
  });
}

export function App({ platform }: AppProps) {
  const [activeSection, setActiveSection] = useState<Section>('home');
  const [locale, setLocale] = useState<Locale>(readStoredLocale);
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [appVersion, setAppVersion] = useState('0.1.0');
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResult | null>(null);
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [storageStatus, setStorageStatus] = useState<StorageStatus>();
  const [storageHealth, setStorageHealth] = useState<StorageHealth>();
  const [isRequestingPersistentStorage, setIsRequestingPersistentStorage] = useState(false);
  const [applicationBackupMessage, setApplicationBackupMessage] = useState('');
  const [isApplicationBackupBusy, setIsApplicationBackupBusy] = useState(false);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [wordCards, setWordCards] = useState<WordCardRecord[]>([]);
  const [cardSearch, setCardSearch] = useState('');
  const [lastDeletedCard, setLastDeletedCard] = useState<WordCardRecord | null>(null);
  const [cardTransferMessage, setCardTransferMessage] = useState('');
  const [dictionaryPreferences, setDictionaryPreferences] = useState(readDictionaryPreferences);
  const [onlineTranslationProvider, setOnlineTranslationProvider] = useState(
    readOnlineTranslationProvider,
  );
  const [installedDictionaries, setInstalledDictionaries] = useState<DictionaryInstallState>({
    'freedict-eng-fra-0.1.6': false,
    'freedict-eng-zho-2025.11.23': false,
  });
  const [installingDictionary, setInstallingDictionary] = useState<DownloadableDictionaryId | null>(
    null,
  );
  const [userStarDict, setUserStarDict] = useState<StarDictInstallStatus | null>(null);
  const [translationModels, setTranslationModels] = useState<TranslationInstallState>({
    fr: emptyTranslationStatus,
    zh: emptyTranslationStatus,
  });
  const [installingTranslationModel, setInstallingTranslationModel] =
    useState<TranslationTargetLanguage | null>(null);
  const [translationModelProgress, setTranslationModelProgress] =
    useState<TranslationModelProgress | null>(null);
  const translationInstallAbort = useRef<AbortController | null>(null);
  const latestReadingProgress = useRef<ReadingProgressRecord | null>(null);
  const readingProgressWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const isClosingReader = useRef(false);
  const [openBook, setOpenBook] = useState<OpenBookSession | null>(null);
  const [isReaderSettingsOpen, setIsReaderSettingsOpen] = useState(false);
  const [isReaderCardsOpen, setIsReaderCardsOpen] = useState(false);
  const t = useCallback((key: MessageKey) => translate(locale, key), [locale]);
  const dictionaryProviders = useMemo<readonly DictionaryProvider[]>(() => {
    return dictionaryPreferences.order.flatMap((id) =>
      dictionaryPreferences.enabled[id] &&
      (!isDownloadableDictionary(id) || installedDictionaries[id]) &&
      (id !== 'user-stardict' || userStarDict?.installed)
        ? [dictionaryProvidersById[id]]
        : [],
    );
  }, [dictionaryPreferences, installedDictionaries, userStarDict]);

  useEffect(() => {
    document.documentElement.lang = locale;
    globalThis.localStorage?.setItem('lexianchor:locale', locale);
  }, [locale]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    globalThis.localStorage?.setItem('lexianchor:theme', theme);
  }, [theme]);

  useEffect(() => {
    globalThis.localStorage?.setItem(
      'lexianchor:dictionary-preferences',
      JSON.stringify(dictionaryPreferences),
    );
  }, [dictionaryPreferences]);

  useEffect(() => {
    globalThis.localStorage?.setItem(
      'lexianchor:online-translation-provider',
      onlineTranslationProvider,
    );
  }, [onlineTranslationProvider]);

  useEffect(() => {
    void platform.getAppVersion().then(setAppVersion);
    void platform.isFullscreen().then(setIsFullscreen);

    if (platform.target === 'desktop') {
      void platform.checkForUpdates().then(setUpdateCheckResult);
    }

    const syncFullscreenState = () => {
      void platform.isFullscreen().then(setIsFullscreen);
    };
    const exitFullscreenWithEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      void platform.isFullscreen().then((fullscreen) => {
        if (fullscreen || document.documentElement.dataset.immersive === 'on') {
          void platform.setFullscreen(false).then(setIsFullscreen);
        }
      });
    };

    document.addEventListener('fullscreenchange', syncFullscreenState);
    document.addEventListener('keydown', exitFullscreenWithEscape);
    window.addEventListener('resize', syncFullscreenState);

    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState);
      document.removeEventListener('keydown', exitFullscreenWithEscape);
      window.removeEventListener('resize', syncFullscreenState);
    };
  }, [platform]);

  useEffect(() => {
    let isActive = true;

    void readStorageHealth().then((health) => {
      if (isActive) {
        setStorageHealth(health);
      }
    });

    void repository()
      .initialize()
      .then(async (nextStatus) => {
        document.documentElement.dataset.storage = nextStatus.persistence;
        const [entries, cards] = await Promise.all([loadLibrary(), repository().listWordCards()]);

        if (isActive) {
          setStorageStatus(nextStatus);
          setLibrary(entries);
          setWordCards(cards);
        }
      })
      .catch((error: unknown) => {
        if (isActive) {
          setStatusMessage(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    let isActive = true;

    void Promise.all(
      (['fr', 'zh'] as const).map(async (target) => [
        target,
        await localTranslationProvider.manager.status(target),
      ]),
    )
      .then((entries) => {
        if (isActive) {
          setTranslationModels(
            Object.fromEntries(entries) as Record<
              TranslationTargetLanguage,
              TranslationModelInstallStatus
            >,
          );
        }
      })
      .catch((error: unknown) => {
        if (isActive) {
          setStatusMessage(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    let isActive = true;

    void userStarDictProvider
      .status()
      .then((status) => {
        if (isActive) {
          setUserStarDict(status.installed ? status : null);
        }
      })
      .catch((error: unknown) => {
        if (isActive) {
          setStatusMessage(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    let isActive = true;

    void Promise.all(
      downloadableDictionaryIds.map(async (id) => {
        const status = await freeDictProviders[id].status();
        return [id, status.installed] as const;
      }),
    )
      .then((entries) => {
        if (isActive) {
          setInstalledDictionaries(
            Object.fromEntries(entries) as Record<DownloadableDictionaryId, boolean>,
          );
        }
      })
      .catch((error: unknown) => {
        if (isActive) {
          setStatusMessage(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (activeSection !== 'cards' && !isReaderCardsOpen) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void repository()
        .listWordCards(cardSearch)
        .then(setWordCards)
        .catch((error: unknown) =>
          setStatusMessage(error instanceof Error ? error.message : String(error)),
        );
    }, 120);

    return () => window.clearTimeout(timeout);
  }, [activeSection, cardSearch, isReaderCardsOpen]);

  const refreshLibrary = useCallback(async () => {
    setLibrary(await loadLibrary());
  }, []);

  const openStoredBook = useCallback(async (entry: LibraryEntry) => {
    try {
      const cached = openBookContentCache.get(entry.book.contentRef);
      const data = cached ?? (await contentStore.get(entry.book.contentRef));

      if (!data) {
        throw new Error('The local book file is missing.');
      }

      openBookContentCache.set(entry.book.contentRef, data);
      setOpenBook({
        source: {
          data,
          name: originalFileName(entry.book),
          format: entry.book.format,
        },
        bookId: entry.book.id,
        initialLocator: entry.progress?.locator,
      });
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const importBooks = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) {
        return;
      }

      setStatusMessage(t('importingBooks'));
      const importedSessions: OpenBookSession[] = [];
      const failures: string[] = [];
      let existingBooks: Map<string, BookRecord>;

      try {
        existingBooks = new Map(
          (await repository().listBooks()).map((book) => [book.id, book] as const),
        );
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
        return;
      }

      for (const file of files) {
        try {
          const normalizedName = file.name.toLocaleLowerCase('en-US');
          const format = normalizedName.endsWith('.pdf')
            ? 'pdf'
            : normalizedName.endsWith('.epub')
              ? 'epub'
              : null;

          if (!format) {
            throw new Error(t('unsupportedBookFormat'));
          }

          const data = await file.arrayBuffer();
          const hash = await sha256(data);
          const now = new Date().toISOString();
          const id = `book-${hash}`;
          const existing = existingBooks.get(id);
          const title = file.name.replace(/\.(epub|pdf)$/i, '') || file.name;
          const book: BookRecord = existing
            ? {
                ...existing,
                lastOpenedAt: now,
                updatedAt: now,
                deletedAt: null,
                version: existing.version + 1,
              }
            : {
                id,
                title,
                author: '',
                format,
                language: null,
                coverRef: null,
                contentRef: hash,
                contentHash: hash,
                fileSize: data.byteLength,
                importedAt: now,
                lastOpenedAt: now,
                metadata: {
                  originalFileName: file.name,
                  mimeType: file.type,
                },
                createdAt: now,
                updatedAt: now,
                deletedAt: null,
                version: 1,
              };

          await contentStore.put(hash, data);
          openBookContentCache.set(hash, data);
          await repository().saveBook(book);
          existingBooks.set(book.id, book);
          importedSessions.push({
            source: { data, name: file.name, format },
            bookId: book.id,
          });
        } catch (error) {
          failures.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      await refreshLibrary();

      if (files.length === 1 && importedSessions.length === 1) {
        setOpenBook(importedSessions[0] ?? null);
      }

      const summary = `${t('booksImported')} ${importedSessions.length}`;
      setStatusMessage(
        failures.length > 0
          ? `${summary}. ${t('booksImportFailed')} ${failures.length}: ${failures.join('; ')}`
          : summary,
      );
    },
    [refreshLibrary, t],
  );

  const updateBookMetadata = useCallback(
    async (entry: LibraryEntry, draft: BookMetadataDraft) => {
      const title = draft.title.trim();

      if (!title) {
        throw new Error(t('bookTitleRequired'));
      }

      await repository().saveBook({
        ...entry.book,
        title,
        author: draft.author.trim(),
        language: draft.language.trim() || null,
        updatedAt: new Date().toISOString(),
        version: entry.book.version + 1,
      });
      await refreshLibrary();
      setStatusMessage(t('bookMetadataSaved'));
    },
    [refreshLibrary, t],
  );

  const deleteStoredBook = useCallback(
    async (entry: LibraryEntry, options: DeleteBookOptions) => {
      const deletedAt = new Date().toISOString();

      try {
        await repository().deleteBook(entry.book.id, deletedAt, options);
        await refreshLibrary();

        try {
          await contentStore.delete(entry.book.contentRef);
          openBookContentCache.delete(entry.book.contentRef);
          setStatusMessage(t('bookDeleted'));
        } catch (error) {
          setStatusMessage(
            `${t('bookDeleted')} ${t('bookFileCleanupFailed')} ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    [refreshLibrary, t],
  );

  const persistLocation = useCallback(
    (locator: ReaderLocator, percentage: number) => {
      const bookId = openBook?.bookId;

      if (!bookId) {
        return;
      }

      const updatedAt = new Date().toISOString();
      const progress = {
        id: `progress-${bookId}`,
        bookId,
        locator,
        percentage: normalizeProgress(percentage),
        updatedAt,
        deviceId: deviceId(),
        version: 1,
      } satisfies ReadingProgressRecord;
      latestReadingProgress.current = progress;

      if (isClosingReader.current) {
        return;
      }

      const write = readingProgressWriteQueue.current
        .catch(() => undefined)
        .then(() => repository().saveProgress(progress));
      readingProgressWriteQueue.current = write;
      void write.catch((error: unknown) =>
        setStatusMessage(error instanceof Error ? error.message : String(error)),
      );
    },
    [openBook?.bookId],
  );

  const closeReader = useCallback(() => {
    if (isClosingReader.current) {
      return;
    }

    isClosingReader.current = true;
    if (isFullscreen) {
      void platform.setFullscreen(false).then(setIsFullscreen);
    }
    const finalProgress = latestReadingProgress.current;
    const flush = readingProgressWriteQueue.current
      .catch(() => undefined)
      .then(() => (finalProgress ? repository().saveProgress(finalProgress) : undefined));

    void flush
      .catch((error: unknown) =>
        setStatusMessage(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        readingProgressWriteQueue.current = Promise.resolve();
        latestReadingProgress.current = null;
        setIsReaderSettingsOpen(false);
        setIsReaderCardsOpen(false);
        setOpenBook(null);
        isClosingReader.current = false;
        void refreshLibrary();
      });
  }, [isFullscreen, platform, refreshLibrary]);

  const addWordCard = useCallback(
    async (draft: WordCardDraft) => {
      if (!openBook) {
        throw new Error('A book must be open before saving a word card.');
      }

      const now = new Date().toISOString();
      const existingCard = (await repository().listWordCards(draft.normalizedTerm)).find(
        (card) => card.normalizedTerm === draft.normalizedTerm,
      );

      if (existingCard) {
        await repository().saveWordCard({
          ...existingCard,
          definitions: [...new Set([...existingCard.definitions, ...draft.definitions])],
          occurrenceCount: existingCard.occurrenceCount + 1,
          updatedAt: now,
          deletedAt: null,
          version: existingCard.version + 1,
        });
      } else {
        await repository().saveWordCard({
          id: `card-${crypto.randomUUID()}`,
          ...draft,
          sourceBookId: openBook.bookId ?? null,
          sourceBookTitle: openBook.source.name.replace(/\.(epub|pdf)$/i, ''),
          occurrenceCount: 1,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          version: 1,
        });
      }
      setWordCards(await repository().listWordCards(cardSearch));
    },
    [cardSearch, openBook],
  );

  const deleteWordCard = useCallback(
    async (cardId: string) => {
      try {
        const card = wordCards.find((candidate) => candidate.id === cardId);
        await repository().deleteWordCard(cardId, new Date().toISOString());
        setLastDeletedCard(card ?? null);
        setWordCards(await repository().listWordCards(cardSearch));
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [cardSearch, wordCards],
  );

  const undoDeleteWordCard = useCallback(async () => {
    if (!lastDeletedCard) {
      return;
    }

    try {
      await repository().saveWordCard({
        ...lastDeletedCard,
        updatedAt: new Date().toISOString(),
        deletedAt: null,
        version: lastDeletedCard.version + 1,
      });
      setLastDeletedCard(null);
      setWordCards(await repository().listWordCards(cardSearch));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }, [cardSearch, lastDeletedCard]);

  const updateWordCard = useCallback(
    async (cardId: string, draft: WordCardEditDraft) => {
      const card = wordCards.find((candidate) => candidate.id === cardId);

      if (!card) {
        throw new Error(t('cardUpdateFailed'));
      }

      const term = draft.term.trim();
      const definitions = [
        ...new Set(draft.definitions.map((definition) => definition.trim()).filter(Boolean)),
      ].slice(0, 12);
      const sourceBookTitle = draft.sourceBookTitle.trim();
      const sourceSentence = draft.sourceSentence.trim();

      if (!term || definitions.length === 0 || !sourceBookTitle || !sourceSentence) {
        throw new Error(t('cardRequiredFields'));
      }

      try {
        await repository().updateWordCard({
          ...card,
          term,
          normalizedTerm: term.toLocaleLowerCase('en-US'),
          partOfSpeech: draft.partOfSpeech.trim() || 'unknown',
          definition: definitions[0] ?? '',
          definitions,
          rootOrEtymology: draft.rootOrEtymology.trim() || null,
          sourceBookTitle,
          sourceSentence,
          updatedAt: new Date().toISOString(),
          version: card.version + 1,
        });
        setWordCards(await repository().listWordCards(cardSearch));
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
        throw new Error(t('cardUpdateFailed'), { cause: error });
      }
    },
    [cardSearch, t, wordCards],
  );

  const exportWordCards = useCallback(async () => {
    try {
      const cards = (await repository().exportDataSnapshot()).wordCards;
      const blob = new Blob([serializeWordCards(cards)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `lexianchor-word-cards-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
      setCardTransferMessage(t('cardsExported'));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
      setCardTransferMessage(t('cardsExportFailed'));
    }
  }, [t]);

  const importWordCards = useCallback(
    async (file: File) => {
      try {
        const backup = parseWordCardExport(await file.text());
        const importedAt = new Date().toISOString();
        await repository().importWordCards(
          backup.cards.map((card) => ({
            ...card,
            updatedAt: importedAt,
            version: card.version + 1,
          })),
        );
        setLastDeletedCard(null);
        setWordCards(await repository().listWordCards(cardSearch));
        setCardTransferMessage(`${t('cardsImported')} ${backup.cards.length}`);
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
        setCardTransferMessage(t('cardsImportFailed'));
      }
    },
    [cardSearch, t],
  );

  async function installFreeDict(id: DownloadableDictionaryId) {
    setInstallingDictionary(id);
    setStatusMessage(t('downloadingDictionary'));

    try {
      await freeDictProviders[id].install();
      setInstalledDictionaries((current) => ({ ...current, [id]: true }));
      setDictionaryPreferences((current) => ({
        ...current,
        enabled: { ...current.enabled, [id]: true },
      }));
      setStatusMessage(t('dictionaryInstalled'));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingDictionary(null);
    }
  }

  async function removeFreeDict(id: DownloadableDictionaryId) {
    if (!globalThis.confirm(t('removeDictionaryConfirm'))) {
      return;
    }

    try {
      await freeDictProviders[id].remove();
      setInstalledDictionaries((current) => ({ ...current, [id]: false }));
      setStatusMessage(t('dictionaryRemoved'));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function importStarDict(files: readonly File[]) {
    try {
      setStatusMessage(t('importingDictionary'));
      const ifoFile = files.find((file) => file.name.toLowerCase().endsWith('.ifo'));
      const idxFile = files.find((file) => file.name.toLowerCase().endsWith('.idx'));
      const dictFile = files.find((file) => file.name.toLowerCase().endsWith('.dict'));

      if (files.length !== 3 || !ifoFile || !idxFile || !dictFile) {
        throw new Error(t('starDictFilesRequired'));
      }

      const baseNames = [
        ifoFile.name.replace(/\.ifo$/i, ''),
        idxFile.name.replace(/\.idx$/i, ''),
        dictFile.name.replace(/\.dict$/i, ''),
      ];

      if (!baseNames.every((name) => name === baseNames[0])) {
        throw new Error(t('starDictNamesMustMatch'));
      }

      const [ifo, idx, dict] = await Promise.all([
        ifoFile.text(),
        idxFile.arrayBuffer(),
        dictFile.arrayBuffer(),
      ]);
      const status = await installStarDictInWorker(ifo, idx, dict);
      setUserStarDict(status);
      setDictionaryPreferences((current) => ({
        ...current,
        enabled: { ...current.enabled, 'user-stardict': true },
      }));
      setStatusMessage(t('dictionaryInstalled'));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function removeStarDict() {
    if (!globalThis.confirm(t('removeUserDictionaryConfirm'))) {
      return;
    }

    try {
      await userStarDictProvider.remove();
      setUserStarDict(null);
      setStatusMessage(t('dictionaryRemoved'));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function installTranslationModel(targetLanguage: TranslationTargetLanguage) {
    const controller = new AbortController();
    translationInstallAbort.current = controller;
    setInstallingTranslationModel(targetLanguage);
    setTranslationModelProgress(null);
    setStatusMessage(t('downloadingTranslationModel'));

    try {
      const status = await localTranslationProvider.manager.install(targetLanguage, {
        signal: controller.signal,
        onProgress: setTranslationModelProgress,
      });
      setTranslationModels((current) => ({ ...current, [targetLanguage]: status }));
      setStatusMessage(t('translationModelInstalled'));
    } catch (error) {
      const status = await localTranslationProvider.manager.status(targetLanguage);
      setTranslationModels((current) => ({ ...current, [targetLanguage]: status }));
      setStatusMessage(
        error instanceof DOMException && error.name === 'AbortError'
          ? t('translationDownloadPaused')
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      translationInstallAbort.current = null;
      setInstallingTranslationModel(null);
      setTranslationModelProgress(null);
    }
  }

  function cancelTranslationInstall() {
    translationInstallAbort.current?.abort();
  }

  async function removeTranslationModel(targetLanguage: TranslationTargetLanguage) {
    if (!globalThis.confirm(t('removeTranslationModelConfirm'))) {
      return;
    }

    try {
      await localTranslationProvider.dispose();
      await localTranslationProvider.manager.remove(targetLanguage);
      setTranslationModels((current) => ({
        ...current,
        [targetLanguage]: emptyTranslationStatus,
      }));
      setStatusMessage(t('translationModelRemoved'));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function toggleDictionary(id: DictionaryId, enabled: boolean) {
    setDictionaryPreferences((current) => ({
      ...current,
      enabled: { ...current.enabled, [id]: enabled },
    }));
  }

  function moveDictionary(id: DictionaryId, direction: -1 | 1) {
    setDictionaryPreferences((current) => {
      const order = [...current.order];
      const currentIndex = order.indexOf(id);
      const nextIndex = currentIndex + direction;

      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= order.length) {
        return current;
      }

      const currentId = order[currentIndex];
      const nextId = order[nextIndex];

      if (!currentId || !nextId) {
        return current;
      }

      order[currentIndex] = nextId;
      order[nextIndex] = currentId;
      return { ...current, order };
    });
  }

  async function toggleFullscreen() {
    setStatusMessage('');

    try {
      const nextState = await platform.setFullscreen(!isFullscreen);
      setIsFullscreen(nextState);
    } catch {
      setStatusMessage(t('actionFailed'));
    }
  }

  async function protectLocalStorage() {
    setIsRequestingPersistentStorage(true);
    const health = await requestPersistentStorage();
    setStorageHealth(health);
    setIsRequestingPersistentStorage(false);
  }

  async function checkForAppUpdate() {
    setIsCheckingForUpdates(true);
    try {
      const result = await platform.checkForUpdates();
      setUpdateCheckResult(result);
    } finally {
      setIsCheckingForUpdates(false);
    }
  }

  async function exportApplicationData(includeBookFiles: boolean) {
    setIsApplicationBackupBusy(true);
    setApplicationBackupMessage('');

    try {
      const backup = await createApplicationBackup(repository(), contentStore, {
        includeBookFiles,
        settings: exportableSettings(),
      });
      const url = URL.createObjectURL(
        new Blob([backup.slice().buffer], { type: 'application/zip' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `lexianchor-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      URL.revokeObjectURL(url);
      setApplicationBackupMessage(t('applicationBackupExported'));
    } catch (error) {
      setApplicationBackupMessage(
        `${t('applicationBackupExportFailed')} ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setIsApplicationBackupBusy(false);
    }
  }

  async function importApplicationData(file: File | undefined) {
    if (!file) {
      return;
    }

    if (!globalThis.confirm(t('applicationBackupImportConfirm'))) {
      return;
    }

    setIsApplicationBackupBusy(true);
    setApplicationBackupMessage('');

    try {
      const result = await restoreApplicationBackup(
        await file.arrayBuffer(),
        repository(),
        contentStore,
      );

      for (const [key, value] of Object.entries(result.settings)) {
        globalThis.localStorage?.setItem(key, value);
      }

      setLocale(readStoredLocale());
      setTheme(readStoredTheme());
      setDictionaryPreferences(readDictionaryPreferences());
      setOnlineTranslationProvider(readOnlineTranslationProvider());
      await refreshLibrary();
      setWordCards(await repository().listWordCards());
      setApplicationBackupMessage(
        `${t('applicationBackupImported')} ${result.counts.books} ${t(
          'applicationBackupBooks',
        )}, ${result.counts.wordCards} ${t('applicationBackupCards')}.`,
      );
    } catch (error) {
      setApplicationBackupMessage(
        `${t('applicationBackupImportFailed')} ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setIsApplicationBackupBusy(false);
    }
  }

  const navigationItems: ReadonlyArray<{
    id: Section;
    label: string;
  }> = [
    { id: 'home', label: t('home') },
    { id: 'library', label: t('library') },
    { id: 'cards', label: t('cards') },
    { id: 'settings', label: t('settings') },
  ];

  const settingsPageProps: SettingsPageProps = {
    appVersion,
    updateCheckResult,
    isCheckingForUpdates,
    locale,
    storageHealth,
    isRequestingPersistentStorage,
    applicationBackupMessage,
    isApplicationBackupBusy,
    dictionaryPreferences,
    onlineTranslationProvider,
    installedDictionaries,
    installingDictionary,
    userStarDict,
    translationModels,
    installingTranslationModel,
    translationModelProgress,
    t,
    onToggleDictionary: toggleDictionary,
    onOnlineTranslationProviderChange: setOnlineTranslationProvider,
    onMoveDictionary: moveDictionary,
    onInstallFreeDict: installFreeDict,
    onRemoveFreeDict: removeFreeDict,
    onImportStarDict: importStarDict,
    onRemoveStarDict: removeStarDict,
    onInstallTranslationModel: installTranslationModel,
    onCancelTranslationInstall: cancelTranslationInstall,
    onRemoveTranslationModel: removeTranslationModel,
    onOpenExternal: (url) => platform.openExternal(url),
    onCheckForUpdates: checkForAppUpdate,
    onProtectLocalStorage: protectLocalStorage,
    onExportApplicationData: exportApplicationData,
    onImportApplicationData: importApplicationData,
  };

  if (openBook) {
    return (
      <div className="reader-session">
        <Suspense fallback={<p className="app-loading">{t('loadingBook')}</p>}>
          <ReaderPage
            key={`${openBook.bookId ?? 'sample'}:${openBook.source.format}:${openBook.source.name}`}
            source={openBook.source}
            preferenceScopeId={openBook.bookId ?? openBook.source.name}
            initialLocator={openBook.initialLocator}
            theme={theme}
            isFullscreen={isFullscreen}
            locale={locale}
            t={t}
            onClose={closeReader}
            onOpenWordCards={() => {
              setIsReaderSettingsOpen(false);
              setIsReaderCardsOpen(true);
            }}
            onOpenSettings={() => {
              setIsReaderCardsOpen(false);
              setIsReaderSettingsOpen(true);
            }}
            onThemeChange={setTheme}
            onToggleFullscreen={toggleFullscreen}
            onLocationChange={persistLocation}
            onOpenExternal={(url) => platform.openExternal(url)}
            onAddWordCard={addWordCard}
            dictionaryProviders={dictionaryProviders}
            localTranslationProvider={localTranslationProvider}
            installedTranslationTargets={(
              Object.entries(translationModels) as [
                TranslationTargetLanguage,
                TranslationModelInstallStatus,
              ][]
            ).flatMap(([target, status]) => (status.installed ? [target] : []))}
            onlineTranslationProvider={onlineTranslationProvider}
          />
        </Suspense>
        {isReaderSettingsOpen ? (
          <div className="reader-settings-overlay" role="dialog" aria-modal="true">
            <div className="reader-settings-overlay-bar">
              <strong>{t('settings')}</strong>
              <button type="button" onClick={() => setIsReaderSettingsOpen(false)}>
                {t('closeSettings')}
              </button>
            </div>
            <div className="reader-settings-overlay-content">
              <SettingsPage {...settingsPageProps} />
            </div>
          </div>
        ) : null}
        {isReaderCardsOpen ? (
          <div
            className="reader-settings-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reader-cards-overlay-title"
          >
            <div className="reader-settings-overlay-bar">
              <strong id="reader-cards-overlay-title">{t('cardsTitle')}</strong>
              <button type="button" onClick={() => setIsReaderCardsOpen(false)}>
                {t('closeWordCards')}
              </button>
            </div>
            <div className="reader-settings-overlay-content">
              <CardsPage
                cards={wordCards}
                query={cardSearch}
                locale={locale}
                t={t}
                onQueryChange={setCardSearch}
                onUpdate={updateWordCard}
                onDelete={deleteWordCard}
                deletedCard={lastDeletedCard}
                onUndoDelete={undoDeleteWordCard}
                onExport={exportWordCards}
                onImport={importWordCards}
                transferMessage={cardTransferMessage}
              />
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="LexiAnchor">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            L
          </div>
          <div className="brand-copy">
            <p className="brand-name">LexiAnchor</p>
            <p className="brand-tagline">{t('appTagline')}</p>
          </div>
        </div>

        <nav className="primary-nav" aria-label={t('appTagline')}>
          {navigationItems.map((item) => (
            <button
              key={item.id}
              className="nav-button"
              type="button"
              aria-current={activeSection === item.id ? 'page' : undefined}
              onClick={() => setActiveSection(item.id)}
            >
              <Icon name={item.id} className="nav-icon" />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-spacer" />

        <div className="sidebar-settings">
          <label className="field-label">
            {t('appearance')}
            <select
              className="field-select"
              value={theme}
              onChange={(event) => setTheme(event.target.value as Theme)}
            >
              <option value="system">{t('systemTheme')}</option>
              <option value="light">{t('lightTheme')}</option>
              <option value="dark">{t('darkTheme')}</option>
              <option value="eye-care">{t('eyeCareTheme')}</option>
            </select>
          </label>

          <label className="field-label">
            {t('language')}
            <select
              className="field-select"
              value={locale}
              onChange={(event) => setLocale(event.target.value as Locale)}
            >
              {supportedLocales.map((supportedLocale) => (
                <option key={supportedLocale} value={supportedLocale}>
                  {localeLabels[supportedLocale]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="privacy-note">
          <p className="privacy-title">
            <Icon name="lock" className="nav-icon" />
            {t('localOnly')}
          </p>
          <p className="privacy-copy">
            {storageStatus?.persistence === 'memory'
              ? t('temporaryStorage')
              : t('privateByDefault')}
          </p>
        </div>
      </aside>

      <main className="main-content">
        {updateCheckResult?.status === 'available' ? (
          <button
            className="update-available-banner"
            type="button"
            onClick={() => setActiveSection('settings')}
          >
            <strong>
              {t('updateAvailable')} v{updateCheckResult.release.version}
            </strong>
            <span>{t('reviewUpdate')}</span>
          </button>
        ) : null}
        {activeSection === 'home' ? (
          <HomePage
            appVersion={appVersion}
            isFullscreen={isFullscreen}
            platform={platform}
            t={t}
            onToggleFullscreen={toggleFullscreen}
            library={library}
            onOpenSample={(source) => setOpenBook({ source })}
            onOpenStored={openStoredBook}
          />
        ) : activeSection === 'library' ? (
          <LibraryPage
            library={library}
            t={t}
            onImportBooks={importBooks}
            onUpdateBook={updateBookMetadata}
            onDeleteBook={deleteStoredBook}
            onOpenSample={(source) => setOpenBook({ source })}
            onOpenStored={openStoredBook}
          />
        ) : activeSection === 'cards' ? (
          <CardsPage
            cards={wordCards}
            query={cardSearch}
            locale={locale}
            t={t}
            onQueryChange={setCardSearch}
            onUpdate={updateWordCard}
            onDelete={deleteWordCard}
            deletedCard={lastDeletedCard}
            onUndoDelete={undoDeleteWordCard}
            onExport={exportWordCards}
            onImport={importWordCards}
            transferMessage={cardTransferMessage}
          />
        ) : (
          <SettingsPage {...settingsPageProps} />
        )}
        <p className="sr-only" aria-live="polite">
          {statusMessage}
        </p>
      </main>
    </div>
  );
}

interface HomePageProps {
  readonly appVersion: string;
  readonly isFullscreen: boolean;
  readonly platform: PlatformBridge;
  readonly t: (key: MessageKey) => string;
  readonly onToggleFullscreen: () => Promise<void>;
  readonly library: readonly LibraryEntry[];
  readonly onOpenSample: (source: ReaderSource) => void;
  readonly onOpenStored: (entry: LibraryEntry) => Promise<void>;
}

function HomePage({
  appVersion,
  isFullscreen,
  platform,
  t,
  onToggleFullscreen,
  library,
  onOpenSample,
  onOpenStored,
}: HomePageProps) {
  const progress = normalizeProgress(demoRecentBook.progressPercent);

  return (
    <section className="page" aria-labelledby="home-title">
      <header className="page-header">
        <div>
          <p className="eyebrow">{t('welcome')}</p>
          <h1 className="page-title" id="home-title">
            {t('continueReading')}
          </h1>
          <p className="page-description">{t('recentDescription')}</p>
        </div>
        <button className="button" type="button" onClick={onToggleFullscreen}>
          <Icon name="expand" className="button-icon" />
          <span className="button-label">
            {isFullscreen ? t('exitFullscreen') : t('fullscreen')}
          </span>
        </button>
      </header>

      <div className="section-heading">
        <h2 className="section-title">{t('continueReading')}</h2>
        <span className="section-meta">
          {library.length > 0 ? t('savedOnDevice') : t('sampleData')}
        </span>
      </div>

      <div className="book-grid">
        {library.length > 0 ? (
          library
            .slice(0, 8)
            .map((entry) => (
              <StoredBookCard
                key={entry.book.id}
                entry={entry}
                headingLevel={3}
                t={t}
                onOpen={() => void onOpenStored(entry)}
              />
            ))
        ) : (
          <article className="book-card">
            <div className="book-cover" aria-hidden="true">
              A
            </div>
            <div className="book-details">
              <div className="book-badges">
                <span className="badge">{demoRecentBook.format}</span>
                <span className="badge">{t('sampleData')}</span>
              </div>
              <h3 className="book-title">{demoRecentBook.title}</h3>
              <p className="book-author">{demoRecentBook.author}</p>
              <div className="progress-row">
                <span>{t('progress')}</span>
                <span>{progress}%</span>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-label={t('progress')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
              >
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <button
                className="book-action"
                type="button"
                onClick={() => onOpenSample(sampleEpub)}
              >
                {t('openBook')} →
              </button>
            </div>
          </article>
        )}
      </div>

      <article className="foundation-card">
        <div>
          <p className="eyebrow">{t('phaseLabel')}</p>
          <h2 className="foundation-title">{t('phaseTitle')}</h2>
          <p className="foundation-copy">{t('phaseBody')}</p>
        </div>
        <div className="runtime-chip">
          <span className="runtime-name">
            {platform.target === 'desktop' ? t('desktop') : t('web')}
          </span>
          <span className="runtime-version">
            {t('version')} {appVersion}
          </span>
        </div>
      </article>
    </section>
  );
}

interface LibraryPageProps {
  readonly library: readonly LibraryEntry[];
  readonly t: (key: MessageKey) => string;
  readonly onImportBooks: (files: readonly File[]) => Promise<void>;
  readonly onUpdateBook: (entry: LibraryEntry, draft: BookMetadataDraft) => Promise<void>;
  readonly onDeleteBook: (entry: LibraryEntry, options: DeleteBookOptions) => Promise<void>;
  readonly onOpenSample: (source: ReaderSource) => void;
  readonly onOpenStored: (entry: LibraryEntry) => Promise<void>;
}

function LibraryPage({
  library,
  t,
  onImportBooks,
  onUpdateBook,
  onDeleteBook,
  onOpenSample,
  onOpenStored,
}: LibraryPageProps) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<LibrarySort>(() => {
    const stored = globalThis.localStorage?.getItem('lexianchor:library-sort');
    return ['recent', 'imported', 'title', 'progress'].includes(stored ?? '')
      ? (stored as LibrarySort)
      : 'recent';
  });
  const [bookToDelete, setBookToDelete] = useState<LibraryEntry | null>(null);
  const [bookToEdit, setBookToEdit] = useState<LibraryEntry | null>(null);
  const [isDraggingBooks, setIsDraggingBooks] = useState(false);
  const visibleLibrary = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const entries = normalizedQuery
      ? library.filter((entry) =>
          `${entry.book.title}\n${entry.book.author}`.toLocaleLowerCase().includes(normalizedQuery),
        )
      : [...library];

    return entries.toSorted((left, right) => {
      if (sort === 'title') {
        return left.book.title.localeCompare(right.book.title, undefined, { sensitivity: 'base' });
      }

      if (sort === 'progress') {
        return (
          normalizeProgress(right.progress?.percentage ?? 0) -
          normalizeProgress(left.progress?.percentage ?? 0)
        );
      }

      const leftDate =
        sort === 'imported'
          ? left.book.importedAt
          : (left.book.lastOpenedAt ?? left.book.importedAt);
      const rightDate =
        sort === 'imported'
          ? right.book.importedAt
          : (right.book.lastOpenedAt ?? right.book.importedAt);
      return rightDate.localeCompare(leftDate);
    });
  }, [library, query, sort]);

  useEffect(() => {
    globalThis.localStorage?.setItem('lexianchor:library-sort', sort);
  }, [sort]);

  function importBooks(files: FileList | readonly File[] | null) {
    if (!files || files.length === 0) {
      return;
    }

    void onImportBooks(Array.from(files));
  }

  return (
    <section
      className={`page library-page${isDraggingBooks ? ' library-page--dragging' : ''}`}
      aria-labelledby="library-title"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          setIsDraggingBooks(true);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsDraggingBooks(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDraggingBooks(false);
        importBooks(event.dataTransfer.files);
      }}
    >
      <header className="page-header">
        <div>
          <p className="eyebrow">LexiAnchor</p>
          <h1 className="page-title" id="library-title">
            {t('libraryTitle')}
          </h1>
          <p className="page-description">{t('libraryExperimentBody')}</p>
        </div>
      </header>

      <div className="library-actions">
        <label className="import-button">
          <Icon name="book-open" className="button-icon" />
          <span>{t('importBooks')}</span>
          <input
            type="file"
            multiple
            accept=".epub,.pdf,application/epub+zip,application/pdf"
            onChange={(event) => {
              const input = event.currentTarget;
              importBooks(input.files);
              input.value = '';
            }}
          />
        </label>
        <button className="button" type="button" onClick={() => onOpenSample(sampleEpub)}>
          {t('openSampleBook')}
        </button>
      </div>
      <p className="library-drop-hint" aria-live="polite">
        {isDraggingBooks ? t('dropBooksNow') : t('dropBooksHint')}
      </p>

      {library.length > 0 ? (
        <>
          <div className="library-tools">
            <label className="library-search">
              <span>{t('librarySearch')}</span>
              <input
                type="search"
                value={query}
                placeholder={t('librarySearchPlaceholder')}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label className="library-sort">
              <span>{t('librarySort')}</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}>
                <option value="recent">{t('sortRecentlyRead')}</option>
                <option value="imported">{t('sortImported')}</option>
                <option value="title">{t('sortTitle')}</option>
                <option value="progress">{t('sortProgress')}</option>
              </select>
            </label>
          </div>
          <div className="section-heading">
            <h2 className="section-title">{t('savedOnDevice')}</h2>
            <span className="section-meta">
              {visibleLibrary.length} / {library.length}
            </span>
          </div>
          {visibleLibrary.length > 0 ? (
            <div className="book-grid saved-book-grid">
              {visibleLibrary.map((entry) => (
                <StoredBookCard
                  key={entry.book.id}
                  entry={entry}
                  headingLevel={2}
                  t={t}
                  onOpen={() => void onOpenStored(entry)}
                  onEdit={() => setBookToEdit(entry)}
                  onDelete={() => setBookToDelete(entry)}
                />
              ))}
            </div>
          ) : (
            <div className="library-no-results">
              <h2>{t('noBooksFound')}</h2>
              <p>{t('noBooksFoundDescription')}</p>
            </div>
          )}
          <div className="section-heading sample-section-heading">
            <h2 className="section-title">{t('testBooks')}</h2>
          </div>
        </>
      ) : null}

      <div className="book-grid">
        <article className="book-card">
          <div className="book-cover" aria-hidden="true">
            A
          </div>
          <div className="book-details">
            <div className="book-badges">
              <span className="badge">EPUB 3</span>
              <span className="badge">{t('sampleData')}</span>
            </div>
            <h2 className="book-title">Anchored Reading</h2>
            <p className="book-author">LexiAnchor</p>
            <p className="fixture-description">{t('sampleBookDescription')}</p>
            <button className="book-action" type="button" onClick={() => onOpenSample(sampleEpub)}>
              {t('openBook')} →
            </button>
          </div>
        </article>

        <article className="book-card">
          <div className="book-cover pdf-cover" aria-hidden="true">
            P
          </div>
          <div className="book-details">
            <div className="book-badges">
              <span className="badge">PDF</span>
              <span className="badge">{t('textLayer')}</span>
            </div>
            <h2 className="book-title">Anchored Pages</h2>
            <p className="book-author">LexiAnchor</p>
            <p className="fixture-description">{t('sampleTextPdfDescription')}</p>
            <button
              className="book-action"
              type="button"
              onClick={() => onOpenSample(sampleTextPdf)}
            >
              {t('openBook')} →
            </button>
          </div>
        </article>

        <article className="book-card">
          <div className="book-cover scan-cover" aria-hidden="true">
            S
          </div>
          <div className="book-details">
            <div className="book-badges">
              <span className="badge">PDF</span>
              <span className="badge">{t('imageOnly')}</span>
            </div>
            <h2 className="book-title">Image-only Sample</h2>
            <p className="book-author">LexiAnchor</p>
            <p className="fixture-description">{t('sampleScanPdfDescription')}</p>
            <button
              className="book-action"
              type="button"
              onClick={() => onOpenSample(sampleScanPdf)}
            >
              {t('openBook')} →
            </button>
          </div>
        </article>
      </div>

      {bookToDelete ? (
        <BookDeleteDialog
          entry={bookToDelete}
          t={t}
          onCancel={() => setBookToDelete(null)}
          onDelete={async (options) => {
            await onDeleteBook(bookToDelete, options);
            setBookToDelete(null);
          }}
        />
      ) : null}

      {bookToEdit ? (
        <BookMetadataDialog
          entry={bookToEdit}
          t={t}
          onCancel={() => setBookToEdit(null)}
          onSave={async (draft) => {
            await onUpdateBook(bookToEdit, draft);
            setBookToEdit(null);
          }}
        />
      ) : null}
    </section>
  );
}

interface StoredBookCardProps {
  readonly entry: LibraryEntry;
  readonly headingLevel: 2 | 3;
  readonly t: (key: MessageKey) => string;
  readonly onOpen: () => void;
  readonly onEdit?: () => void;
  readonly onDelete?: () => void;
}

function StoredBookCard({ entry, headingLevel, t, onOpen, onEdit, onDelete }: StoredBookCardProps) {
  const progress = normalizeProgress(entry.progress?.percentage ?? 0);
  const title = entry.book.title;
  const titleElement =
    headingLevel === 2 ? (
      <h2 className="book-title">{title}</h2>
    ) : (
      <h3 className="book-title">{title}</h3>
    );

  return (
    <article className="book-card" data-book-id={entry.book.id}>
      <div
        className={`book-cover${entry.book.format === 'pdf' ? ' pdf-cover' : ''}`}
        aria-hidden="true"
      >
        {title.trim().charAt(0).toUpperCase() || 'B'}
      </div>
      <div className="book-details">
        <div className="book-badges">
          <span className="badge">{entry.book.format.toUpperCase()}</span>
          <span className="badge">{t('savedOnDevice')}</span>
        </div>
        {titleElement}
        <p className="book-author">{entry.book.author || t('unknownAuthor')}</p>
        <div className="progress-row">
          <span>{t('progress')}</span>
          <span>{progress}%</span>
        </div>
        <div
          className="progress-track"
          role="progressbar"
          aria-label={`${title} · ${t('progress')}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="book-card-actions">
          <button className="book-action" type="button" onClick={onOpen}>
            {t('openBook')} →
          </button>
          <div className="book-secondary-actions">
            {onEdit ? (
              <button
                className="book-edit-action"
                type="button"
                aria-label={`${t('editBookMetadata')} ${title}`}
                onClick={onEdit}
              >
                {t('editBookMetadata')}
              </button>
            ) : null}
            {onDelete ? (
              <button
                className="book-delete-action"
                type="button"
                aria-label={`${t('deleteBook')} ${title}`}
                onClick={onDelete}
              >
                {t('deleteBook')}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

interface BookMetadataDialogProps {
  readonly entry: LibraryEntry;
  readonly t: (key: MessageKey) => string;
  readonly onCancel: () => void;
  readonly onSave: (draft: BookMetadataDraft) => Promise<void>;
}

function BookMetadataDialog({ entry, t, onCancel, onSave }: BookMetadataDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(entry.book.title);
  const [author, setAuthor] = useState(entry.book.author);
  const [language, setLanguage] = useState(entry.book.language ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog && !dialog.open) {
      dialog.showModal();
    }

    return () => {
      if (dialog?.open) {
        dialog.close();
      }
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="book-delete-dialog book-metadata-dialog"
      aria-labelledby="book-metadata-title"
      onCancel={(event) => {
        event.preventDefault();

        if (!isSaving) {
          onCancel();
        }
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setIsSaving(true);
          setError('');
          void onSave({ title, author, language }).catch((saveError: unknown) => {
            setError(saveError instanceof Error ? saveError.message : String(saveError));
            setIsSaving(false);
          });
        }}
      >
        <p className="eyebrow">{entry.book.format.toUpperCase()}</p>
        <h2 id="book-metadata-title">{t('editBookMetadata')}</h2>
        <p className="book-delete-description">{t('editBookMetadataDescription')}</p>

        <label className="book-metadata-field">
          <span>{t('bookTitleField')}</span>
          <input
            autoFocus
            required
            value={title}
            disabled={isSaving}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="book-metadata-field">
          <span>{t('bookAuthorField')}</span>
          <input
            value={author}
            disabled={isSaving}
            onChange={(event) => setAuthor(event.target.value)}
          />
        </label>
        <label className="book-metadata-field">
          <span>{t('bookLanguageField')}</span>
          <input
            value={language}
            disabled={isSaving}
            placeholder={t('bookLanguagePlaceholder')}
            onChange={(event) => setLanguage(event.target.value)}
          />
        </label>

        {error ? (
          <p className="book-delete-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="book-delete-dialog-actions">
          <button type="button" disabled={isSaving} onClick={onCancel}>
            {t('cancel')}
          </button>
          <button className="book-metadata-save" type="submit" disabled={isSaving}>
            {isSaving ? t('savingChanges') : t('saveChanges')}
          </button>
        </div>
      </form>
    </dialog>
  );
}

interface BookDeleteDialogProps {
  readonly entry: LibraryEntry;
  readonly t: (key: MessageKey) => string;
  readonly onCancel: () => void;
  readonly onDelete: (options: DeleteBookOptions) => Promise<void>;
}

function BookDeleteDialog({ entry, t, onCancel, onDelete }: BookDeleteDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [keepProgress, setKeepProgress] = useState(false);
  const [keepWordCards, setKeepWordCards] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog && !dialog.open) {
      dialog.showModal();
    }

    return () => {
      if (dialog?.open) {
        dialog.close();
      }
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="book-delete-dialog"
      aria-labelledby="book-delete-title"
      onCancel={(event) => {
        event.preventDefault();

        if (!isDeleting) {
          onCancel();
        }
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setIsDeleting(true);
          setError('');
          void onDelete({ keepProgress, keepWordCards }).catch((deleteError: unknown) => {
            setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
            setIsDeleting(false);
          });
        }}
      >
        <p className="eyebrow">{t('localOnly')}</p>
        <h2 id="book-delete-title">
          {t('confirmDeleteBook')} “{entry.book.title}”?
        </h2>
        <p className="book-delete-description">{t('deleteBookDescription')}</p>

        <label className="book-delete-option">
          <input
            type="checkbox"
            checked={keepProgress}
            disabled={isDeleting}
            onChange={(event) => setKeepProgress(event.target.checked)}
          />
          <span>
            <strong>{t('keepReadingProgress')}</strong>
            <small>{t('keepReadingProgressDescription')}</small>
          </span>
        </label>

        <label className="book-delete-option">
          <input
            type="checkbox"
            checked={keepWordCards}
            disabled={isDeleting}
            onChange={(event) => setKeepWordCards(event.target.checked)}
          />
          <span>
            <strong>{t('keepBookWordCards')}</strong>
            <small>{t('keepBookWordCardsDescription')}</small>
          </span>
        </label>

        {error ? (
          <p className="book-delete-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="book-delete-dialog-actions">
          <button type="button" autoFocus disabled={isDeleting} onClick={onCancel}>
            {t('cancel')}
          </button>
          <button className="book-delete-confirm" type="submit" disabled={isDeleting}>
            {isDeleting ? t('deletingBook') : t('deleteLocalCopy')}
          </button>
        </div>
      </form>
    </dialog>
  );
}

interface CardsPageProps {
  readonly cards: readonly WordCardRecord[];
  readonly query: string;
  readonly locale: Locale;
  readonly t: (key: MessageKey) => string;
  readonly onQueryChange: (query: string) => void;
  readonly onUpdate: (cardId: string, draft: WordCardEditDraft) => Promise<void>;
  readonly onDelete: (cardId: string) => Promise<void>;
  readonly deletedCard: WordCardRecord | null;
  readonly onUndoDelete: () => Promise<void>;
  readonly onExport: () => Promise<void>;
  readonly onImport: (file: File) => Promise<void>;
  readonly transferMessage: string;
}

function CardsPage({
  cards,
  query,
  locale,
  t,
  onQueryChange,
  onUpdate,
  onDelete,
  deletedCard,
  onUndoDelete,
  onExport,
  onImport,
  transferMessage,
}: CardsPageProps) {
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [cardSort, setCardSort] = useState<'newest' | 'oldest'>(() =>
    globalThis.localStorage?.getItem('lexianchor:card-sort') === 'oldest' ? 'oldest' : 'newest',
  );
  const sortedCards = useMemo(
    () =>
      [...cards].sort((left, right) => {
        const difference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
        return cardSort === 'newest' ? difference : -difference;
      }),
    [cardSort, cards],
  );

  return (
    <section className="page" aria-labelledby="cards-title">
      <header className="page-header">
        <div>
          <p className="eyebrow">LexiAnchor</p>
          <h1 className="page-title" id="cards-title">
            {t('cardsTitle')}
          </h1>
          <p className="page-description">{t('cardsDescription')}</p>
        </div>
        <div className="card-transfer-actions">
          <button type="button" onClick={() => void onExport()}>
            {t('exportCards')}
          </button>
          <label>
            <span>{t('importCards')}</span>
            <input
              className="sr-only"
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) {
                  void onImport(file);
                }
              }}
            />
          </label>
        </div>
      </header>

      <div className="card-list-controls">
        <label className="card-search">
          <span>{t('cardsSearch')}</span>
          <input
            type="search"
            value={query}
            placeholder={t('cardsSearchPlaceholder')}
            onChange={(event) => {
              setActiveCardId(null);
              onQueryChange(event.target.value);
            }}
          />
        </label>
        <label className="card-sort">
          <span>{t('sortCards')}</span>
          <select
            value={cardSort}
            onChange={(event) => {
              const nextSort = event.target.value === 'oldest' ? 'oldest' : 'newest';
              setCardSort(nextSort);
              globalThis.localStorage?.setItem('lexianchor:card-sort', nextSort);
            }}
          >
            <option value="newest">{t('newestFirst')}</option>
            <option value="oldest">{t('oldestFirst')}</option>
          </select>
        </label>
      </div>
      {cards.length === 200 ? (
        <p className="card-result-limit" role="status">
          {t('cardsResultLimit')}
        </p>
      ) : null}

      {deletedCard ? (
        <div className="card-delete-notice" role="status">
          <span>
            {t('cardDeleted')} “{deletedCard.term}”
          </span>
          <button type="button" onClick={() => void onUndoDelete()}>
            {t('undo')}
          </button>
        </div>
      ) : null}

      {transferMessage ? (
        <p className="card-transfer-status" role="status">
          {transferMessage}
        </p>
      ) : null}

      {cards.length > 0 ? (
        <div className="word-card-grid">
          {sortedCards.map((card) => (
            <article className="word-card" data-word-card-id={card.id} key={card.id}>
              {editingCardId === card.id ? (
                <WordCardEditor
                  card={card}
                  t={t}
                  onCancel={() => setEditingCardId(null)}
                  onSave={async (draft) => {
                    await onUpdate(card.id, draft);
                    setEditingCardId(null);
                  }}
                />
              ) : (
                <>
                  <button
                    className="word-card-preview"
                    type="button"
                    aria-label={`${t('viewCardDetails')} ${card.term}`}
                    onClick={() => setActiveCardId(card.id)}
                  >
                    <span className="word-card-occurrence">
                      {t('addedTimes')} ×{card.occurrenceCount}
                    </span>
                    <div className="word-card-heading">
                      <span className="badge">{card.partOfSpeech}</span>
                      <h2>{card.term}</h2>
                    </div>
                    <p className="word-card-definition-label">{t('englishDefinition')}</p>
                    <ol className="word-card-definition-list">
                      {card.definitions.slice(0, 3).map((definition) => (
                        <li key={definition}>{definition}</li>
                      ))}
                    </ol>
                    <span className="word-card-detail-cue">{t('viewCardDetails')} →</span>
                  </button>
                  <div className="word-card-actions">
                    <button
                      className="word-card-edit"
                      type="button"
                      aria-label={`${t('editCard')} ${card.term}`}
                      onClick={() => setEditingCardId(card.id)}
                    >
                      {t('editCard')}
                    </button>
                    <button
                      className="word-card-delete"
                      type="button"
                      aria-label={`${t('deleteCard')} ${card.term}`}
                      onClick={() => void onDelete(card.id)}
                    >
                      {t('deleteCard')}
                    </button>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <div className="empty-icon">
            <Icon name="cards" />
          </div>
          <h2 className="empty-title">{query ? t('noCardsFound') : t('cardsEmptyTitle')}</h2>
          <p className="empty-copy">{query ? t('noCardsFoundDescription') : t('cardsEmptyBody')}</p>
        </div>
      )}

      <WordCardDetailDialog
        cards={sortedCards}
        activeCardId={activeCardId}
        locale={locale}
        t={t}
        onActiveCardChange={setActiveCardId}
        onClose={() => setActiveCardId(null)}
      />
    </section>
  );
}

interface WordCardEditorProps {
  readonly card: WordCardRecord;
  readonly t: (key: MessageKey) => string;
  readonly onSave: (draft: WordCardEditDraft) => Promise<void>;
  readonly onCancel: () => void;
}

function WordCardEditor({ card, t, onSave, onCancel }: WordCardEditorProps) {
  const [draft, setDraft] = useState<WordCardEditDraft>({
    term: card.term,
    partOfSpeech: card.partOfSpeech,
    definitions: card.definitions.length > 0 ? [...card.definitions] : [card.definition],
    rootOrEtymology: card.rootOrEtymology ?? '',
    sourceBookTitle: card.sourceBookTitle,
    sourceSentence: card.sourceSentence,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const standardPartsOfSpeech = ['noun', 'verb', 'adjective', 'adverb', 'unknown'] as const;

  async function submit() {
    setIsSaving(true);
    setError('');

    try {
      await onSave(draft);
    } catch (error) {
      setError(error instanceof Error ? error.message : t('cardUpdateFailed'));
      setIsSaving(false);
    }
  }

  return (
    <form
      className="word-card-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="word-card-editor-grid">
        <label>
          <span>{t('wordField')}</span>
          <input
            autoFocus
            required
            maxLength={160}
            value={draft.term}
            onChange={(event) => setDraft({ ...draft, term: event.target.value })}
          />
        </label>
        <label>
          <span>{t('partOfSpeechField')}</span>
          <select
            value={draft.partOfSpeech}
            onChange={(event) => setDraft({ ...draft, partOfSpeech: event.target.value })}
          >
            {!standardPartsOfSpeech.includes(
              draft.partOfSpeech as (typeof standardPartsOfSpeech)[number],
            ) ? (
              <option value={draft.partOfSpeech}>{draft.partOfSpeech}</option>
            ) : null}
            {standardPartsOfSpeech.map((partOfSpeech) => (
              <option value={partOfSpeech} key={partOfSpeech}>
                {t(partOfSpeech === 'unknown' ? 'unknownPartOfSpeech' : partOfSpeech)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="word-card-definition-editor">
        <legend>{t('englishDefinition')}</legend>
        {draft.definitions.map((definition, index) => (
          <div className="word-card-definition-editor-row" key={index}>
            <label>
              <span>
                {t('englishDefinition')} {index + 1}
              </span>
              <textarea
                required
                rows={2}
                maxLength={2_000}
                value={definition}
                onChange={(event) => {
                  const definitions = [...draft.definitions];
                  definitions[index] = event.target.value;
                  setDraft({ ...draft, definitions });
                }}
              />
            </label>
            <button
              className="word-card-definition-remove"
              type="button"
              aria-label={`${t('removeDefinition')} ${index + 1}`}
              disabled={draft.definitions.length === 1}
              onClick={() =>
                setDraft({
                  ...draft,
                  definitions: draft.definitions.filter(
                    (_, candidateIndex) => candidateIndex !== index,
                  ),
                })
              }
            >
              {t('removeDefinition')}
            </button>
          </div>
        ))}
        <button
          className="word-card-definition-add"
          type="button"
          disabled={draft.definitions.length >= 12}
          onClick={() => setDraft({ ...draft, definitions: [...draft.definitions, ''] })}
        >
          + {t('addDefinition')}
        </button>
      </fieldset>
      <label>
        <span>{t('wordRoot')}</span>
        <input
          maxLength={500}
          value={draft.rootOrEtymology}
          onChange={(event) => setDraft({ ...draft, rootOrEtymology: event.target.value })}
        />
      </label>
      <label>
        <span>{t('sourceBook')}</span>
        <input
          required
          maxLength={500}
          value={draft.sourceBookTitle}
          onChange={(event) => setDraft({ ...draft, sourceBookTitle: event.target.value })}
        />
      </label>
      <label>
        <span>{t('originalSentence')}</span>
        <textarea
          required
          rows={3}
          maxLength={4_000}
          value={draft.sourceSentence}
          onChange={(event) => setDraft({ ...draft, sourceSentence: event.target.value })}
        />
      </label>

      {error ? (
        <p className="word-card-editor-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="word-card-editor-actions">
        <button className="word-card-save" type="submit" disabled={isSaving}>
          {isSaving ? t('savingChanges') : t('saveChanges')}
        </button>
        <button type="button" disabled={isSaving} onClick={onCancel}>
          {t('cancel')}
        </button>
      </div>
    </form>
  );
}

interface SettingsPageProps {
  readonly appVersion: string;
  readonly updateCheckResult: UpdateCheckResult | null;
  readonly isCheckingForUpdates: boolean;
  readonly locale: Locale;
  readonly storageHealth: StorageHealth | undefined;
  readonly isRequestingPersistentStorage: boolean;
  readonly applicationBackupMessage: string;
  readonly isApplicationBackupBusy: boolean;
  readonly dictionaryPreferences: DictionaryPreferences;
  readonly onlineTranslationProvider: OnlineTranslationProvider;
  readonly installedDictionaries: DictionaryInstallState;
  readonly installingDictionary: DownloadableDictionaryId | null;
  readonly userStarDict: StarDictInstallStatus | null;
  readonly translationModels: TranslationInstallState;
  readonly installingTranslationModel: TranslationTargetLanguage | null;
  readonly translationModelProgress: TranslationModelProgress | null;
  readonly t: (key: MessageKey) => string;
  readonly onToggleDictionary: (id: DictionaryId, enabled: boolean) => void;
  readonly onOnlineTranslationProviderChange: (provider: OnlineTranslationProvider) => void;
  readonly onMoveDictionary: (id: DictionaryId, direction: -1 | 1) => void;
  readonly onInstallFreeDict: (id: DownloadableDictionaryId) => Promise<void>;
  readonly onRemoveFreeDict: (id: DownloadableDictionaryId) => Promise<void>;
  readonly onImportStarDict: (files: readonly File[]) => Promise<void>;
  readonly onRemoveStarDict: () => Promise<void>;
  readonly onInstallTranslationModel: (targetLanguage: TranslationTargetLanguage) => Promise<void>;
  readonly onCancelTranslationInstall: () => void;
  readonly onRemoveTranslationModel: (targetLanguage: TranslationTargetLanguage) => Promise<void>;
  readonly onOpenExternal: (url: string) => Promise<void>;
  readonly onCheckForUpdates: () => Promise<void>;
  readonly onProtectLocalStorage: () => Promise<void>;
  readonly onExportApplicationData: (includeBookFiles: boolean) => Promise<void>;
  readonly onImportApplicationData: (file: File | undefined) => Promise<void>;
}

function SettingsPage({
  appVersion,
  updateCheckResult,
  isCheckingForUpdates,
  locale,
  storageHealth,
  isRequestingPersistentStorage,
  applicationBackupMessage,
  isApplicationBackupBusy,
  dictionaryPreferences,
  onlineTranslationProvider,
  installedDictionaries,
  installingDictionary,
  userStarDict,
  translationModels,
  installingTranslationModel,
  translationModelProgress,
  t,
  onToggleDictionary,
  onOnlineTranslationProviderChange,
  onMoveDictionary,
  onInstallFreeDict,
  onRemoveFreeDict,
  onImportStarDict,
  onRemoveStarDict,
  onInstallTranslationModel,
  onCancelTranslationInstall,
  onRemoveTranslationModel,
  onOpenExternal,
  onCheckForUpdates,
  onProtectLocalStorage,
  onExportApplicationData,
  onImportApplicationData,
}: SettingsPageProps) {
  const [includeBookFiles, setIncludeBookFiles] = useState(false);
  const descriptions: Readonly<
    Record<
      DictionaryId,
      {
        readonly name: string;
        readonly languages: string;
        readonly license: string;
        readonly source?: string;
        readonly licenseUrl?: string;
        readonly downloadNote?: MessageKey;
        readonly qualityNote?: MessageKey;
      }
    >
  > = {
    'english-wiktionary': {
      name: 'English Wiktionary + WordNet fallback',
      languages: 'EN → EN',
      license: 'CC-BY-SA-4.0 / Princeton WordNet License',
      source: 'https://en.wiktionary.org/',
      licenseUrl: 'https://en.wiktionary.org/wiki/Wiktionary:Copyrights',
      qualityNote: 'expandedEnglishDictionaryNote',
    },
    'freedict-eng-fra-0.1.6': {
      name: 'FreeDict English–French 0.1.6',
      languages: 'EN → FR',
      license: 'GPL-2.0-or-later',
      source:
        'https://github.com/freedict/fd-dictionaries/tree/5bdceeac8d0dba3298c1bebe734f60d54dad30f7/eng-fra',
      licenseUrl: 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html',
      downloadNote: 'dictionaryDownloadNote',
    },
    'freedict-eng-zho-2025.11.23': {
      name: 'FreeDict/WikDict English–Chinese 2025.11.23',
      languages: 'EN → ZH',
      license: 'CC-BY-SA-3.0',
      source: 'https://download.freedict.org/dictionaries/eng-zho/2025.11.23/',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
      downloadNote: 'chineseDictionaryDownloadNote',
      qualityNote: 'automatedDictionaryNote',
    },
    'user-stardict': {
      name: userStarDict?.name || t('userStarDict'),
      languages: t('userDictionary'),
      license: t('userSupplied'),
      qualityNote: 'userDictionaryResponsibility',
    },
  };

  return (
    <section className="page" aria-labelledby="settings-title">
      <header className="page-header">
        <div>
          <p className="eyebrow">LexiAnchor</p>
          <h1 className="page-title" id="settings-title">
            {t('settings')}
          </h1>
          <p className="page-description">{t('settingsDescription')}</p>
        </div>
      </header>

      <header className="settings-section-heading settings-section-heading-first">
        <h2>{t('applicationUpdate')}</h2>
        <p>{t('applicationUpdateDescription')}</p>
      </header>

      <article className="application-update-card" data-testid="application-update">
        <div className="application-update-status">
          <div>
            <span>{t('currentVersion')}</span>
            <strong>v{appVersion}</strong>
          </div>
          <p role="status">
            {isCheckingForUpdates
              ? t('checkingForUpdates')
              : updateCheckResult?.status === 'available'
                ? `${t('updateAvailable')} v${updateCheckResult.release.version}`
                : updateCheckResult?.status === 'up-to-date'
                  ? t('upToDate')
                  : updateCheckResult?.status === 'unavailable'
                    ? t('updateCheckUnavailable')
                    : t('updateNotChecked')}
          </p>
        </div>

        <p className="application-update-safety">{t('updateDataSafety')}</p>

        <div className="application-update-actions">
          <button
            className="storage-protect-action"
            type="button"
            disabled={isCheckingForUpdates}
            onClick={() => void onCheckForUpdates()}
          >
            {isCheckingForUpdates ? t('checkingForUpdates') : t('checkForUpdates')}
          </button>
          {updateCheckResult?.status === 'available' ? (
            <button
              type="button"
              onClick={() => void onOpenExternal(updateCheckResult.release.url)}
            >
              {t('openDownloadPage')}
            </button>
          ) : null}
        </div>

        {updateCheckResult?.status === 'available' ? (
          <section className="update-backup-reminder" aria-labelledby="update-backup-title">
            <div>
              <h3 id="update-backup-title">{t('backupBeforeUpdate')}</h3>
              <p>{t('backupBeforeUpdateDescription')}</p>
            </div>
            <button
              type="button"
              disabled={isApplicationBackupBusy}
              onClick={() => void onExportApplicationData(true)}
            >
              {t('exportCompleteBackup')}
            </button>
          </section>
        ) : null}
      </article>

      <header className="settings-section-heading">
        <h2>{t('localStorageTitle')}</h2>
        <p>{t('localStorageDescription')}</p>
      </header>

      <article className="storage-health-card" data-testid="storage-health">
        <div className="storage-health-heading">
          <div>
            <h3>
              {storageHealth?.persisted
                ? t('persistentStorage')
                : storageHealth?.persisted === false
                  ? t('bestEffortStorage')
                  : t('storageStatusUnavailable')}
            </h3>
            <p>
              {storageHealth?.persisted
                ? t('persistentStorageDescription')
                : t('bestEffortStorageDescription')}
            </p>
          </div>
          {storageHealth?.supported && !storageHealth.persisted ? (
            <button
              className="storage-protect-action"
              type="button"
              disabled={isRequestingPersistentStorage}
              onClick={() => void onProtectLocalStorage()}
            >
              {isRequestingPersistentStorage
                ? t('requestingStorageProtection')
                : t('protectLocalData')}
            </button>
          ) : null}
        </div>
        <dl className="storage-health-metrics">
          <div>
            <dt>{t('storageUsed')}</dt>
            <dd>{formatStorageBytes(storageHealth?.usageBytes ?? null, locale)}</dd>
          </div>
          <div>
            <dt>{t('storageAvailable')}</dt>
            <dd>{formatStorageBytes(storageHealth?.quotaBytes ?? null, locale)}</dd>
          </div>
        </dl>
        {storageHealth?.usageBytes !== null &&
        storageHealth?.usageBytes !== undefined &&
        storageHealth.quotaBytes ? (
          <meter
            aria-label={t('storageUsed')}
            min="0"
            max={storageHealth.quotaBytes}
            value={Math.min(storageHealth.usageBytes, storageHealth.quotaBytes)}
          />
        ) : null}

        <section className="application-backup-controls" aria-labelledby="application-backup-title">
          <div>
            <h4 id="application-backup-title">{t('applicationBackupTitle')}</h4>
            <p>{t('applicationBackupDescription')}</p>
          </div>
          <label className="application-backup-option">
            <input
              type="checkbox"
              checked={includeBookFiles}
              onChange={(event) => setIncludeBookFiles(event.target.checked)}
            />
            <span>
              <strong>{t('includeBookFiles')}</strong>
              <small>{t('includeBookFilesDescription')}</small>
            </span>
          </label>
          <div className="application-backup-actions">
            <button
              className="storage-protect-action"
              type="button"
              disabled={isApplicationBackupBusy}
              onClick={() => void onExportApplicationData(includeBookFiles)}
            >
              {t('exportApplicationBackup')}
            </button>
            <label
              className={`application-backup-import${
                isApplicationBackupBusy ? ' application-backup-import-disabled' : ''
              }`}
            >
              <span>{t('importApplicationBackup')}</span>
              <input
                type="file"
                accept=".zip,application/zip"
                disabled={isApplicationBackupBusy}
                onChange={(event) => {
                  const input = event.currentTarget;
                  void onImportApplicationData(input.files?.[0]).finally(() => {
                    input.value = '';
                  });
                }}
              />
            </label>
          </div>
          {applicationBackupMessage ? (
            <p className="application-backup-message" role="status">
              {applicationBackupMessage}
            </p>
          ) : null}
        </section>
      </article>

      <header className="settings-section-heading">
        <h2>{t('offlineDictionaries')}</h2>
        <p>{t('dictionarySettingsDescription')}</p>
      </header>

      <div className="dictionary-settings-list">
        {dictionaryPreferences.order.map((id, index) => {
          const description = descriptions[id];
          const downloadableId = isDownloadableDictionary(id) ? id : null;
          const isUserDictionary = id === 'user-stardict';
          const installed = downloadableId
            ? installedDictionaries[downloadableId]
            : isUserDictionary
              ? Boolean(userStarDict?.installed)
              : true;

          return (
            <article className="dictionary-settings-card" data-dictionary-id={id} key={id}>
              <div className="dictionary-settings-main">
                <div>
                  <div className="dictionary-settings-title">
                    <h2>{description.name}</h2>
                    <span className="dictionary-language">{description.languages}</span>
                  </div>
                  <p>
                    {installed ? t('installed') : t('notInstalled')} · {description.license}
                  </p>
                </div>
                <label className="dictionary-enable">
                  <span>{t('enabled')}</span>
                  <input
                    type="checkbox"
                    checked={dictionaryPreferences.enabled[id] && installed}
                    disabled={!installed}
                    onChange={(event) => onToggleDictionary(id, event.target.checked)}
                  />
                </label>
              </div>

              <div className="dictionary-settings-actions">
                <button
                  type="button"
                  aria-label={`${t('moveUp')} ${description.name}`}
                  disabled={index === 0}
                  onClick={() => onMoveDictionary(id, -1)}
                >
                  ↑ {t('moveUp')}
                </button>
                <button
                  type="button"
                  aria-label={`${t('moveDown')} ${description.name}`}
                  disabled={index === dictionaryPreferences.order.length - 1}
                  onClick={() => onMoveDictionary(id, 1)}
                >
                  ↓ {t('moveDown')}
                </button>
                {description.source ? (
                  <button type="button" onClick={() => void onOpenExternal(description.source!)}>
                    {t('source')}
                  </button>
                ) : null}
                {description.licenseUrl ? (
                  <button
                    type="button"
                    onClick={() => void onOpenExternal(description.licenseUrl!)}
                  >
                    {t('license')}
                  </button>
                ) : null}
                {downloadableId ? (
                  installed ? (
                    <button
                      className="dictionary-remove"
                      type="button"
                      onClick={() => void onRemoveFreeDict(downloadableId)}
                    >
                      {t('removeDictionary')}
                    </button>
                  ) : (
                    <button
                      className="dictionary-install"
                      type="button"
                      disabled={installingDictionary !== null}
                      onClick={() => void onInstallFreeDict(downloadableId)}
                    >
                      {installingDictionary === downloadableId
                        ? t('downloadingDictionary')
                        : t('installDictionary')}
                    </button>
                  )
                ) : isUserDictionary ? (
                  <>
                    <label className="dictionary-import">
                      {installed ? t('replaceDictionary') : t('importDictionary')}
                      <input
                        type="file"
                        multiple
                        accept=".ifo,.idx,.dict"
                        onChange={(event) => {
                          const files = [...(event.currentTarget.files ?? [])];
                          event.currentTarget.value = '';
                          void onImportStarDict(files);
                        }}
                      />
                    </label>
                    {installed ? (
                      <button
                        className="dictionary-remove"
                        type="button"
                        onClick={() => void onRemoveStarDict()}
                      >
                        {t('removeDictionary')}
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
              {description.qualityNote ? (
                <p className="dictionary-quality-note">{t(description.qualityNote)}</p>
              ) : null}
              {description.downloadNote && !installed ? (
                <p className="dictionary-download-note">{t(description.downloadNote)}</p>
              ) : null}
              {isUserDictionary && !installed ? (
                <p className="dictionary-download-note">{t('starDictImportNote')}</p>
              ) : null}
            </article>
          );
        })}
      </div>

      <header className="settings-section-heading">
        <h2>{t('onlineTranslation')}</h2>
        <p>{t('onlineTranslationProviderDescription')}</p>
      </header>

      <article className="dictionary-settings-card online-translation-settings">
        <label className="reader-control">
          <span>{t('onlineTranslationProvider')}</span>
          <select
            value={onlineTranslationProvider}
            onChange={(event) =>
              onOnlineTranslationProviderChange(event.target.value as OnlineTranslationProvider)
            }
          >
            <option value="google">Google Translate</option>
            <option value="bing">Microsoft Bing Translator</option>
            <option value="baidu">Baidu Translate</option>
          </select>
        </label>
        <p className="dictionary-download-note">{t('onlineTranslationPrivacyNote')}</p>
      </article>

      <header className="settings-section-heading">
        <h2>{t('localTranslationModels')}</h2>
        <p>{t('localTranslationModelsDescription')}</p>
      </header>

      <div className="dictionary-settings-list">
        {(['fr', 'zh'] as const).map((targetLanguage) => {
          const resource = translationModelResources[targetLanguage];
          const status = translationModels[targetLanguage];
          const isInstalling = installingTranslationModel === targetLanguage;
          const percent =
            isInstalling && translationModelProgress
              ? Math.round(
                  (translationModelProgress.downloadedBytes / translationModelProgress.totalBytes) *
                    100,
                )
              : 0;

          return (
            <article
              className="dictionary-settings-card"
              data-translation-model={targetLanguage}
              key={targetLanguage}
            >
              <div className="dictionary-settings-main">
                <div>
                  <div className="dictionary-settings-title">
                    <h3>{resource.name}</h3>
                    <span className="dictionary-language">EN → {targetLanguage.toUpperCase()}</span>
                  </div>
                  <p>
                    {status.installed
                      ? t('installed')
                      : status.partial
                        ? t('partiallyDownloaded')
                        : t('notInstalled')}{' '}
                    · {resource.license}
                  </p>
                </div>
                <span className="translation-model-size">
                  {(resource.downloadSize / 1_000_000).toFixed(1)} MB
                </span>
              </div>

              <div className="dictionary-settings-actions">
                <button type="button" onClick={() => void onOpenExternal(resource.sourceUrl)}>
                  {t('source')}
                </button>
                <button type="button" onClick={() => void onOpenExternal(resource.licenseUrl)}>
                  {t('license')}
                </button>
                {isInstalling ? (
                  <button
                    className="dictionary-remove"
                    type="button"
                    onClick={onCancelTranslationInstall}
                  >
                    {t('pauseDownload')} · {percent}%
                  </button>
                ) : status.installed ? (
                  <button
                    className="dictionary-remove"
                    type="button"
                    onClick={() => void onRemoveTranslationModel(targetLanguage)}
                  >
                    {t('removeDictionary')}
                  </button>
                ) : (
                  <button
                    className="dictionary-install"
                    type="button"
                    disabled={installingTranslationModel !== null}
                    onClick={() => void onInstallTranslationModel(targetLanguage)}
                  >
                    {status.partial ? t('resumeDownload') : t('installModel')}
                  </button>
                )}
              </div>

              <p className="dictionary-download-note">
                {t(
                  targetLanguage === 'fr'
                    ? 'frenchTranslationModelNote'
                    : 'chineseTranslationModelNote',
                )}
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

interface IconProps {
  readonly name: IconName;
  readonly className?: string;
}

function Icon({ name, className }: IconProps) {
  const paths: Record<IconName, React.ReactNode> = {
    home: (
      <>
        <path d="m3 10 9-7 9 7" />
        <path d="M5 9v11h14V9" />
        <path d="M9 20v-7h6v7" />
      </>
    ),
    library: (
      <>
        <path d="M4 4h6v16H4z" />
        <path d="M10 4h5v16h-5" />
        <path d="m15 5 4-1 2 15-4 1z" />
      </>
    ),
    cards: (
      <>
        <rect x="4" y="5" width="16" height="14" rx="2" />
        <path d="M8 9h8M8 13h5" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.1A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3V9.6h.1A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4h-.1A1.7 1.7 0 0 0 19.4 15Z" />
      </>
    ),
    expand: (
      <>
        <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
    'book-open': (
      <>
        <path d="M3 5a7 7 0 0 1 9 2v14a7 7 0 0 0-9-2z" />
        <path d="M21 5a7 7 0 0 0-9 2v14a7 7 0 0 1 9-2z" />
      </>
    ),
  };

  return (
    <svg
      className={className}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
