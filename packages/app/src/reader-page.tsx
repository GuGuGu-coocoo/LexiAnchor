import { lazy, Suspense, useEffect, useRef, useState } from 'react';

import {
  type ReaderLocator,
  type ReaderPreferences,
  type ReaderSelection,
  type ReaderSource,
} from '@lexianchor/reader-core';
import { EpubJsReaderEngine, type EpubNavigationItem } from '@lexianchor/reader-epub';
import type { Locale, MessageKey } from '@lexianchor/i18n';
import type { DictionaryProvider } from '@lexianchor/dictionary';
import type {
  BergamotTranslationProvider,
  TranslationTargetLanguage,
} from '@lexianchor/translation';

import { SelectionTools, type WordCardDraft } from './selection-tools';
import { persistReaderPreferences, readReaderPreferences } from './reader-preferences';
import { readerColorsForTheme, type Theme } from './theme';

const PdfReaderPage = lazy(async () => {
  const module = await import('./pdf-reader-page');
  return { default: module.PdfReaderPage };
});

interface ReaderPageProps {
  readonly source: ReaderSource;
  readonly preferenceScopeId: string;
  readonly initialLocator?: ReaderLocator;
  readonly theme: Theme;
  readonly isFullscreen: boolean;
  readonly locale: Locale;
  readonly t: (key: MessageKey) => string;
  readonly onClose: () => void;
  readonly onThemeChange: (theme: Theme) => void;
  readonly onToggleFullscreen: () => Promise<void>;
  readonly onLocationChange?: (locator: ReaderLocator, percentage: number) => void;
  readonly onOpenExternal: (url: string) => Promise<void>;
  readonly onAddWordCard: (draft: WordCardDraft) => Promise<void>;
  readonly dictionaryProviders: readonly DictionaryProvider[];
  readonly localTranslationProvider: BergamotTranslationProvider;
  readonly installedTranslationTargets: readonly TranslationTargetLanguage[];
}

function storageKey(source: ReaderSource): string {
  return `lexianchor:epub-location:${source.name}`;
}

function readLocator(source: ReaderSource): ReaderLocator | undefined {
  const stored = globalThis.localStorage?.getItem(storageKey(source));

  if (!stored) {
    return undefined;
  }

  try {
    return JSON.parse(stored) as ReaderLocator;
  } catch {
    return undefined;
  }
}

function normalizedHref(href: string | undefined): string {
  return (href ?? '').split('#')[0]?.replace(/^\.?\//, '') ?? '';
}

function isCurrentHref(candidate: string, current: string | undefined): boolean {
  const candidatePath = normalizedHref(candidate);
  const currentPath = normalizedHref(current);

  if (!candidatePath || !currentPath) {
    return false;
  }

  return (
    candidatePath === currentPath ||
    candidatePath.endsWith(`/${currentPath}`) ||
    currentPath.endsWith(`/${candidatePath}`)
  );
}

function isEditableKeyTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return (
    element?.isContentEditable === true ||
    element?.tagName === 'INPUT' ||
    element?.tagName === 'SELECT' ||
    element?.tagName === 'TEXTAREA'
  );
}

export function ReaderPage(props: ReaderPageProps) {
  if (props.source.format === 'pdf') {
    return (
      <Suspense fallback={<p className="app-loading">{props.t('loadingBook')}</p>}>
        <PdfReaderPage {...props} />
      </Suspense>
    );
  }

  return <EpubReaderPage {...props} />;
}

