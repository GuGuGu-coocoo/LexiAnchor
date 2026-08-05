import { useEffect, useRef, useState, type CSSProperties } from 'react';

import type { Locale, MessageKey } from '@lexianchor/i18n';
import type { DictionaryProvider } from '@lexianchor/dictionary';
import type {
  ReaderFlow,
  ReaderLocator,
  ReaderSelection,
  ReaderSource,
} from '@lexianchor/reader-core';
import type {
  BergamotTranslationProvider,
  TranslationTargetLanguage,
} from '@lexianchor/translation';
import {
  PdfJsReaderEngine,
  type PdfDocumentInfo,
  type PdfPageResult,
} from '@lexianchor/reader-pdf';

import { FloatingSelectionTools } from './floating-selection-tools';
import { persistReaderPreferences, readReaderPreferences } from './reader-preferences';
import { ReaderFooter } from './reader-footer';
import {
  SelectionTools,
  type OnlineTranslationProvider,
  type WordCardDraft,
} from './selection-tools';
import type { Theme } from './theme';
import { useHorizontalPageSwipe } from './use-horizontal-page-swipe';
import { useFullscreenToolbar } from './use-fullscreen-toolbar';

interface PdfReaderPageProps {
  readonly source: ReaderSource;
  readonly preferenceScopeId: string;
  readonly initialLocator?: ReaderLocator;
  readonly theme: Theme;
  readonly isFullscreen: boolean;
  readonly locale: Locale;
  readonly t: (key: MessageKey) => string;
  readonly onClose: () => void;
  readonly onOpenWordCards: () => void;
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

interface StoredPdfView {
  readonly pageNumber: number;
  readonly scale: number;
  readonly flow: ReaderFlow;
}

function storageKey(scopeId: string): string {
  return `lexianchor:pdf-view:${encodeURIComponent(scopeId)}`;
}

function legacyStorageKey(source: ReaderSource): string {
  return `lexianchor:pdf-view:${source.name}`;
}

function readStoredView(
  source: ReaderSource,
  scopeId: string,
  initialLocator?: ReaderLocator,
): StoredPdfView {
  const stored =
    globalThis.localStorage?.getItem(storageKey(scopeId)) ??
    globalThis.localStorage?.getItem(legacyStorageKey(source));

  if (!stored) {
    return { pageNumber: initialLocator?.pageNumber ?? 1, scale: 1.15, flow: 'paginated' };
  }

  try {
    const view = JSON.parse(stored) as Partial<StoredPdfView>;
    return {
      pageNumber: Math.max(1, Math.floor(view.pageNumber ?? initialLocator?.pageNumber ?? 1)),
      scale: Math.min(2, Math.max(0.75, view.scale ?? 1.15)),
      flow: view.flow === 'scrolled' ? 'scrolled' : 'paginated',
    };
  } catch {
    return { pageNumber: initialLocator?.pageNumber ?? 1, scale: 1.15, flow: 'paginated' };
  }
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

export function PdfReaderPage({
  source,
  preferenceScopeId,
  initialLocator,
  theme,
  isFullscreen,
  locale,
  t,
  onClose,
  onOpenWordCards,
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
}: PdfReaderPageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const readerStageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PdfJsReaderEngine | null>(null);
  const pendingScrollPageRef = useRef<number | null>(null);
  const openExternalRef = useRef(onOpenExternal);
  const [initialView] = useState(() => readStoredView(source, preferenceScopeId, initialLocator));
  const pageNumberRef = useRef(initialView.pageNumber);
  const [documentInfo, setDocumentInfo] = useState<PdfDocumentInfo>();
  const [pageResult, setPageResult] = useState<PdfPageResult>();
  const [continuousPages, setContinuousPages] = useState<readonly PdfPageResult[]>([]);
  const [pageNumber, setPageNumber] = useState(initialView.pageNumber);
  const [scale, setScale] = useState(initialView.scale);
  const [flow, setFlow] = useState<ReaderFlow>(initialView.flow);
  const [linkOriginPage, setLinkOriginPage] = useState<number | null>(null);
  const [selectionPreferences, setSelectionPreferences] = useState(() => {
    const preferences = readReaderPreferences(preferenceScopeId);
    return {
      fontSizePercent: preferences.selectionFontSizePercent,
      popoverWidthPx: preferences.selectionPopoverWidthPx,
      popoverHeightPx: preferences.selectionPopoverHeightPx,
    };
  });
  const [isSidebarOpen, setIsSidebarOpen] = useState(!isFullscreen);
  const wasFullscreenRef = useRef(isFullscreen);
  const sidebarBeforeFullscreenRef = useRef(isSidebarOpen);
  const isSidebarVisible = isSidebarOpen;
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
    openExternalRef.current = onOpenExternal;
  }, [onOpenExternal]);

