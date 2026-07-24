import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import {
  FreeDictEnglishFrenchProvider,
  WordNetProvider,
  type DictionaryProvider,
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
import type { PlatformBridge } from '@lexianchor/platform';
import type { ReaderLocator, ReaderSource } from '@lexianchor/reader-core';
import {
  OpfsContentStore,
  sha256,
  SqliteBookRepository,
  type BookRecord,
  type ReadingProgressRecord,
  type StorageStatus,
  type WordCardRecord,
} from '@lexianchor/storage';
import { epubSpikeUrl, pdfScanUrl, pdfTextUrl } from '@lexianchor/test-fixtures';
import '@lexianchor/ui/styles.css';

import type { WordCardDraft } from './selection-tools';

type Section = 'home' | 'library' | 'cards' | 'settings';
type Theme = 'system' | 'light' | 'dark' | 'eye-care';
type IconName = Section | 'expand' | 'lock' | 'book-open';
type DictionaryId = 'princeton-wordnet-3.1' | 'freedict-eng-fra-0.1.6';

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

const wordNetProvider = new WordNetProvider();
const freeDictProvider = new FreeDictEnglishFrenchProvider();
const dictionaryIds: readonly DictionaryId[] = ['princeton-wordnet-3.1', 'freedict-eng-fra-0.1.6'];

let bookRepository: SqliteBookRepository | undefined;
const contentStore = new OpfsContentStore();

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

function readDictionaryPreferences(): DictionaryPreferences {
  const fallback: DictionaryPreferences = {
    order: dictionaryIds,
    enabled: {
      'princeton-wordnet-3.1': true,
      'freedict-eng-fra-0.1.6': true,
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
        'princeton-wordnet-3.1':
          parsed.enabled?.['princeton-wordnet-3.1'] ?? fallback.enabled['princeton-wordnet-3.1'],
        'freedict-eng-fra-0.1.6':
          parsed.enabled?.['freedict-eng-fra-0.1.6'] ?? fallback.enabled['freedict-eng-fra-0.1.6'],
      },
    };
  } catch {
    return fallback;
  }
}

