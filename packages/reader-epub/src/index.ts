import ePub, { type Book, type Contents, type NavItem, type Rendition } from 'epubjs';

import type {
  ReaderCallbacks,
  ReaderEngine,
  ReaderLocator,
  ReaderPreferences,
  ReaderSelection,
  ReaderSource,
} from '@lexianchor/reader-core';
import {
  createHorizontalPageScrollGesture,
  createStackedPageScrollGesture,
  type HorizontalPageGestureController,
} from '@lexianchor/reader-core';

import { applyFocusMarkup, removeFocusMarkup } from './focus-markup';

interface EpubLocation {
  readonly start: {
    readonly cfi: string;
    readonly href: string;
    readonly percentage?: number;
    readonly displayed?: {
      readonly page: number;
      readonly total: number;
    };
  };
}

interface ContinuousManagerRuntime {
  readonly container?: HTMLElement;
  readonly layout?: {
    readonly delta?: number;
  };
}

type ContinuousRendition = Omit<Rendition, 'resize'> & {
  readonly manager?: ContinuousManagerRuntime;
  resize(width: number, height: number, epubCfi?: string): void;
};

export interface EpubNavigationItem {
  readonly id: string;
  readonly href: string;
  readonly label: string;
  readonly pageNumber?: number;
  readonly subitems: readonly EpubNavigationItem[];
}

function navigationItems(
  items: readonly NavItem[],
  pageNumberForHref: (href: string) => number | undefined,
): EpubNavigationItem[] {
  return items.map((item) => ({
    id: item.id,
    href: item.href,
    label: item.label.trim() || item.href,
    pageNumber: pageNumberForHref(item.href),
    subitems: navigationItems(item.subitems ?? [], pageNumberForHref),
  }));
}

function handleNavigationKey(
  event: KeyboardEvent,
  onCommand: ReaderCallbacks['onNavigationCommand'],
): void {
  const element = event.target as HTMLElement | null;
  const tagName = element?.tagName;

  if (!event.defaultPrevented && event.key === 'Escape') {
    event.preventDefault();
    onCommand?.('escape');
    return;
  }

  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    element?.isContentEditable ||
    tagName === 'INPUT' ||
    tagName === 'SELECT' ||
    tagName === 'TEXTAREA'
  ) {
    return;
  }

  if (event.key === 'ArrowRight' || event.key === 'PageDown') {
    event.preventDefault();
    onCommand?.('next');
  } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
    event.preventDefault();
    onCommand?.('previous');
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function refersToSameDocument(left: string, right: string): boolean {
  const leftDocument = left.split('#', 1)[0] ?? left;
  const rightDocument = right.split('#', 1)[0] ?? right;

  return (
    leftDocument === rightDocument ||
    leftDocument.endsWith(`/${rightDocument}`) ||
    rightDocument.endsWith(`/${leftDocument}`)
  );
}

function selectionFrom(contents: Contents, cfiRange: string): ReaderSelection | null {
  const liveSelection = contents.window.getSelection();
  const range =
    liveSelection && liveSelection.rangeCount > 0
      ? liveSelection.getRangeAt(0)
      : contents.range(cfiRange);
  const text = range?.toString().trim() ?? '';

  if (!range || !text) {
    return null;
  }

  const parent =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  const sentence =
    parent?.closest('p,li,blockquote,figcaption,dd,dt')?.textContent?.replace(/\s+/g, ' ').trim() ??
    text;
  const selectionRect = range.getBoundingClientRect();
  const frameRect = contents.document.defaultView?.frameElement?.getBoundingClientRect();
  const anchorRect = frameRect
    ? {
        left: frameRect.left + selectionRect.left,
        top: frameRect.top + selectionRect.top,
        right: frameRect.left + selectionRect.right,
        bottom: frameRect.top + selectionRect.bottom,
      }
    : undefined;

  return { text, sentence, cfiRange, anchorRect };
}