  useEffect(() => {
    const wasFullscreen = wasFullscreenRef.current;
    wasFullscreenRef.current = isFullscreen;

    if (!wasFullscreen && isFullscreen) {
      setIsSidebarOpen((current) => {
        sidebarBeforeFullscreenRef.current = current;
        return false;
      });
    } else if (wasFullscreen && !isFullscreen) {
      setIsSidebarOpen(sidebarBeforeFullscreenRef.current);
    }
  }, [isFullscreen]);

  useEffect(() => {
    pageNumberRef.current = pageNumber;
  }, [pageNumber]);

  useEffect(() => {
    persistReaderPreferences(preferenceScopeId, {
      ...readReaderPreferences(preferenceScopeId),
      selectionFontSizePercent: selectionPreferences.fontSizePercent,
      selectionPopoverWidthPx: selectionPreferences.popoverWidthPx,
      selectionPopoverHeightPx: selectionPreferences.popoverHeightPx,
    });
  }, [preferenceScopeId, selectionPreferences]);

  useEffect(() => {
    let isActive = true;
    const engine = new PdfJsReaderEngine({
      onSelection: (nextSelection) => isActive && setSelection(nextSelection),
      onExternalLink: async (url) => {
        try {
          await openExternalRef.current(url);
        } catch (linkError) {
          if (isActive) {
            setError(linkError instanceof Error ? linkError.message : String(linkError));
          }
        }
      },
      onInternalLink: (nextPageNumber) => {
        if (isActive) {
          if (pageNumberRef.current !== nextPageNumber) {
            setLinkOriginPage(pageNumberRef.current);
          }
          pendingScrollPageRef.current = nextPageNumber;
          setPageNumber(nextPageNumber);
        }
      },
      onError: (readerError) => isActive && setError(readerError.message),
    });
    engineRef.current = engine;

    void engine
      .open(source)
      .then((info) => {
        if (!isActive) {
          return;
        }

        setDocumentInfo(info);
        setPageNumber((current) => Math.min(current, info.pageCount));
      })
      .catch(() => isActive && setIsLoading(false));

    return () => {
      isActive = false;
      engineRef.current = null;
      void engine.close();
    };
  }, [source]);

