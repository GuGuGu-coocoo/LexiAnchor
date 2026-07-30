import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

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

import { FloatingSelectionTools } from './floating-selection-tools';
import { ReaderAppearancePanel } from './reader-appearance-panel';
import { ReaderFooter } from './reader-footer';
import {
  SelectionTools,
  type OnlineTranslationProvider,
  type WordCardDraft,
} from './selection-tools';
import { persistReaderPreferences, readReaderPreferences } from './reader-preferences';
import { readerColorsForTheme, type Theme } from './theme';
import { useFullscreenToolbar } from './use-fullscreen-toolbar';

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
  readonly onOpenSettings: () => void;
  readonly onThemeChange: (theme: Theme) => void;
  readonly onToggleFullscreen: () => Promise<void>;
  readonly onLocationChange?: (locator: ReaderLocator, percentage: number) => void;
  readonly onOpenExternal: (url: string) => Promise<void>;
  readonly onAddWordCard: (draft: WordCardDraft) => Promise<void>;
  readonly dictionaryProviders: readonly DictionaryProvider[];
  readonly localTranslationProvider: BergamotTranslationProvider;
  readonly installedTranslationTargets: readonly TranslationTargetLanguage[];
  readonly onlineTranslationProvider: OnlineTranslationProvider;
}

function storageKey(scopeId: string): string {
  return `lexianchor:epub-location:${encodeURIComponent(scopeId)}`;
}

function legacyStorageKey(source: ReaderSource): string {
  return `lexianchor:epub-location:${source.name}`;
}