function fontFamilyValue(preferences: ReaderPreferences): string {
  if (preferences.fontFamily === 'system') {
    return "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  }
  if (preferences.fontFamily === 'sans-serif') {
    return "Arial, Helvetica, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  }
  if (preferences.fontFamily === 'custom') {
    const family = preferences.customFontFamily.replace(/[\\"'\n\r]/g, '').trim();
    return family
      ? `"${family}", -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
      : "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  }

  return "Georgia, 'Times New Roman', serif";
}

export class EpubJsReaderEngine implements ReaderEngine {
  readonly id = 'epubjs';
  readonly label = 'EPUB.js 0.3.93';

  private book: Book | null = null;
  private rendition: ContinuousRendition | null = null;
  private preferences: ReaderPreferences | null = null;
  private currentLocator: ReaderLocator | null = null;
  private requestedLocator: ReaderLocator | null = null;
  private preferenceUpdate = 0;
  private interactionRevision = 0;
  private pageGesture: HorizontalPageGestureController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeFrame: number | null = null;
  private resizeSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private layoutAnchor: ReaderLocator | null = null;
  private layoutRevision = 0;
  private observedSize = '';

  constructor(private readonly callbacks: ReaderCallbacks) {}

  async open(
    container: HTMLElement,
    source: ReaderSource,
    initialLocator?: ReaderLocator,
  ): Promise<void> {
    await this.close();

    try {
      this.book = ePub(source.data);
      this.rendition = this.book.renderTo(container, {
        width: '100%',
        height: '100%',
        manager: 'continuous',
        flow: 'paginated',
        spread: 'none',
        snap: false,
        ignoreClass: 'lexianchor-focus',
        allowScriptedContent: false,
      });

      const gestureOptions = {
        getScroller: () => this.rendition?.manager?.container ?? null,
        getPageExtent: () =>
          this.rendition?.manager?.layout?.delta ??
          this.rendition?.manager?.container?.clientWidth ??
          1,
        isEnabled: () => this.preferences?.flow === 'paginated',
        onSettled: () => {
          this.callbacks.onSelection(null);
          void this.rendition?.reportLocation();
        },
      };
      const slidingGesture = createHorizontalPageScrollGesture({
        ...gestureOptions,
        isEnabled: () =>
          this.preferences?.flow === 'paginated' && this.preferences.pageTurnEffect === 'slide',
      });
      const stackedGesture = createStackedPageScrollGesture({
        ...gestureOptions,
        isEnabled: () =>
          this.preferences?.flow === 'paginated' && this.preferences.pageTurnEffect === 'stack',
      });
      this.pageGesture = {
        handleWheel: (event) => {
          slidingGesture.handleWheel(event);
          stackedGesture.handleWheel(event);
        },
        dispose: () => {
          slidingGesture.dispose();
          stackedGesture.dispose();
        },
      };
      this.resizeObserver = new ResizeObserver((entries) => {
        const size = entries[0]?.contentRect;
        const sizeKey = size ? `${Math.round(size.width)}x${Math.round(size.height)}` : '';

        if (!sizeKey || sizeKey === this.observedSize) {
          return;
        }

        this.observedSize = sizeKey;
        const width = Math.round(size?.width ?? container.clientWidth);
        const height = Math.round(size?.height ?? container.clientHeight);
        if (this.resizeFrame !== null) {
          cancelAnimationFrame(this.resizeFrame);
        }
        this.resizeFrame = requestAnimationFrame(() => {
          this.resizeFrame = null;
          const rendition = this.rendition;
          if (!rendition) {
            return;
          }

          const anchor = this.requestedLocator ?? this.layoutAnchor ?? this.currentLocator;
          const anchorTarget = anchor?.cfi ?? anchor?.href;
          const revision = ++this.layoutRevision;
          this.layoutAnchor = anchor ?? null;
          rendition.resize(width, height, anchorTarget);

          if (this.resizeSettleTimer !== null) {
            clearTimeout(this.resizeSettleTimer);
          }
          this.resizeSettleTimer = setTimeout(() => {
            this.resizeSettleTimer = null;
            void this.restoreLayoutAnchor(revision, anchorTarget);
          }, 60);
        });
      });
      this.resizeObserver.observe(container);

      this.rendition.hooks.content.register((contents: Contents) => {
        if (this.preferences?.focusMode) {
          applyFocusMarkup(contents.document, this.preferences.focusStrength);
        }

        contents.document.addEventListener('keydown', (event) =>
          handleNavigationKey(event, this.callbacks.onNavigationCommand),
        );
        contents.document.addEventListener('wheel', this.handleWheelNavigation, {
          passive: false,
        });
        contents.on('linkClicked', () => {
          if (this.currentLocator) {
            this.callbacks.onLinkNavigation?.(this.currentLocator);
          }
        });
      });

      this.rendition.on('relocated', (location: EpubLocation) => {
        const displayed = location.start.displayed;
        const progression =
          location.start.percentage ??
          (displayed && displayed.total > 0 ? displayed.page / displayed.total : undefined);

        const totalProgression = this.book?.locations.percentageFromCfi(location.start.cfi);
        const totalPageCount = this.book?.locations.length() ?? 0;
        const rawTotalLocation = this.book?.locations.locationFromCfi(
          location.start.cfi,
        ) as unknown;
        const totalLocation = typeof rawTotalLocation === 'number' ? rawTotalLocation : -1;

        const nextLocator = {
          href: location.start.href,
          cfi: location.start.cfi,
          progression,
          totalProgression: Number.isFinite(totalProgression) ? totalProgression : undefined,
          pageNumber: displayed?.page,
          pageCount: displayed?.total,
          totalPageNumber: totalLocation >= 0 ? totalLocation + 1 : undefined,
          totalPageCount: totalPageCount > 0 ? totalPageCount : undefined,
          chapterPagesRemaining:
            displayed && displayed.total > 0
              ? Math.max(0, displayed.total - displayed.page)
              : undefined,
        };

        // A resize clears and rebuilds EPUB.js views. Its intermediate
        // relocations are not user navigation and must never overwrite the
        // exact CFI captured before the layout changed.
        if (this.layoutAnchor) {
          return;
        }
        if (
          this.requestedLocator?.href &&
          !refersToSameDocument(this.requestedLocator.href, location.start.href)
        ) {
          return;
        }
        this.currentLocator = nextLocator;
        this.callbacks.onLocationChange(nextLocator);
      });

      this.rendition.on('selected', (cfiRange: string, contents: Contents) => {
        this.callbacks.onSelection(selectionFrom(contents, cfiRange));
      });

      this.rendition.on('click', (_event: MouseEvent, contents: Contents) => {
        const liveSelection = contents?.window.getSelection();

        if (!liveSelection || liveSelection.isCollapsed || !liveSelection.toString().trim()) {
          this.callbacks.onSelection(null);
        }
      });
      const openedBook = this.book;
      const openedRendition = this.rendition;
      await openedBook.ready;
      const initialTarget = initialLocator?.cfi ?? initialLocator?.href;
      this.requestedLocator = initialLocator ?? null;
      await this.displayAtStableLocation(openedRendition, initialTarget);
      this.requestedLocator = null;
      await openedRendition.reportLocation();

      // Generating a full-book locations index can take several seconds for a
      // long EPUB. The exact saved CFI does not depend on that index, so show
      // the requested page first and calculate the percentage in the
      // background. A later report enriches the same locator once ready.
      void openedBook.locations
        .generate(600)
        .then(async () => {
          if (this.book === openedBook && this.rendition === openedRendition) {
            await openedRendition.reportLocation();
            this.callbacks.onPaginationReady?.();
          }
        })
        .catch((error: unknown) => {
          if (this.book === openedBook) {
            this.callbacks.onError(asError(error));
          }
        });
    } catch (error) {
      this.callbacks.onError(asError(error));
      await this.close();
      throw error;
    }
  }

  close(): Promise<void> {
    this.pageGesture?.dispose();
    this.pageGesture = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeFrame !== null) {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = null;
    }
    if (this.resizeSettleTimer !== null) {
      clearTimeout(this.resizeSettleTimer);
      this.resizeSettleTimer = null;
    }
    this.rendition?.destroy();
    this.book?.destroy();
    this.rendition = null;
    this.book = null;
    this.preferences = null;
    this.currentLocator = null;
    this.requestedLocator = null;
    this.layoutAnchor = null;
    this.layoutRevision = 0;
    this.preferenceUpdate = 0;
    this.interactionRevision = 0;
    this.observedSize = '';
    return Promise.resolve();
  }

  async next(): Promise<void> {
    this.cancelLayoutRestoration();
    this.interactionRevision += 1;
    this.callbacks.onSelection(null);
    await this.rendition?.next();
  }

  async previous(): Promise<void> {
    this.cancelLayoutRestoration();
    this.interactionRevision += 1;
    this.callbacks.onSelection(null);
    await this.rendition?.prev();
  }

  async goTo(locator: ReaderLocator): Promise<void> {
    this.cancelLayoutRestoration();
    this.interactionRevision += 1;
    this.requestedLocator = locator;
    this.callbacks.onSelection(null);
    try {
      const rendition = this.rendition;
      if (rendition) {
        await this.displayAtStableLocation(rendition, locator.cfi ?? locator.href);
      }
      await rendition?.reportLocation();
    } catch (error) {
      if (this.requestedLocator === locator) {
        this.requestedLocator = null;
      }
      throw error;
    } finally {
      if (this.requestedLocator === locator) {
        this.requestedLocator = null;
      }
    }
  }

  preserveLocationForLayoutChange(locator?: ReaderLocator): void {
    this.interactionRevision += 1;
    this.layoutAnchor = locator ?? this.currentLocator;
  }

  async getTableOfContents(): Promise<readonly EpubNavigationItem[]> {
    const book = this.book;

    if (!book) {
      return [];
    }

    const navigation = await book.loaded.navigation;
    return navigationItems(navigation.toc, (href) => this.pageNumberForHref(href));
  }

  async setPreferences(preferences: ReaderPreferences): Promise<void> {
    const rendition = this.rendition;

    if (!rendition) {
      return;
    }

    const anchor = this.requestedLocator ?? this.layoutAnchor ?? this.currentLocator;
    const anchorTarget = anchor?.cfi ?? anchor?.href;
    const update = ++this.preferenceUpdate;
    const interactionRevision = this.interactionRevision;
    this.preferences = preferences;
    rendition.flow(preferences.flow === 'paginated' ? 'paginated' : 'scrolled-doc');
    rendition.spread(
      preferences.flow === 'paginated' && preferences.pageSpread === 'double' ? 'always' : 'none',
    );
    rendition.themes.override('font-size', `${preferences.fontSizePercent}%`, true);
    rendition.themes.override('line-height', String(preferences.lineHeight), true);
    rendition.themes.override('word-spacing', `${preferences.wordSpacingEm}em`, true);
    rendition.themes.override('letter-spacing', `${preferences.letterSpacingEm}em`, true);
    rendition.themes.override('font-family', fontFamilyValue(preferences), true);
    rendition.themes.override('font-weight', String(preferences.fontWeight), true);
    rendition.themes.override('text-align', preferences.textAlignment, true);
    rendition.themes.override('color', preferences.foreground, true);
    rendition.themes.override('background', preferences.background, true);
    rendition.themes.override('background-color', preferences.background, true);
    rendition.themes.override('padding', `0 ${(100 - preferences.contentWidthPercent) / 2}%`, true);
    rendition.themes.override('box-sizing', 'border-box', true);

    // EPUB.js 0.3.93 declares a single Contents value, while runtime returns Contents[].
    const renderedContents = rendition.getContents() as unknown as Contents[];

    for (const contents of renderedContents) {
      const document = contents.document;

      if (preferences.focusMode) {
        applyFocusMarkup(document, preferences.focusStrength);
      } else {
        removeFocusMarkup(document);
      }
    }

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    if (
      update === this.preferenceUpdate &&
      interactionRevision === this.interactionRevision &&
      anchorTarget
    ) {
      await this.displayAtStableLocation(rendition, anchorTarget);
    }
  }

  private readonly handleWheelNavigation = (event: WheelEvent): void => {
    if (
      this.preferences?.flow === 'paginated' &&
      Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.15
    ) {
      this.interactionRevision += 1;
    }
    this.pageGesture?.handleWheel(event);
  };

  private cancelLayoutRestoration(): void {
    this.layoutRevision += 1;
    this.layoutAnchor = null;
    if (this.resizeSettleTimer !== null) {
      clearTimeout(this.resizeSettleTimer);
      this.resizeSettleTimer = null;
    }
  }

  private async restoreLayoutAnchor(revision: number, anchor: string | undefined): Promise<void> {
    const rendition = this.rendition;

    if (!rendition || revision !== this.layoutRevision) {
      return;
    }

    try {
      if (anchor) {
        await this.displayAtStableLocation(rendition, anchor);
      }
    } catch (error) {
      if (revision === this.layoutRevision) {
        this.callbacks.onError(asError(error));
      }
    }

    if (revision !== this.layoutRevision || rendition !== this.rendition) {
      return;
    }

    this.layoutAnchor = null;
    await rendition.reportLocation();
  }

  private async displayAtStableLocation(
    rendition: ContinuousRendition,
    target: string | undefined,
  ): Promise<void> {
    await rendition.display(target);

    if (!target) {
      return;
    }

    // The continuous manager fills the strip with adjacent spine items after
    // its first display. Prepending those items changes the strip's pixel
    // origin in large books. Re-apply the same target after the fill so the
    // visible page stays on the chapter the reader explicitly chose.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await rendition.display(target);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  private pageNumberForHref(href: string): number | undefined {
    const book = this.book;
    if (!book || book.locations.length() === 0) {
      return undefined;
    }

    try {
      const section = book.spine.get(href.split('#')[0] ?? href);
      if (!section?.cfiBase) {
        return undefined;
      }

      const rawLocation = book.locations.locationFromCfi(
        `epubcfi(${section.cfiBase}!/4/2)`,
      ) as unknown;
      const location = typeof rawLocation === 'number' ? rawLocation : -1;
      return location >= 0 ? location + 1 : undefined;
    } catch {
      return undefined;
    }
  }
}

export { applyFocusMarkup, removeFocusMarkup } from './focus-markup';