function EpubReaderPage({
  source,
  preferenceScopeId,
  initialLocator,
  theme,
  isFullscreen,
  locale,
  t,
  onClose,
  onThemeChange,
  onToggleFullscreen,
  onLocationChange,
  onOpenExternal,
  onAddWordCard,
  dictionaryProviders,
  localTranslationProvider,
  installedTranslationTargets,
}: ReaderPageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<EpubJsReaderEngine | null>(null);
  const [preferences, setPreferences] = useState<ReaderPreferences>(() => ({
    ...readReaderPreferences(preferenceScopeId),
    ...readerColorsForTheme(theme),
  }));
  const initialPreferencesRef = useRef(preferences);
  const [locator, setLocator] = useState<ReaderLocator>();
  const [tableOfContents, setTableOfContents] = useState<readonly EpubNavigationItem[]>([]);
  const [sidePanel, setSidePanel] = useState<'contents' | 'settings'>('settings');
  const [isSidebarOpen, setIsSidebarOpen] = useState(!isFullscreen);
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    let isActive = true;
    const engine = new EpubJsReaderEngine({
      onLocationChange: (nextLocator) => {
        if (!isActive) {
          return;
        }

        setLocator(nextLocator);
        globalThis.localStorage?.setItem(storageKey(source), JSON.stringify(nextLocator));
        onLocationChange?.(
          nextLocator,
          Math.round((nextLocator.totalProgression ?? nextLocator.progression ?? 0) * 100),
        );
      },
      onSelection: (nextSelection) => {
        if (isActive) {
          setSelection(nextSelection);

          if (nextSelection) {
            setSidePanel('settings');
          }
        }
      },
      onNavigationCommand: (command) => {
        const activeEngine = engineRef.current;
        void (command === 'next' ? activeEngine?.next() : activeEngine?.previous());
      },
      onError: (readerError) => isActive && setError(readerError.message),
    });
    engineRef.current = engine;
    container.replaceChildren();
    setTableOfContents([]);
    setSidePanel('settings');
    setIsLoading(true);
    setError('');

    void engine
      .open(container, source, initialLocator ?? readLocator(source))
      .then(async () => {
        await engine.setPreferences(initialPreferencesRef.current);
        const navigation = await engine.getTableOfContents().catch(() => []);

        if (isActive) {
          setTableOfContents(navigation);
        }
      })
      .then(() => isActive && setIsLoading(false))
      .catch(() => isActive && setIsLoading(false));

    return () => {
      isActive = false;
      engineRef.current = null;
      void engine.close();
    };
  }, [initialLocator, onLocationChange, source]);

  useEffect(() => {
    void engineRef.current
      ?.setPreferences(preferences)
      .catch((preferenceError: unknown) =>
        setError(
          preferenceError instanceof Error ? preferenceError.message : String(preferenceError),
        ),
      );
  }, [preferences]);

  useEffect(() => {
    persistReaderPreferences(preferenceScopeId, preferences);
  }, [preferenceScopeId, preferences]);

  useEffect(() => {
    function navigateWithKeyboard(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isEditableKeyTarget(event.target)
      ) {
        return;
      }

      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        void engineRef.current?.next();
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        void engineRef.current?.previous();
      }
    }

    globalThis.addEventListener('keydown', navigateWithKeyboard);
    return () => globalThis.removeEventListener('keydown', navigateWithKeyboard);
  }, []);

  const progress = Math.round((locator?.totalProgression ?? 0) * 100);

  function updatePreference<Key extends keyof ReaderPreferences>(
    key: Key,
    value: ReaderPreferences[Key],
  ) {
    setPreferences((current) => ({ ...current, [key]: value }));
  }

  function updateTheme(nextTheme: Theme) {
    onThemeChange(nextTheme);
    setPreferences((current) => ({ ...current, ...readerColorsForTheme(nextTheme) }));
  }

  function toggleFullscreenFromReader() {
    if (!isFullscreen) {
      setIsSidebarOpen(false);
    }

    void onToggleFullscreen();
  }

  return (
    <section className="reader-page" aria-label={t('readerExperiment')}>
      <header className="reader-toolbar">
        <div className="reader-toolbar-leading">
          <button
            className="reader-icon-button"
            type="button"
            aria-label={t('backToLibrary')}
            onClick={onClose}
          >
            <span aria-hidden="true">←</span>
            <span>{t('backToLibrary')}</span>
          </button>
          <button
            className="reader-icon-button"
            type="button"
            aria-label={t('openTableOfContents')}
            disabled={isLoading || tableOfContents.length === 0}
            onClick={() => {
              setSidePanel('contents');
              setIsSidebarOpen(true);
            }}
          >
            <span aria-hidden="true">☰</span>
            <span>{t('tableOfContents')}</span>
          </button>
        </div>
        <div className="reader-title-group">
          <p className="reader-title">{source.name}</p>
          <p className="reader-engine-label">EPUB.js · {progress}%</p>
        </div>
        <div className="reader-toolbar-actions">
          <button
            className="reader-icon-button"
            type="button"
            aria-label={isSidebarOpen ? t('hideReaderSidebar') : t('showReaderSidebar')}
            aria-expanded={isSidebarOpen}
            onClick={() => setIsSidebarOpen((current) => !current)}
          >
            <span aria-hidden="true">◧</span>
            <span>{isSidebarOpen ? t('hideReaderSidebar') : t('showReaderSidebar')}</span>
          </button>
          <button
            className="reader-icon-button"
            type="button"
            aria-label={isFullscreen ? t('exitFullscreen') : t('fullscreen')}
            onClick={toggleFullscreenFromReader}
          >
            <span aria-hidden="true">⛶</span>
            <span>{isFullscreen ? t('exitFullscreen') : t('fullscreen')}</span>
          </button>
          <button
            className="reader-icon-button"
            type="button"
            aria-label={t('previousPage')}
            onClick={() => void engineRef.current?.previous()}
          >
            <span aria-hidden="true">←</span>
            <span>{t('previousPage')}</span>
          </button>
          <button
            className="reader-icon-button"
            type="button"
            aria-label={t('nextPage')}
            onClick={() => void engineRef.current?.next()}
          >
            <span>{t('nextPage')}</span>
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </header>

      <div
        className={`reader-workspace${isSidebarOpen ? '' : ' reader-workspace--sidebar-hidden'}`}
      >
        <aside
          className="reader-settings"
          aria-label={t('readingSettings')}
          hidden={!isSidebarOpen}
        >
          <div className="reader-panel-switch" aria-label={t('readerSidebar')}>
            <button
              type="button"
              aria-pressed={sidePanel === 'contents'}
              onClick={() => setSidePanel('contents')}
            >
              {t('tableOfContents')}
            </button>
            <button
              type="button"
              aria-pressed={sidePanel === 'settings'}
              onClick={() => setSidePanel('settings')}
            >
              {t('readingSettings')}
            </button>
          </div>

          {sidePanel === 'contents' ? (
            <EpubTableOfContents
              items={tableOfContents}
              currentHref={locator?.href}
              emptyLabel={t('noTableOfContents')}
              label={t('tableOfContents')}
              onNavigate={(href) => {
                setSelection(null);
                void engineRef.current?.goTo({ href }).catch((navigationError: unknown) => {
                  setError(
                    navigationError instanceof Error
                      ? navigationError.message
                      : String(navigationError),
                  );
                });
              }}
            />
          ) : (
            <>
              <div className="reader-setting-group">
                <p className="reader-setting-title">{t('readerExperiment')}</p>
                <p className="reader-setting-copy">{t('readerExperimentBody')}</p>
              </div>

              <label className="reader-control">
                <span>{t('appearance')}</span>
                <select
                  value={theme}
                  onChange={(event) => updateTheme(event.target.value as Theme)}
                >
                  <option value="system">{t('systemTheme')}</option>
                  <option value="light">{t('lightTheme')}</option>
                  <option value="dark">{t('darkTheme')}</option>
                  <option value="eye-care">{t('eyeCareTheme')}</option>
                </select>
              </label>

              <label className="reader-toggle">
                <span>
                  <strong>{t('focusMode')}</strong>
                  <small>{t('focusModeDescription')}</small>
                </span>
                <input
                  type="checkbox"
                  checked={preferences.focusMode}
                  onChange={(event) => updatePreference('focusMode', event.target.checked)}
                />
              </label>

              <label className="reader-control">
                <span>{t('focusStrength')}</span>
                <select
                  value={preferences.focusStrength}
                  onChange={(event) =>
                    updatePreference(
                      'focusStrength',
                      event.target.value as ReaderPreferences['focusStrength'],
                    )
                  }
                >
                  <option value="light">{t('lightStrength')}</option>
                  <option value="medium">{t('mediumStrength')}</option>
                  <option value="strong">{t('strongStrength')}</option>
                </select>
              </label>

              <label className="reader-control">
                <span>{t('readingLayout')}</span>
                <select
                  value={preferences.flow}
                  onChange={(event) =>
                    updatePreference('flow', event.target.value as ReaderPreferences['flow'])
                  }
                >
                  <option value="paginated">{t('pageMode')}</option>
                  <option value="scrolled">{t('scrollMode')}</option>
                </select>
              </label>

              <label className="reader-control">
                <span>{t('fontFamily')}</span>
                <select
                  value={preferences.fontFamily}
                  onChange={(event) =>
                    updatePreference(
                      'fontFamily',
                      event.target.value as ReaderPreferences['fontFamily'],
                    )
                  }
                >
                  <option value="serif">{t('serifFont')}</option>
                  <option value="sans-serif">{t('sansSerifFont')}</option>
                </select>
              </label>

              <label className="reader-control">
                <span>
                  {t('fontSize')} <output>{preferences.fontSizePercent}%</output>
                </span>
                <input
                  type="range"
                  aria-label={t('fontSize')}
                  min="80"
                  max="180"
                  step="5"
                  value={preferences.fontSizePercent}
                  onChange={(event) =>
                    updatePreference('fontSizePercent', Number(event.target.value))
                  }
                />
              </label>

              <label className="reader-control">
                <span>
                  {t('fontWeight')} <output>{preferences.fontWeight}</output>
                </span>
                <input
                  type="range"
                  aria-label={t('fontWeight')}
                  min="350"
                  max="700"
                  step="50"
                  value={preferences.fontWeight}
                  onChange={(event) => updatePreference('fontWeight', Number(event.target.value))}
                />
              </label>

              <label className="reader-control">
                <span>
                  {t('lineHeight')} <output>{preferences.lineHeight.toFixed(2)}</output>
                </span>
                <input
                  type="range"
                  aria-label={t('lineHeight')}
                  min="1.2"
                  max="2.2"
                  step="0.05"
                  value={preferences.lineHeight}
                  onChange={(event) => updatePreference('lineHeight', Number(event.target.value))}
                />
              </label>

              <label className="reader-control">
                <span>
                  {t('letterSpacing')} <output>{preferences.letterSpacingEm.toFixed(2)} em</output>
                </span>
                <input
                  type="range"
                  aria-label={t('letterSpacing')}
                  min="0"
                  max="0.15"
                  step="0.01"
                  value={preferences.letterSpacingEm}
                  onChange={(event) =>
                    updatePreference('letterSpacingEm', Number(event.target.value))
                  }
                />
              </label>

              <label className="reader-control">
                <span>
                  {t('contentWidth')} <output>{preferences.contentWidthPercent}%</output>
                </span>
                <input
                  type="range"
                  aria-label={t('contentWidth')}
                  min="55"
                  max="100"
                  step="5"
                  value={preferences.contentWidthPercent}
                  onChange={(event) =>
                    updatePreference('contentWidthPercent', Number(event.target.value))
                  }
                />
              </label>

              <label className="reader-control">
                <span>{t('textAlignment')}</span>
                <select
                  value={preferences.textAlignment}
                  onChange={(event) =>
                    updatePreference(
                      'textAlignment',
                      event.target.value as ReaderPreferences['textAlignment'],
                    )
                  }
                >
                  <option value="start">{t('alignLeft')}</option>
                  <option value="justify">{t('justifyText')}</option>
                </select>
              </label>

              <label className="reader-control">
                <span>
                  {t('wordSpacing')} <output>{preferences.wordSpacingEm.toFixed(2)} em</output>
                </span>
                <input
                  type="range"
                  aria-label={t('wordSpacing')}
                  min="0"
                  max="0.5"
                  step="0.05"
                  value={preferences.wordSpacingEm}
                  onChange={(event) =>
                    updatePreference('wordSpacingEm', Number(event.target.value))
                  }
                />
              </label>

              <SelectionTools
                key={selection?.text ?? 'empty'}
                selection={selection}
                emptyHint={t('selectionHint')}
                locale={locale}
                t={t}
                onOpenExternal={onOpenExternal}
                onAddWordCard={onAddWordCard}
                providers={dictionaryProviders}
                localTranslationProvider={localTranslationProvider}
                installedTranslationTargets={installedTranslationTargets}
              />
            </>
          )}
        </aside>

        <div className="reader-stage">
          {isLoading ? <p className="reader-status">{t('loadingBook')}</p> : null}
          {error ? (
            <div className="reader-error" role="alert">
              <strong>{t('readerError')}</strong>
              <span>{error}</span>
            </div>
          ) : null}
          <div ref={containerRef} className="epub-container" data-testid="epub-container" />
        </div>
      </div>
    </section>
  );
}

