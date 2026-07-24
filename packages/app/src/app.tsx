import { lazy, Suspense, useEffect, useState } from 'react';

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
import type { ReaderSource } from '@lexianchor/reader-core';
import { epubSpikeUrl } from '@lexianchor/test-fixtures';
import '@lexianchor/ui/styles.css';

type Section = 'home' | 'library' | 'cards';
type Theme = 'system' | 'light' | 'dark' | 'eye-care';
type IconName = Section | 'expand' | 'lock' | 'book-open';

export interface AppProps {
  readonly platform: PlatformBridge;
}

const demoRecentBook: RecentBook = {
  id: 'phase-zero-demo',
  title: 'English Learning Notes',
  author: 'LexiAnchor',
  format: 'EPUB',
  progressPercent: 38,
  updatedAt: '2026-07-24T00:00:00.000Z',
};

const localeLabels: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  fr: 'Français',
};

const ReaderPage = lazy(() =>
  import('./reader-page').then((module) => ({ default: module.ReaderPage })),
);

function readStoredLocale(): Locale {
  const stored = globalThis.localStorage?.getItem('lexianchor:locale');
  return supportedLocales.find((locale) => locale === stored) ?? detectSystemLocale();
}

function readStoredTheme(): Theme {
  const stored = globalThis.localStorage?.getItem('lexianchor:theme');
  const themes: readonly Theme[] = ['system', 'light', 'dark', 'eye-care'];
  return themes.find((theme) => theme === stored) ?? 'system';
}

export function App({ platform }: AppProps) {
  const [activeSection, setActiveSection] = useState<Section>('home');
  const [locale, setLocale] = useState<Locale>(readStoredLocale);
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [appVersion, setAppVersion] = useState('0.1.0');
  const [statusMessage, setStatusMessage] = useState('');
  const [openBook, setOpenBook] = useState<ReaderSource | null>(null);
  const t = (key: MessageKey) => translate(locale, key);

  useEffect(() => {
    document.documentElement.lang = locale;
    globalThis.localStorage?.setItem('lexianchor:locale', locale);
  }, [locale]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    globalThis.localStorage?.setItem('lexianchor:theme', theme);
  }, [theme]);

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
  ];

  if (openBook) {
    return (
      <Suspense fallback={<p className="app-loading">{t('loadingBook')}</p>}>
        <ReaderPage source={openBook} t={t} onClose={() => setOpenBook(null)} />
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
          <p className="privacy-copy">{t('privateByDefault')}</p>
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
            onOpenBook={setOpenBook}
          />
        ) : activeSection === 'library' ? (
          <LibraryPage t={t} onOpenBook={setOpenBook} />
        ) : (
          <EmptyPage t={t} />
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
  readonly onOpenBook: (source: ReaderSource) => void;
}

function HomePage({
  appVersion,
  isFullscreen,
  platform,
  t,
  onToggleFullscreen,
  onOpenBook,
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
        <span className="section-meta">{t('sampleData')}</span>
      </div>

      <div className="book-grid">
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
              onClick={() => onOpenBook({ data: epubSpikeUrl, name: 'Anchored Reading.epub' })}
            >
              {t('openBook')} →
            </button>
          </div>
        </article>
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
  readonly t: (key: MessageKey) => string;
  readonly onOpenBook: (source: ReaderSource) => void;
}

function LibraryPage({ t, onOpenBook }: LibraryPageProps) {
  async function importEpub(file: File | undefined) {
    if (!file) {
      return;
    }

    onOpenBook({ data: await file.arrayBuffer(), name: file.name });
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
          <span>{t('importEpub')}</span>
          <input
            type="file"
            accept=".epub,application/epub+zip"
            onChange={(event) => void importEpub(event.target.files?.[0])}
          />
        </label>
        <button
          className="button"
          type="button"
          onClick={() => onOpenBook({ data: epubSpikeUrl, name: 'Anchored Reading.epub' })}
        >
          {t('openSampleBook')}
        </button>
      </div>

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
            <button
              className="book-action"
              type="button"
              onClick={() => onOpenBook({ data: epubSpikeUrl, name: 'Anchored Reading.epub' })}
            >
              {t('openBook')} →
            </button>
          </div>
        </article>
      </div>
    </section>
  );
}

interface EmptyPageProps {
  readonly t: (key: MessageKey) => string;
}

function EmptyPage({ t }: EmptyPageProps) {
  return (
    <section className="page" aria-labelledby="cards-title">
      <header className="page-header">
        <div>
          <p className="eyebrow">LexiAnchor</p>
          <h1 className="page-title" id="cards-title">
            {t('cardsTitle')}
          </h1>
        </div>
      </header>
      <div className="empty-state">
        <div className="empty-icon">
          <Icon name="cards" />
        </div>
        <h2 className="empty-title">{t('cardsEmptyTitle')}</h2>
        <p className="empty-copy">{t('cardsEmptyBody')}</p>
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