function readLocator(source: ReaderSource, scopeId: string): ReaderLocator | undefined {
  const stored =
    globalThis.localStorage?.getItem(storageKey(scopeId)) ??
    globalThis.localStorage?.getItem(legacyStorageKey(source));

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

interface FlatNavigationItem extends EpubNavigationItem {
  readonly depth: number;
}

function flattenNavigationItems(
  items: readonly EpubNavigationItem[],
  depth = 0,
): FlatNavigationItem[] {
  return items.flatMap((item) => [
    { ...item, depth },
    ...flattenNavigationItems(item.subitems, depth + 1),
  ]);
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
  onOpenSettings,
  onThemeChange,
  onToggleFullscreen,
  onLocationChange,
  onOpenExternal,
  onAddWordCard,
  dictionaryProviders,
  localTranslationProvider,
  installedTranslationTargets,
  onlineTranslationProvider,
}: ReaderPageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const readerStageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<EpubJsReaderEngine | null>(null);
  const isFullscreenRef = useRef(isFullscreen);
  const onToggleFullscreenRef = useRef(onToggleFullscreen);
  const [preferences, setPreferences] = useState<ReaderPreferences>(() => ({
    ...readReaderPreferences(preferenceScopeId),
    ...readerColorsForTheme(theme),
  }));
  const initialPreferencesRef = useRef(preferences);
  const [locator, setLocator] = useState<ReaderLocator>();
  const [tableOfContents, setTableOfContents] = useState<readonly EpubNavigationItem[]>([]);
  const [activeTocHref, setActiveTocHref] = useState('');
  const [isTableOfContentsOpen, setIsTableOfContentsOpen] = useState(false);
  const [linkOrigin, setLinkOrigin] = useState<ReaderLocator | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(!isFullscreen);
  const isSidebarVisible = isSidebarOpen && !isFullscreen;
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const {
    autoHide: autoHideFullscreenToolbar,
    isToolbarVisible,
    revealToolbar,
    scheduleHide,
    setAutoHide: setAutoHideFullscreenToolbar,
  } = useFullscreenToolbar(isFullscreen);

  useEffect(() => {
    isFullscreenRef.current = isFullscreen;
    onToggleFullscreenRef.current = onToggleFullscreen;
  }, [isFullscreen, onToggleFullscreen]);

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
        setActiveTocHref((current) =>
          current && isCurrentHref(current, nextLocator.href) ? current : '',
        );
        globalThis.localStorage?.setItem(
          storageKey(preferenceScopeId),
          JSON.stringify(nextLocator),
        );
        onLocationChange?.(
          nextLocator,
          Math.round((nextLocator.totalProgression ?? nextLocator.progression ?? 0) * 100),
        );
      },
      onSelection: (nextSelection) => {
        if (isActive) {
          setSelection(nextSelection);
        }
      },
      onNavigationCommand: (command) => {
        if (command === 'escape') {
          if (isFullscreenRef.current) {
            void onToggleFullscreenRef.current();
          }
          return;
        }

        if (command === 'fullscreen') {
          void onToggleFullscreenRef.current();
          return;
        }

        const activeEngine = engineRef.current;
        void (command === 'next' ? activeEngine?.next() : activeEngine?.previous());
      },
      onLinkNavigation: (origin) => {
        if (isActive) {
          setLinkOrigin(origin);
        }
      },
      onPaginationReady: () => {
        void engine.getTableOfContents().then((navigation) => {
          if (isActive) {
            setTableOfContents(navigation);
          }
        });
      },
      onError: (readerError) => isActive && setError(readerError.message),
    });
    engineRef.current = engine;
    container.replaceChildren();
    setTableOfContents([]);
    setIsLoading(true);
    setError('');

    void engine
      // The synchronous per-book locator is authoritative on this device.
      // SQLite remains the fallback for restored backups and cleared browser
      // storage, but may lag behind if the desktop process was closed while
      // its final asynchronous write was still in flight.
      .open(container, source, readLocator(source, preferenceScopeId) ?? initialLocator)
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
  }, [initialLocator, onLocationChange, preferenceScopeId, source]);

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
      } else if (!event.repeat && event.key.toLocaleLowerCase('en-US') === 'f') {
        event.preventDefault();
        void onToggleFullscreenRef.current();
      }
    }

    globalThis.addEventListener('keydown', navigateWithKeyboard);
    return () => globalThis.removeEventListener('keydown', navigateWithKeyboard);
  }, []);

  const progress = Math.round((locator?.totalProgression ?? 0) * 100);
  const flatTableOfContents = useMemo(
    () => flattenNavigationItems(tableOfContents),
    [tableOfContents],
  );
  const currentNavigationItem = useMemo(() => {
    const currentProgression = locator?.totalProgression;
    if (currentProgression !== undefined) {
      const positionedItems = flatTableOfContents
        .filter(
          (item) =>
            item.totalProgression !== undefined &&
            item.totalProgression <= currentProgression + 0.000_5,
        )
        .sort((left, right) => (right.totalProgression ?? 0) - (left.totalProgression ?? 0));
      if (positionedItems[0]) {
        return positionedItems[0];
      }
    }

    const preferred = flatTableOfContents.find((item) => item.href === activeTocHref);
    if (preferred) {
      return preferred;
    }

    const exact = flatTableOfContents.find((item) => item.href === locator?.href);
    return exact ?? flatTableOfContents.find((item) => isCurrentHref(item.href, locator?.href));
  }, [activeTocHref, flatTableOfContents, locator?.href, locator?.totalProgression]);

  function prepareForLayoutChange() {
    engineRef.current?.preserveLocationForLayoutChange(locator);
  }

  function toggleSidebar() {
    prepareForLayoutChange();
    setIsSidebarOpen((current) => !current);
  }

  function toggleFullscreenFromReader() {
    prepareForLayoutChange();
    void onToggleFullscreen();
  }

  return (
    <section
      className={`reader-page${isFullscreen ? ' reader-page--fullscreen' : ''}${
        isFullscreen && !isToolbarVisible ? ' reader-page--toolbar-hidden' : ''
      }`}
      style={
        {
          '--selection-font-scale': preferences.selectionFontSizePercent / 100,
        } as CSSProperties
      }
      aria-label={t('readerExperiment')}
    >
      <header
        className="reader-toolbar"
        onPointerEnter={revealToolbar}
        onPointerLeave={() => scheduleHide(700)}
      >
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
        </div>
        <div
          className={`reader-title-group reader-toc-dropdown${
            isTableOfContentsOpen ? ' reader-toc-dropdown--open' : ''
          }`}
        >
          <button
            className="reader-toc-trigger"
            type="button"
            aria-label={t('openTableOfContents')}
            aria-haspopup="menu"
            aria-expanded={isTableOfContentsOpen}
            disabled={isLoading || flatTableOfContents.length === 0}
            onClick={() => {
              setIsTableOfContentsOpen((current) => !current);
              revealToolbar();
            }}
          >
            <span className="reader-title">{currentNavigationItem?.label ?? source.name}</span>
            <span className="reader-title-chevron" aria-hidden="true">
              ▾
            </span>
            <span className="reader-engine-label">
              {source.name} · EPUB.js · {progress}%
            </span>
          </button>
          {isTableOfContentsOpen ? (
            <EpubTableOfContents
              items={flatTableOfContents}
              currentHref={currentNavigationItem?.href}
              emptyLabel={t('noTableOfContents')}
              label={t('tableOfContents')}
              pageLabel={t('page')}
              onNavigate={(href) => {
                setSelection(null);
                setActiveTocHref(href);
                setIsTableOfContentsOpen(false);
                void engineRef.current?.goTo({ href }).catch((navigationError: unknown) => {
                  setError(
                    navigationError instanceof Error
                      ? navigationError.message
                      : String(navigationError),
                  );
                });
              }}
            />
          ) : null}
        </div>
        <div className="reader-toolbar-actions">
          <button
            className="reader-icon-button"
            type="button"
            aria-label={isSidebarVisible ? t('hideReaderSidebar') : t('showReaderSidebar')}
            aria-expanded={isSidebarVisible}
            onClick={toggleSidebar}
          >
            <span aria-hidden="true">◧</span>
            <span>{isSidebarVisible ? t('hideReaderSidebar') : t('showReaderSidebar')}</span>
          </button>
          <button
            className="reader-icon-button reader-toolbar-visibility-button"
            type="button"
            aria-label={
              autoHideFullscreenToolbar
                ? t('keepFullscreenToolbarVisible')
                : t('autoHideFullscreenToolbar')
            }
            aria-pressed={autoHideFullscreenToolbar}
            onClick={() => setAutoHideFullscreenToolbar(!autoHideFullscreenToolbar)}
          >
            <span aria-hidden="true">{autoHideFullscreenToolbar ? '⌃' : '—'}</span>
            <span>
              {autoHideFullscreenToolbar
                ? t('autoHideFullscreenToolbar')
                : t('keepFullscreenToolbarVisible')}
            </span>
          </button>
          <button
            className="reader-icon-button reader-toolbar-settings-button"
            type="button"
            aria-label={t('settings')}
            onClick={onOpenSettings}
          >
            <span aria-hidden="true">⚙</span>
            <span>{t('settings')}</span>
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
        className={`reader-workspace${isSidebarVisible ? '' : ' reader-workspace--sidebar-hidden'}`}
      >
        <aside
          className="reader-settings"
          aria-label={t('readingSettings')}
          hidden={!isSidebarVisible}
        >
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
            onlineTranslationProvider={onlineTranslationProvider}
          />
          <label className="reader-toggle reader-fullscreen-toolbar-setting">
            <span>
              <strong>{t('autoHideFullscreenToolbar')}</strong>
              <small>{t('autoHideFullscreenToolbarDescription')}</small>
            </span>
            <input
              type="checkbox"
              checked={autoHideFullscreenToolbar}
              onChange={(event) => setAutoHideFullscreenToolbar(event.target.checked)}
            />
          </label>
          <ReaderAppearancePanel
            preferences={preferences}
            theme={theme}
            t={t}
            onApplyPreferences={setPreferences}
            onThemeChange={onThemeChange}
          />
        </aside>

        <div ref={readerStageRef} className="reader-stage">
          {isLoading ? <p className="reader-status">{t('loadingBook')}</p> : null}
          {error ? (
            <div className="reader-error" role="alert">
              <strong>{t('readerError')}</strong>
              <span>{error}</span>
            </div>
          ) : null}
          <div
            ref={containerRef}
            className={`epub-container${isLoading ? ' epub-container--loading' : ''}`}
            data-testid="epub-container"
            aria-busy={isLoading}
          />
          {!isLoading ? (
            <ReaderFooter
              currentPage={locator?.totalPageNumber ?? locator?.pageNumber}
              totalPages={locator?.totalPageCount ?? locator?.pageCount}
              pagesRemaining={locator?.chapterPagesRemaining}
              backLabel={
                linkOrigin
                  ? `${t('backToPage')} ${
                      linkOrigin.totalPageNumber ?? linkOrigin.pageNumber ?? '—'
                    }`
                  : undefined
              }
              pagesRemainingLabel={t('pagesLeftInChapter')}
              ofLabel={t('of')}
              onBack={
                linkOrigin
                  ? () => {
                      const origin = linkOrigin;
                      setLinkOrigin(null);
                      void engineRef.current?.goTo(origin);
                    }
                  : undefined
              }
            />
          ) : null}
        </div>
        {selection && !isSidebarVisible ? (
          <FloatingSelectionTools
            selection={selection}
            popoverWidth={preferences.selectionPopoverWidthPx}
            popoverHeight={preferences.selectionPopoverHeightPx}
            locale={locale}
            t={t}
            onDismiss={() => setSelection(null)}
            onOpenExternal={onOpenExternal}
            onAddWordCard={onAddWordCard}
            providers={dictionaryProviders}
            localTranslationProvider={localTranslationProvider}
            installedTranslationTargets={installedTranslationTargets}
            onlineTranslationProvider={onlineTranslationProvider}
          />
        ) : null}
      </div>
    </section>
  );
}