interface EpubTableOfContentsProps {
  readonly items: readonly EpubNavigationItem[];
  readonly currentHref: string | undefined;
  readonly emptyLabel: string;
  readonly label: string;
  readonly onNavigate: (href: string) => void;
}

function EpubTableOfContents({
  items,
  currentHref,
  emptyLabel,
  label,
  onNavigate,
}: EpubTableOfContentsProps) {
  if (items.length === 0) {
    return <p className="reader-toc-empty">{emptyLabel}</p>;
  }

  return (
    <nav className="reader-toc" aria-label={label}>
      <EpubTableOfContentsList items={items} currentHref={currentHref} onNavigate={onNavigate} />
    </nav>
  );
}

function EpubTableOfContentsList({
  items,
  currentHref,
  onNavigate,
}: Pick<EpubTableOfContentsProps, 'items' | 'currentHref' | 'onNavigate'>) {
  return (
    <ol>
      {items.map((item) => (
        <li key={`${item.id}:${item.href}`}>
          <button
            type="button"
            aria-current={isCurrentHref(item.href, currentHref) ? 'location' : undefined}
            onClick={() => onNavigate(item.href)}
          >
            {item.label}
          </button>
          {item.subitems.length > 0 ? (
            <EpubTableOfContentsList
              items={item.subitems}
              currentHref={currentHref}
              onNavigate={onNavigate}
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}