  useEffect(() => {
    const container = containerRef.current;
    const engine = engineRef.current;

    if (!container || !engine || !documentInfo || flow !== 'paginated') {
      return;
    }

    let isActive = true;
    setContinuousPages([]);

    void engine
      .renderPage(container, pageNumber, scale)
      .then((result) => {
        if (!isActive) {
          return;
        }

        setPageResult(result);
        setPageNumber(result.pageNumber);
        setIsLoading(false);
      })
      .catch((renderError: unknown) => {
        if (
          !isActive ||
          (renderError instanceof Error && renderError.name === 'RenderingCancelledException')
        ) {
          return;
        }

        setError(renderError instanceof Error ? renderError.message : String(renderError));
        setIsLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, [documentInfo, flow, pageNumber, scale]);

  useEffect(() => {
    const container = containerRef.current;
    const engine = engineRef.current;

    if (!container || !engine || !documentInfo || flow !== 'scrolled') {
      return;
    }

    let isActive = true;
    setIsLoading(true);

    void engine
      .renderDocument(container, scale)
      .then((result) => {
        if (!isActive) {
          return;
        }

        setContinuousPages(result.pages);
        setPageResult(result.pages[pageNumberRef.current - 1] ?? result.pages[0]);
        setIsLoading(false);
      })
      .catch((renderError: unknown) => {
        if (
          !isActive ||
          (renderError instanceof Error && renderError.name === 'RenderingCancelledException')
        ) {
          return;
        }

        setError(renderError instanceof Error ? renderError.message : String(renderError));
        setIsLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, [documentInfo, flow, scale]);

  const pageCount = documentInfo?.pageCount ?? 0;
  const progress = pageCount > 0 ? Math.round((pageNumber / pageCount) * 100) : 0;
  const hasText = pageResult?.hasText ?? true;

  useEffect(() => {
    if (pageCount === 0) {
      return;
    }

    globalThis.localStorage?.setItem(
      storageKey(preferenceScopeId),
      JSON.stringify({ pageNumber, scale, flow }),
    );
    onLocationChange?.(
      {
        href: source.name,
        pageNumber,
        progression: pageNumber / pageCount,
        totalProgression: pageNumber / pageCount,
      },
      Math.round((pageNumber / pageCount) * 100),
    );
  }, [flow, onLocationChange, pageCount, pageNumber, preferenceScopeId, scale, source.name]);

  useEffect(() => {
    const stage = readerStageRef.current;
    const container = containerRef.current;

    if (!stage || !container || flow !== 'scrolled' || continuousPages.length === 0) {
      return;
    }

    let frame: number | null = null;
    const updateVisiblePage = () => {
      frame = null;
      const stageRect = stage.getBoundingClientRect();
      const readingLine = stageRect.top + Math.min(stageRect.height * 0.34, 240);
      const pendingPage = pendingScrollPageRef.current;

      if (pendingPage !== null) {
        const pendingElement = container.querySelector<HTMLElement>(
          `.pdf-page[data-page-number="${pendingPage}"]`,
        );
        const pendingDistance = pendingElement
          ? Math.abs(pendingElement.getBoundingClientRect().top - readingLine)
          : Number.POSITIVE_INFINITY;

        if (pendingDistance > stageRect.height * 0.48) {
          return;
        }
        pendingScrollPageRef.current = null;
      }

      let closestPage = pageNumber;
      let closestDistance = Number.POSITIVE_INFINITY;

      for (const page of container.querySelectorAll<HTMLElement>('.pdf-page')) {
        const pageTop = page.getBoundingClientRect().top;
        const distance = Math.abs(pageTop - readingLine);

        if (distance < closestDistance) {
          closestDistance = distance;
          closestPage = Number(page.dataset.pageNumber) || closestPage;
        }
      }

      setPageNumber((current) => (current === closestPage ? current : closestPage));
      setPageResult(continuousPages[closestPage - 1]);
    };
    const scheduleUpdate = () => {
      if (frame === null) {
        frame = requestAnimationFrame(updateVisiblePage);
      }
    };

    stage.addEventListener('scroll', scheduleUpdate, { passive: true });
    scheduleUpdate();
    return () => {
      stage.removeEventListener('scroll', scheduleUpdate);
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [continuousPages, flow, pageNumber]);

  useEffect(() => {
    if (
      flow !== 'scrolled' ||
      pendingScrollPageRef.current !== pageNumber ||
      continuousPages.length === 0
    ) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector<HTMLElement>(`.pdf-page[data-page-number="${pageNumber}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [continuousPages, flow, pageNumber]);

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

      const direction =
        event.key === 'ArrowRight' || event.key === 'PageDown'
          ? 1
          : event.key === 'ArrowLeft' || event.key === 'PageUp'
            ? -1
            : 0;
      if (!event.repeat && event.key.toLocaleLowerCase('en-US') === 'f') {
        event.preventDefault();
        void onToggleFullscreen();
        return;
      }
      if (direction === 0) {
        return;
      }

      event.preventDefault();
      setPageNumber((current) => {
        const next = Math.max(1, Math.min(pageCount, current + direction));
        pendingScrollPageRef.current = next;
        return next;
      });
    }

    globalThis.addEventListener('keydown', navigateWithKeyboard);
    return () => globalThis.removeEventListener('keydown', navigateWithKeyboard);
  }, [isFullscreen, onToggleFullscreen, pageCount]);

  useHorizontalPageSwipe(readerStageRef, containerRef, {
    enabled: flow === 'paginated' && pageCount > 0,
    onNext: () => setPageNumber((current) => Math.min(pageCount, current + 1)),
    onPrevious: () => setPageNumber((current) => Math.max(1, current - 1)),
  });

  function goToPage(nextPageNumber: number) {
    const next = Math.max(1, Math.min(pageCount || 1, nextPageNumber));
    pendingScrollPageRef.current = next;
    setPageNumber(next);
  }

  function toggleFullscreenFromReader() {
    void onToggleFullscreen();
  }

  return (
    <section
      className={`reader-page${isFullscreen ? ' reader-page--fullscreen' : ''}${
        isFullscreen && !isToolbarVisible ? ' reader-page--toolbar-hidden' : ''
      }`}
      style={
        {
          '--selection-font-scale': selectionPreferences.fontSizePercent / 100,
        } as CSSProperties
      }
      aria-label={t('pdfReader')}
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
          <button
            className="reader-icon-button reader-toolbar-cards-button"
            type="button"
            aria-label={t('openWordCards')}
            onClick={onOpenWordCards}
          >
            <span aria-hidden="true">▤</span>
            <span>{t('openWordCards')}</span>
          </button>
        </div>
        <div className="reader-title-group">
          <p className="reader-title">{source.name}</p>
          <p className="reader-engine-label">
            PDF.js · {t('page')} {pageNumber} {t('of')} {pageCount || '—'} · {progress}%
          </p>
        </div>
        <div className="reader-toolbar-actions">
          <button
            className="reader-icon-button"
            type="button"
            aria-label={isSidebarVisible ? t('hideReaderSidebar') : t('showReaderSidebar')}
            aria-expanded={isSidebarVisible}
            onClick={() => setIsSidebarOpen((current) => !current)}
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
            disabled={pageNumber <= 1}
            onClick={() => goToPage(pageNumber - 1)}
          >
            <span aria-hidden="true">←</span>
            <span>{t('previousPage')}</span>
          </button>
          <button
            className="reader-icon-button"
            type="button"
            aria-label={t('nextPage')}
            disabled={pageCount === 0 || pageNumber >= pageCount}
            onClick={() => goToPage(pageNumber + 1)}
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
            emptyHint={hasText ? t('pdfSelectionHint') : t('imageOnlyDescription')}
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

          <div className="reader-setting-group">
            <p className="reader-setting-title">{t('pdfReader')}</p>
            <p className="reader-setting-copy">{t('pdfReaderDescription')}</p>
          </div>

          <label className="reader-control">
            <span>{t('appearance')}</span>
            <select value={theme} onChange={(event) => onThemeChange(event.target.value as Theme)}>
              <option value="system">{t('systemTheme')}</option>
              <option value="light">{t('lightTheme')}</option>
              <option value="dark">{t('darkTheme')}</option>
              <option value="eye-care">{t('eyeCareTheme')}</option>
            </select>
          </label>

          <label className="reader-control">
            <span>
              {t('selectionFontSize')} <output>{selectionPreferences.fontSizePercent}%</output>
            </span>
            <input
              type="range"
              aria-label={t('selectionFontSize')}
              min="80"
              max="160"
              step="5"
              value={selectionPreferences.fontSizePercent}
              onChange={(event) =>
                setSelectionPreferences((current) => ({
                  ...current,
                  fontSizePercent: Number(event.target.value),
                }))
              }
            />
          </label>

          <label className="reader-control">
            <span>
              {t('selectionPopoverWidth')} <output>{selectionPreferences.popoverWidthPx} px</output>
            </span>
            <input
              type="range"
              aria-label={t('selectionPopoverWidth')}
              min="300"
              max="620"
              step="10"
              value={selectionPreferences.popoverWidthPx}
              onChange={(event) =>
                setSelectionPreferences((current) => ({
                  ...current,
                  popoverWidthPx: Number(event.target.value),
                }))
              }
            />
          </label>

          <label className="reader-control">
            <span>
              {t('selectionPopoverHeight')}{' '}
              <output>{selectionPreferences.popoverHeightPx} px</output>
            </span>
            <input
              type="range"
              aria-label={t('selectionPopoverHeight')}
              min="260"
              max="720"
              step="10"
              value={selectionPreferences.popoverHeightPx}
              onChange={(event) =>
                setSelectionPreferences((current) => ({
                  ...current,
                  popoverHeightPx: Number(event.target.value),
                }))
              }
            />
          </label>

          <label className="reader-control">
            <span>{t('readingLayout')}</span>
            <select
              value={flow}
              onChange={(event) => {
                const nextFlow = event.target.value as ReaderFlow;
                pendingScrollPageRef.current =
                  nextFlow === 'scrolled' && pageNumber > 1 ? pageNumber : null;
                setSelection(null);
                setIsLoading(true);
                setFlow(nextFlow);
              }}
            >
              <option value="paginated">{t('pageMode')}</option>
              <option value="scrolled">{t('scrollMode')}</option>
            </select>
          </label>

          <label className="reader-control">
            <span>
              {t('zoom')} <output>{Math.round(scale * 100)}%</output>
            </span>
            <input
              type="range"
              aria-label={t('zoom')}
              min="0.75"
              max="2"
              step="0.05"
              value={scale}
              onChange={(event) => setScale(Number(event.target.value))}
            />
          </label>

          <div className="pdf-page-jump">
            <label htmlFor="pdf-page-number">{t('page')}</label>
            <input
              id="pdf-page-number"
              type="number"
              min="1"
              max={pageCount || 1}
              value={pageNumber}
              onChange={(event) => goToPage(Number(event.target.value) || 1)}
            />
            <span>
              {t('of')} {pageCount || '—'}
            </span>
          </div>

          {!hasText ? (
            <div className="pdf-capability-note" role="status">
              <strong>{t('imageOnlyPdf')}</strong>
              <span>{t('imageOnlyDescription')}</span>
            </div>
          ) : null}
        </aside>

        <div ref={readerStageRef} className="reader-stage pdf-reader-stage">
          {isLoading ? <p className="reader-status">{t('loadingBook')}</p> : null}
          {error ? (
            <div className="reader-error" role="alert">
              <strong>{t('readerError')}</strong>
              <span>{error}</span>
            </div>
          ) : null}
          <div ref={containerRef} className="pdf-document-container" data-testid="pdf-container" />
          {!isLoading ? (
            <ReaderFooter
              currentPage={pageNumber}
              totalPages={pageCount || undefined}
              pagesRemaining={pageCount > 0 ? Math.max(0, pageCount - pageNumber) : undefined}
              backLabel={
                linkOriginPage === null ? undefined : `${t('backToPage')} ${linkOriginPage}`
              }
              pagesRemainingLabel={t('pagesLeftInDocument')}
              ofLabel={t('of')}
              onBack={
                linkOriginPage === null
                  ? undefined
                  : () => {
                      const origin = linkOriginPage;
                      setLinkOriginPage(null);
                      goToPage(origin);
                    }
              }
            />
          ) : null}
        </div>
        {selection && !isSidebarVisible ? (
          <FloatingSelectionTools
            selection={selection}
            popoverWidth={selectionPreferences.popoverWidthPx}
            popoverHeight={selectionPreferences.popoverHeightPx}
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