export function App({ platform }: AppProps) {
  const [activeSection, setActiveSection] = useState<Section>('home');
  const [locale, setLocale] = useState<Locale>(readStoredLocale);
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [appVersion, setAppVersion] = useState('0.1.0');
  const [statusMessage, setStatusMessage] = useState('');
  const [storageStatus, setStorageStatus] = useState<StorageStatus>();
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [wordCards, setWordCards] = useState<WordCardRecord[]>([]);
  const [cardSearch, setCardSearch] = useState('');
  const [lastDeletedCard, setLastDeletedCard] = useState<WordCardRecord | null>(null);
  const [dictionaryPreferences, setDictionaryPreferences] = useState(readDictionaryPreferences);
  const [freeDictInstalled, setFreeDictInstalled] = useState(false);
  const [isInstallingDictionary, setIsInstallingDictionary] = useState(false);
  const [openBook, setOpenBook] = useState<OpenBookSession | null>(null);
  const t = useCallback((key: MessageKey) => translate(locale, key), [locale]);
  const dictionaryProviders = useMemo<readonly DictionaryProvider[]>(() => {
    const providers: Readonly<Record<DictionaryId, DictionaryProvider>> = {
      'princeton-wordnet-3.1': wordNetProvider,
      'freedict-eng-fra-0.1.6': freeDictProvider,
    };

    return dictionaryPreferences.order.flatMap((id) =>
      dictionaryPreferences.enabled[id] && (id !== 'freedict-eng-fra-0.1.6' || freeDictInstalled)
        ? [providers[id]]
        : [],
    );
  }, [dictionaryPreferences, freeDictInstalled]);

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
    void platform.getAppVersion().then(setAppVersion);
    void platform.isFullscreen().then(setIsFullscreen);

    const syncFullscreenState = () => {
      void platform.isFullscreen().then(setIsFullscreen);
    };

    document.addEventListener('fullscreenchange', syncFullscreenState);
    window.addEventListener('resize', syncFullscreenState);

    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState);
      window.removeEventListener('resize', syncFullscreenState);
    };
  }, [platform]);

  useEffect(() => {
    let isActive = true;

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

    void freeDictProvider
      .status()
      .then((status) => isActive && setFreeDictInstalled(status.installed))
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
    if (activeSection !== 'cards') {
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
  }, [activeSection, cardSearch]);

  const refreshLibrary = useCallback(async () => {
    setLibrary(await loadLibrary());
  }, []);

  const openStoredBook = useCallback(async (entry: LibraryEntry) => {
    try {
      const data = await contentStore.get(entry.book.contentRef);

      if (!data) {
        throw new Error('The local book file is missing.');
      }

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

  const importBook = useCallback(
    async (file: File) => {
      try {
        setStatusMessage(t('importingBook'));
        const format = file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'epub';
        const data = await file.arrayBuffer();
        const hash = await sha256(data);
        const now = new Date().toISOString();
        const title = file.name.replace(/\.(epub|pdf)$/i, '') || file.name;
        const book: BookRecord = {
          id: `book-${hash}`,
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
        await repository().saveBook(book);
        await refreshLibrary();
        setStatusMessage(t('bookSaved'));
        setOpenBook({
          source: { data, name: file.name, format },
          bookId: book.id,
        });
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
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
      void repository()
        .saveProgress({
          id: `progress-${bookId}`,
          bookId,
          locator,
          percentage: normalizeProgress(percentage),
          updatedAt,
          deviceId: deviceId(),
          version: 1,
        })
        .catch((error: unknown) =>
          setStatusMessage(error instanceof Error ? error.message : String(error)),
        );
    },
    [openBook?.bookId],
  );

  const closeReader = useCallback(() => {
    setOpenBook(null);
    void refreshLibrary();
  }, [refreshLibrary]);

  const addWordCard = useCallback(
    async (draft: WordCardDraft) => {
      if (!openBook) {
        throw new Error('A book must be open before saving a word card.');
      }

      const now = new Date().toISOString();
      await repository().saveWordCard({
        id: `card-${crypto.randomUUID()}`,
        ...draft,
        sourceBookId: openBook.bookId ?? null,
        sourceBookTitle: openBook.source.name.replace(/\.(epub|pdf)$/i, ''),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
      });
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

  async function installFreeDict() {
    setIsInstallingDictionary(true);
    setStatusMessage(t('downloadingDictionary'));

    try {
      await freeDictProvider.install();
      setFreeDictInstalled(true);
      setDictionaryPreferences((current) => ({
        ...current,
        enabled: { ...current.enabled, 'freedict-eng-fra-0.1.6': true },
      }));
      setStatusMessage(t('dictionaryInstalled'));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsInstallingDictionary(false);
    }
  }

  async function removeFreeDict() {
    if (!globalThis.confirm(t('removeDictionaryConfirm'))) {
      return;
    }

    try {
      await freeDictProvider.remove();
      setFreeDictInstalled(false);
      setStatusMessage(t('dictionaryRemoved'));
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

  const navigationItems: ReadonlyArray<{
    id: Section;
    label: string;
  }> = [
    { id: 'home', label: t('home') },
    { id: 'library', label: t('library') },
    { id: 'cards', label: t('cards') },
    { id: 'settings', label: t('settings') },
  ];

  if (openBook) {
    return (
      <Suspense fallback={<p className="app-loading">{t('loadingBook')}</p>}>
        <ReaderPage
          key={`${openBook.source.format}:${openBook.source.name}`}
          source={openBook.source}
          initialLocator={openBook.initialLocator}
          locale={locale}
          t={t}
          onClose={closeReader}
          onLocationChange={persistLocation}
          onOpenExternal={(url) => platform.openExternal(url)}
          onAddWordCard={addWordCard}
          dictionaryProviders={dictionaryProviders}
        />
      </Suspense>
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
            onImportBook={importBook}
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
            onDelete={deleteWordCard}
            deletedCard={lastDeletedCard}
            onUndoDelete={undoDeleteWordCard}
          />
        ) : (
          <SettingsPage
            dictionaryPreferences={dictionaryPreferences}
            freeDictInstalled={freeDictInstalled}
            isInstallingDictionary={isInstallingDictionary}
            t={t}
            onToggleDictionary={toggleDictionary}
            onMoveDictionary={moveDictionary}
            onInstallFreeDict={installFreeDict}
            onRemoveFreeDict={removeFreeDict}
            onOpenExternal={(url) => platform.openExternal(url)}
          />
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
  readonly onImportBook: (file: File) => Promise<void>;
  readonly onOpenSample: (source: ReaderSource) => void;
  readonly onOpenStored: (entry: LibraryEntry) => Promise<void>;
}

function LibraryPage({ library, t, onImportBook, onOpenSample, onOpenStored }: LibraryPageProps) {
  function importBook(file: File | undefined) {
    if (!file) {
      return;
    }

    void onImportBook(file);
  }

  return (
    <section className="page" aria-labelledby="library-title">
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
          <span>{t('importBook')}</span>
          <input
            type="file"
            accept=".epub,.pdf,application/epub+zip,application/pdf"
            onChange={(event) => void importBook(event.target.files?.[0])}
          />
        </label>
        <button className="button" type="button" onClick={() => onOpenSample(sampleEpub)}>
          {t('openSampleBook')}
        </button>
      </div>

      {library.length > 0 ? (
        <>
          <div className="section-heading">
            <h2 className="section-title">{t('savedOnDevice')}</h2>
            <span className="section-meta">{library.length}</span>
          </div>
          <div className="book-grid saved-book-grid">
            {library.map((entry) => (
              <StoredBookCard
                key={entry.book.id}
                entry={entry}
                headingLevel={2}
                t={t}
                onOpen={() => void onOpenStored(entry)}
              />
            ))}
          </div>
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
    </section>
  );
}

interface StoredBookCardProps {
  readonly entry: LibraryEntry;
  readonly headingLevel: 2 | 3;
  readonly t: (key: MessageKey) => string;
  readonly onOpen: () => void;
}

function StoredBookCard({ entry, headingLevel, t, onOpen }: StoredBookCardProps) {
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
        <button className="book-action" type="button" onClick={onOpen}>
          {t('openBook')} →
        </button>
      </div>
    </article>
  );
}

interface CardsPageProps {
  readonly cards: readonly WordCardRecord[];
  readonly query: string;
  readonly locale: Locale;
  readonly t: (key: MessageKey) => string;
  readonly onQueryChange: (query: string) => void;
  readonly onDelete: (cardId: string) => Promise<void>;
  readonly deletedCard: WordCardRecord | null;
  readonly onUndoDelete: () => Promise<void>;
}

function CardsPage({
  cards,
  query,
  locale,
  t,
  onQueryChange,
  onDelete,
  deletedCard,
  onUndoDelete,
}: CardsPageProps) {
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
      </header>

      <label className="card-search">
        <span>{t('cardsSearch')}</span>
        <input
          type="search"
          value={query}
          placeholder={t('cardsSearchPlaceholder')}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </label>

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

      {cards.length > 0 ? (
        <div className="word-card-grid">
          {cards.map((card) => (
            <article className="word-card" data-word-card-id={card.id} key={card.id}>
              <div className="word-card-heading">
                <div>
                  <span className="badge">{card.partOfSpeech}</span>
                  <h2>{card.term}</h2>
                </div>
                <button
                  className="word-card-delete"
                  type="button"
                  aria-label={`${t('deleteCard')} ${card.term}`}
                  onClick={() => void onDelete(card.id)}
                >
                  {t('deleteCard')}
                </button>
              </div>
              <p className="word-card-definition">{card.definition}</p>
              <dl className="word-card-metadata">
                <div>
                  <dt>{t('wordRoot')}</dt>
                  <dd>{card.rootOrEtymology ?? t('notProvided')}</dd>
                </div>
                <div>
                  <dt>{t('sourceBook')}</dt>
                  <dd>{card.sourceBookTitle}</dd>
                </div>
                <div>
                  <dt>{t('originalSentence')}</dt>
                  <dd>“{card.sourceSentence}”</dd>
                </div>
                <div>
                  <dt>{t('dictionarySource')}</dt>
                  <dd>{card.dictionarySource}</dd>
                </div>
                <div>
                  <dt>{t('createdAt')}</dt>
                  <dd>
                    {new Intl.DateTimeFormat(locale, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(card.createdAt))}
                  </dd>
                </div>
              </dl>
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
    </section>
  );
}

interface SettingsPageProps {
  readonly dictionaryPreferences: DictionaryPreferences;
  readonly freeDictInstalled: boolean;
  readonly isInstallingDictionary: boolean;
  readonly t: (key: MessageKey) => string;
  readonly onToggleDictionary: (id: DictionaryId, enabled: boolean) => void;
  readonly onMoveDictionary: (id: DictionaryId, direction: -1 | 1) => void;
  readonly onInstallFreeDict: () => Promise<void>;
  readonly onRemoveFreeDict: () => Promise<void>;
  readonly onOpenExternal: (url: string) => Promise<void>;
}

function SettingsPage({
  dictionaryPreferences,
  freeDictInstalled,
  isInstallingDictionary,
  t,
  onToggleDictionary,
  onMoveDictionary,
  onInstallFreeDict,
  onRemoveFreeDict,
  onOpenExternal,
}: SettingsPageProps) {
  const descriptions: Readonly<
    Record<
      DictionaryId,
      {
        readonly name: string;
        readonly languages: string;
        readonly license: string;
        readonly source: string;
        readonly licenseUrl: string;
      }
    >
  > = {
    'princeton-wordnet-3.1': {
      name: 'Princeton WordNet 3.1',
      languages: 'EN → EN',
      license: 'Princeton WordNet License',
      source: 'https://wordnet.princeton.edu/',
      licenseUrl: 'https://wordnet.princeton.edu/license-and-commercial-use',
    },
    'freedict-eng-fra-0.1.6': {
      name: 'FreeDict English–French 0.1.6',
      languages: 'EN → FR',
      license: 'GPL-2.0-or-later',
      source:
        'https://github.com/freedict/fd-dictionaries/tree/5bdceeac8d0dba3298c1bebe734f60d54dad30f7/eng-fra',
      licenseUrl: 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html',
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
          <p className="page-description">{t('dictionarySettingsDescription')}</p>
        </div>
      </header>

      <div className="dictionary-settings-list">
        {dictionaryPreferences.order.map((id, index) => {
          const description = descriptions[id];
          const installed = id === 'princeton-wordnet-3.1' || freeDictInstalled;

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
                <button type="button" onClick={() => void onOpenExternal(description.source)}>
                  {t('source')}
                </button>
                <button type="button" onClick={() => void onOpenExternal(description.licenseUrl)}>
                  {t('license')}
                </button>
                {id === 'freedict-eng-fra-0.1.6' ? (
                  installed ? (
                    <button
                      className="dictionary-remove"
                      type="button"
                      onClick={() => void onRemoveFreeDict()}
                    >
                      {t('removeDictionary')}
                    </button>
                  ) : (
                    <button
                      className="dictionary-install"
                      type="button"
                      disabled={isInstallingDictionary}
                      onClick={() => void onInstallFreeDict()}
                    >
                      {isInstallingDictionary ? t('downloadingDictionary') : t('installDictionary')}
                    </button>
                  )
                ) : null}
              </div>
              {id === 'freedict-eng-fra-0.1.6' && !installed ? (
                <p className="dictionary-download-note">{t('dictionaryDownloadNote')}</p>
              ) : null}
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
