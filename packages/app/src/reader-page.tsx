import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

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
import {
  checkpointTimestamp,
  CommittedReadingCheckpoint,
  latestReadingCheckpoint,
  type PersistedReadingCheckpoint,
} from './committed-reading-checkpoint';
import { epubPageCount } from './epub-page-count';
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
    const parsed: unknown = JSON.parse(stored);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ReaderLocator)
      : undefined;
  } catch {
    return undefined;
  }
}

function layoutSignature(preferences: ReaderPreferences): string {
  return JSON.stringify({
    flow: preferences.flow,
    pageSpread: preferences.pageSpread,
    fontSizePercent: preferences.fontSizePercent,
    lineHeight: preferences.lineHeight,
    wordSpacingEm: preferences.wordSpacingEm,
    letterSpacingEm: preferences.letterSpacingEm,
    fontFamily: preferences.fontFamily,
    customFontFamily: preferences.customFontFamily,
    fontWeight: preferences.fontWeight,
    contentWidthPercent: preferences.contentWidthPercent,
    textAlignment: preferences.textAlignment,
    focusMode: preferences.focusMode,
    focusStrength: preferences.focusStrength,
  });
}

function resumeLocator(stored: ReaderLocator | undefined): ReaderLocator | undefined {
  // An EPUB CFI describes a content position, not a pixel coordinate. It is
  // still the best checkpoint after font, spacing, sidebar, or window-size
  // changes. Falling back to navigationHref discarded the exact page and
  // repeatedly reopened books at the beginning of their current chapter.
  return stored;
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
}: ReaderPageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const readerStageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<EpubJsReaderEngine | null>(null);
  const engineReadyRef = useRef(false);
  const isClosingRef = useRef(false);
  const checkpointRef = useRef(new CommittedReadingCheckpoint());
  const checkpointTimestampRef = useRef(0);
  const isFullscreenRef = useRef(isFullscreen);
  const onToggleFullscreenRef = useRef(onToggleFullscreen);
  const [preferences, setPreferences] = useState<ReaderPreferences>(() => ({
    ...readReaderPreferences(preferenceScopeId),
    ...readerColorsForTheme(theme),
  }));
  const initialPreferencesRef = useRef(preferences);
  const appliedLayoutSignatureRef = useRef(layoutSignature(preferences));
  const layoutPreferenceRevisionRef = useRef(0);
  const layoutPersistencePendingRef = useRef(false);
  const currentNavigationItemRef = useRef<FlatNavigationItem | undefined>(undefined);
  const resumeNavigationRef = useRef<{ href: string; cfi?: string } | undefined>(undefined);
  const activeTocHrefRef = useRef('');
  const explicitTocHrefRef = useRef('');
  const committedTocHrefRef = useRef('');
  const committedNavigationRef = useRef<{ href: string; cfi?: string } | undefined>(undefined);
  const navigationPendingRef = useRef(false);
  const navigationRevisionRef = useRef(0);
  const locatorLayoutSignatureRef = useRef(layoutSignature(preferences));
  const onLocationChangeRef = useRef(onLocationChange);
  const locatorRef = useRef<ReaderLocator | undefined>(undefined);
  const [locator, setLocator] = useState<ReaderLocator>();
  const [locatorLayoutSignature, setLocatorLayoutSignature] = useState(
    layoutSignature(preferences),
  );
  const [tableOfContents, setTableOfContents] = useState<readonly EpubNavigationItem[]>([]);
  const [isPaginationReady, setIsPaginationReady] = useState(false);
  const [activeTocHref, setActiveTocHref] = useState('');
  const [isTableOfContentsOpen, setIsTableOfContentsOpen] = useState(false);
  const [linkOrigin, setLinkOrigin] = useState<ReaderLocator | null>(null);
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
    isFullscreenRef.current = isFullscreen;
    onToggleFullscreenRef.current = onToggleFullscreen;
    onLocationChangeRef.current = onLocationChange;
  }, [isFullscreen, onLocationChange, onToggleFullscreen]);

  const updateActiveTocHref = useCallback((href: string, explicit = true) => {
    activeTocHrefRef.current = href;
    explicitTocHrefRef.current = explicit ? href : '';
    setActiveTocHref(href);
  }, []);

  const clearNavigationTarget = useCallback(() => {
    navigationRevisionRef.current += 1;
    navigationPendingRef.current = false;
    resumeNavigationRef.current = undefined;
    updateActiveTocHref('');
  }, [updateActiveTocHref]);

  const savePageCheckpoint = useCallback(
    (nextLocator: ReaderLocator, enrich = false) => {
      if (isClosingRef.current || !engineReadyRef.current) {
        return;
      }
      const metadata = {
        explicitTocHref: explicitTocHrefRef.current,
        layoutSignature: locatorLayoutSignatureRef.current,
        navigationHref: resumeNavigationRef.current?.href,
        navigationCfi: resumeNavigationRef.current?.cfi,
      };
      const checkpoint = enrich
        ? checkpointRef.current.enrich(nextLocator, metadata)
        : checkpointRef.current.commit(nextLocator, metadata);
      if (!checkpoint) {
        return;
      }
      if (!enrich) {
        committedTocHrefRef.current = metadata.explicitTocHref;
      }
      committedNavigationRef.current = metadata.navigationHref
        ? { href: metadata.navigationHref, cfi: metadata.navigationCfi }
        : undefined;
      const persistedCheckpoint: PersistedReadingCheckpoint = {
        ...checkpoint,
        checkpointUpdatedAt: Math.max(Date.now(), checkpointTimestampRef.current + 1),
      };
      checkpointTimestampRef.current = persistedCheckpoint.checkpointUpdatedAt;
      // Both stores receive exactly the same commit clock. Never compare the
      // SQLite RPC completion time with an earlier localStorage write time.
      globalThis.localStorage?.setItem(
        storageKey(preferenceScopeId),
        JSON.stringify(persistedCheckpoint),
      );
      onLocationChangeRef.current?.(
        persistedCheckpoint,
        Math.round((nextLocator.totalProgression ?? nextLocator.progression ?? 0) * 100),
      );
    },
    [preferenceScopeId],
  );

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
    const container = containerRef.current;

    if (!container) {
      return;
    }

    let isActive = true;
    navigationRevisionRef.current += 1;
    navigationPendingRef.current = false;
    committedTocHrefRef.current = '';
    committedNavigationRef.current = undefined;
    isClosingRef.current = false;
    checkpointRef.current = new CommittedReadingCheckpoint();
    const engine = new EpubJsReaderEngine({
      onLocationChange: (nextLocator) => {
        if (!isActive || isClosingRef.current) {
          return;
        }

        if (
          activeTocHrefRef.current &&
          !isCurrentHref(activeTocHrefRef.current, nextLocator.href)
        ) {
          clearNavigationTarget();
        }
        // Enqueue the committed checkpoint before React schedules a render.
        // Durability still requires one store to finish writing; a process
        // kill before both writes persist cannot guarantee the latest page.
        locatorRef.current = nextLocator;
        savePageCheckpoint(nextLocator);
        setLocator(nextLocator);
      },
      onSelection: (nextSelection) => {
        if (isActive && !isClosingRef.current) {
          setSelection(nextSelection);
        }
      },
      onNavigationCommand: (command) => {
        if (!isActive || isClosingRef.current) {
          return;
        }
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
        clearNavigationTarget();
        void (command === 'next' ? activeEngine?.next() : activeEngine?.previous());
      },
      onPageInteractionStart: () => {
        if (isActive && !isClosingRef.current && navigationPendingRef.current) {
          navigationRevisionRef.current += 1;
          navigationPendingRef.current = false;
          resumeNavigationRef.current = committedNavigationRef.current;
          updateActiveTocHref(
            committedTocHrefRef.current || committedNavigationRef.current?.href || '',
            Boolean(committedTocHrefRef.current),
          );
        }
      },
      onPageInteraction: () => {
        if (isActive && !isClosingRef.current) {
          clearNavigationTarget();
        }
      },
      onLinkNavigation: (origin) => {
        if (isActive && !isClosingRef.current) {
          const navigation = resumeNavigationRef.current ?? currentNavigationItemRef.current;
          const returnOrigin = {
            ...origin,
            navigationHref: navigation?.href,
            navigationCfi: navigation?.cfi,
          };
          clearNavigationTarget();
          setLinkOrigin(returnOrigin);
        }
      },
      onPaginationReady: () => {
        if (!isCurrentSession()) return;
        void engine.getTableOfContents().then((navigation) => {
          if (isCurrentSession()) {
            setTableOfContents(navigation);
            setIsPaginationReady(true);
          }
        });
      },
      onError: (readerError) => isActive && !isClosingRef.current && setError(readerError.message),
    });
    const isCurrentSession = () =>
      isActive && !isClosingRef.current && engineRef.current === engine;
    engineRef.current = engine;
    engineReadyRef.current = false;
    container.replaceChildren();
    setTableOfContents([]);
    setIsPaginationReady(false);
    locatorRef.current = undefined;
    setLocator(undefined);
    updateActiveTocHref('');
    setIsLoading(true);
    setError('');
    const storedLocator = latestReadingCheckpoint(
      readLocator(source, preferenceScopeId),
      initialLocator,
    );
    checkpointTimestampRef.current = checkpointTimestamp(storedLocator);
    const explicitStoredNavigationHref =
      storedLocator &&
      storedLocator.cfi === undefined &&
      storedLocator.navigationHref === storedLocator.href
        ? storedLocator.navigationHref
        : undefined;
    const openingLocator = resumeLocator(storedLocator);
    const openingLayoutSignature = layoutSignature(initialPreferencesRef.current);
    locatorLayoutSignatureRef.current = openingLayoutSignature;
    setLocatorLayoutSignature(openingLayoutSignature);
    updateActiveTocHref(
      explicitStoredNavigationHref ?? storedLocator?.navigationHref ?? '',
      Boolean(explicitStoredNavigationHref),
    );
    resumeNavigationRef.current = storedLocator?.navigationHref
      ? {
          href: storedLocator.navigationHref,
          cfi: storedLocator.navigationCfi,
        }
      : undefined;

    void engine
      // Use the newest stamped commit across both stores. localStorage can
      // lag after a process kill, while SQLite can lag during an in-flight RPC.
      // Unstamped legacy records retain the existing local-first fallback.
      .open(container, source, openingLocator)
      .then(async () => {
        if (!isCurrentSession()) return;
        await engine.setPreferences(initialPreferencesRef.current);
        if (!isCurrentSession()) return;
        // Applying typography repaginates the freshly opened section. Re-apply
        // the saved destination after that first layout pass. Otherwise the
        // intermediate CFI reported under EPUB.js' default typography becomes
        // the new checkpoint and can move many pages within a long chapter.
        const postLayoutTarget = explicitStoredNavigationHref
          ? {
              href: explicitStoredNavigationHref,
              cfi: storedLocator?.navigationCfi,
            }
          : openingLocator;
        if (postLayoutTarget) {
          await engine.goTo(postLayoutTarget);
          if (!isCurrentSession()) return;
        }
        const navigation = await engine.getTableOfContents().catch(() => []);

        if (isCurrentSession()) {
          setTableOfContents(navigation);
          engineReadyRef.current = true;
          if (locatorRef.current) {
            savePageCheckpoint(locatorRef.current);
          }
        }
      })
      .then(() => isCurrentSession() && setIsLoading(false))
      .catch(() => isCurrentSession() && setIsLoading(false));

    return () => {
      isActive = false;
      navigationRevisionRef.current += 1;
      navigationPendingRef.current = false;
      isClosingRef.current = true;
      checkpointRef.current.freeze();
      engineRef.current = null;
      engineReadyRef.current = false;
      void engine.close();
    };
  }, [
    clearNavigationTarget,
    initialLocator,
    preferenceScopeId,
    savePageCheckpoint,
    source,
    updateActiveTocHref,
  ]);

  useEffect(() => {
    if (!engineReadyRef.current) {
      return;
    }

    const nextLayoutSignature = layoutSignature(preferences);
    const isLayoutChange = nextLayoutSignature !== appliedLayoutSignatureRef.current;
    if (navigationPendingRef.current) {
      // A preferences operation supersedes display(). Do not stamp its old
      // content checkpoint with a target that has not finished navigating.
      clearNavigationTarget();
      engineRef.current?.preserveLocationForLayoutChange(locatorRef.current);
    }
    const navigationItem = currentNavigationItemRef.current ?? resumeNavigationRef.current;
    const explicitTocHref = navigationPendingRef.current ? '' : explicitTocHrefRef.current;
    const exactLayoutAnchor = explicitTocHref
      ? {
          href: explicitTocHref,
          cfi: navigationItem?.cfi,
        }
      : locatorRef.current;
    const engine = engineRef.current;
    const revision = ++layoutPreferenceRevisionRef.current;
    if (isLayoutChange) {
      layoutPersistencePendingRef.current = true;
      if (exactLayoutAnchor) {
        engine?.preserveLocationForLayoutChange(exactLayoutAnchor);
      }
      appliedLayoutSignatureRef.current = nextLayoutSignature;
    }

    void engine
      ?.setPreferences(preferences)
      .then(() => {
        if (
          !isLayoutChange ||
          isClosingRef.current ||
          revision !== layoutPreferenceRevisionRef.current ||
          engine !== engineRef.current
        ) {
          return;
        }
        locatorLayoutSignatureRef.current = nextLayoutSignature;
        setLocatorLayoutSignature(nextLayoutSignature);
        layoutPersistencePendingRef.current = false;
      })
      .catch((preferenceError: unknown) => {
        if (
          isClosingRef.current ||
          revision !== layoutPreferenceRevisionRef.current ||
          engine !== engineRef.current
        ) {
          return;
        }
        layoutPersistencePendingRef.current = false;
        setError(
          preferenceError instanceof Error ? preferenceError.message : String(preferenceError),
        );
      });
  }, [clearNavigationTarget, preferences]);

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
        clearNavigationTarget();
        void engineRef.current?.next();
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        clearNavigationTarget();
        void engineRef.current?.previous();
      } else if (!event.repeat && event.key.toLocaleLowerCase('en-US') === 'f') {
        event.preventDefault();
        void onToggleFullscreenRef.current();
      }
    }

    globalThis.addEventListener('keydown', navigateWithKeyboard);
    return () => globalThis.removeEventListener('keydown', navigateWithKeyboard);
  }, [clearNavigationTarget]);

  const progress = Math.round((locator?.totalProgression ?? 0) * 100);
  const chapterPages = epubPageCount(locator, preferences);
  const flatTableOfContents = useMemo(
    () => flattenNavigationItems(tableOfContents),
    [tableOfContents],
  );
  const currentNavigationItem = useMemo(() => {
    const preferred = flatTableOfContents.find((item) => item.href === activeTocHref);
    if (preferred && isCurrentHref(preferred.href, locator?.href)) {
      return preferred;
    }

    const exact = flatTableOfContents.find((item) => item.href === locator?.href);
    const sameDocumentItems = flatTableOfContents.filter((item) =>
      isCurrentHref(item.href, locator?.href),
    );
    const currentProgression = locator?.totalProgression;
    if (currentProgression !== undefined) {
      const positionedItems = sameDocumentItems
        .filter(
          (item) =>
            item.totalProgression !== undefined &&
            item.totalProgression > 0 &&
            item.totalProgression <= currentProgression + 0.000_5,
        )
        .sort((left, right) => (right.totalProgression ?? 0) - (left.totalProgression ?? 0));
      if (positionedItems[0]) {
        return positionedItems[0];
      }
    }

    return exact ?? sameDocumentItems[0];
  }, [activeTocHref, flatTableOfContents, locator?.href, locator?.totalProgression]);

  useEffect(() => {
    currentNavigationItemRef.current = currentNavigationItem;
  }, [currentNavigationItem]);

  useEffect(() => {
    if (
      !locator ||
      locatorRef.current !== locator ||
      !engineReadyRef.current ||
      isClosingRef.current ||
      navigationPendingRef.current ||
      layoutPersistencePendingRef.current
    ) {
      return;
    }

    if (
      currentNavigationItem &&
      (isPaginationReady ||
        activeTocHref === currentNavigationItem.href ||
        !resumeNavigationRef.current)
    ) {
      resumeNavigationRef.current = {
        href: currentNavigationItem.href,
        cfi: currentNavigationItem.cfi,
      };
    }

    // Only enrich the same engine commit. A delayed render must not replace
    // a page that already reached the synchronous checkpoint callback.
    savePageCheckpoint(locator, true);
  }, [
    activeTocHref,
    currentNavigationItem,
    isPaginationReady,
    locator,
    locatorLayoutSignature,
    savePageCheckpoint,
  ]);

  function closeToLibrary() {
    if (isClosingRef.current) {
      return;
    }
    isClosingRef.current = true;
    navigationRevisionRef.current += 1;
    navigationPendingRef.current = false;
    engineRef.current?.freezeLocation();
    checkpointRef.current.freeze();
    onClose();
  }

  function prepareForLayoutChange() {
    if (navigationPendingRef.current) {
      clearNavigationTarget();
    }
    const navigationItem = currentNavigationItemRef.current ?? resumeNavigationRef.current;
    const exactLayoutAnchor =
      !navigationPendingRef.current && explicitTocHrefRef.current
        ? {
            href: explicitTocHrefRef.current,
            cfi: navigationItem?.cfi,
          }
        : locatorRef.current;
    engineRef.current?.preserveLocationForLayoutChange(exactLayoutAnchor);
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
            onClick={closeToLibrary}
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
              pageLabel={t('readingPosition')}
              onNavigate={(item) => {
                const engine = engineRef.current;
                if (!engine || !engineReadyRef.current || isClosingRef.current) {
                  return;
                }
                const previousTocHref = committedTocHrefRef.current;
                const previousNavigation = committedNavigationRef.current;
                const revision = ++navigationRevisionRef.current;
                navigationPendingRef.current = true;
                setSelection(null);
                updateActiveTocHref(item.href);
                resumeNavigationRef.current = {
                  href: item.href,
                  cfi: item.cfi,
                };
                setIsTableOfContentsOpen(false);
                void engine
                  .goTo({ href: item.href, cfi: item.cfi })
                  .then(() => {
                    if (
                      isClosingRef.current ||
                      revision !== navigationRevisionRef.current ||
                      engine !== engineRef.current
                    ) {
                      return;
                    }
                    navigationPendingRef.current = false;
                    if (locatorRef.current && !layoutPersistencePendingRef.current) {
                      savePageCheckpoint(locatorRef.current, true);
                    }
                  })
                  .catch((navigationError: unknown) => {
                    if (
                      isClosingRef.current ||
                      revision !== navigationRevisionRef.current ||
                      engine !== engineRef.current
                    ) {
                      return;
                    }
                    navigationPendingRef.current = false;
                    resumeNavigationRef.current = previousNavigation;
                    updateActiveTocHref(
                      previousTocHref || previousNavigation?.href || '',
                      Boolean(previousTocHref),
                    );
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
            onClick={() => {
              clearNavigationTarget();
              void engineRef.current?.previous();
            }}
          >
            <span aria-hidden="true">←</span>
            <span>{t('previousPage')}</span>
          </button>
          <button
            className="reader-icon-button"
            type="button"
            aria-label={t('nextPage')}
            onClick={() => {
              clearNavigationTarget();
              void engineRef.current?.next();
            }}
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
              pageLabel={t('chapterPage')}
              currentPage={chapterPages.current}
              totalPages={chapterPages.total}
              pagesRemaining={chapterPages.remaining}
              backLabel={
                linkOrigin
                  ? `${t('backToPage')} ${epubPageCount(linkOrigin, preferences).current ?? '—'}`
                  : undefined
              }
              pagesRemainingLabel={t('pagesLeftInChapter')}
              ofLabel={t('of')}
              onBack={
                linkOrigin
                  ? () => {
                      const origin = linkOrigin;
                      setLinkOrigin(null);
                      clearNavigationTarget();
                      if (origin.navigationHref) {
                        resumeNavigationRef.current = {
                          href: origin.navigationHref,
                          cfi: origin.navigationCfi,
                        };
                        // Restore the publisher label, not its anchor as the
                        // destination: Back must retain the exact link CFI.
                        updateActiveTocHref(origin.navigationHref, false);
                      }
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
  readonly onNavigate: (item: FlatNavigationItem) => void;
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
              onClick={() => onNavigate(item)}
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