interface EpubTableOfContentsProps {
  readonly items: readonly FlatNavigationItem[];
  readonly currentHref: string | undefined;
  readonly emptyLabel: string;
  readonly label: string;
  readonly pageLabel: string;
  readonly onNavigate: (href: string) => void;
}

function EpubTableOfContents({
  items,
  currentHref,
  emptyLabel,
  label,
  pageLabel,
  onNavigate,
}: EpubTableOfContentsProps) {
  const currentRowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const row = currentRowRef.current;
      const navigation = row?.closest<HTMLElement>('.reader-toc');
      if (row && navigation) {
        const naturalTop =
          row.getBoundingClientRect().top -
          navigation.getBoundingClientRect().top +
          navigation.scrollTop;
        navigation.scrollTop = naturalTop;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [currentHref, items]);

  if (items.length === 0) {
    return <p className="reader-toc-empty">{emptyLabel}</p>;
  }

  const currentItem = items.find((item) => item.href === currentHref);

  return (
    <nav className="reader-toc" aria-label={label}>
      <ol>
        {items.map((item) => (
          <li
            key={`${item.id}:${item.href}`}
            ref={item === currentItem ? currentRowRef : undefined}
            className={item === currentItem ? 'reader-toc-current-row' : undefined}
          >
            <button
              type="button"
              aria-current={item === currentItem ? 'location' : undefined}
              style={{ '--reader-toc-depth': item.depth } as CSSProperties}
              onClick={() => onNavigate(item.href)}
            >
              <span>{item.label}</span>
              {item.pageNumber ? (
                <span className="reader-toc-page">
                  {pageLabel} {item.pageNumber}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
