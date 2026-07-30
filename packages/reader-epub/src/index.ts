import ePub, { type Book, type Contents, type NavItem, type Rendition } from 'epubjs';
// @ts-expect-error EPUB.js does not publish declarations for its pinned manager internals.
import ContinuousViewManager from 'epubjs/src/managers/continuous/index.js';
// @ts-expect-error EPUB.js does not publish declarations for its pinned manager internals.
import DefaultViewManager from 'epubjs/src/managers/default/index.js';

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
  display?: (section: unknown, target: unknown) => Promise<void>;
  resumeContinuousChecks?: (direction: -1 | 1) => void;
  readonly settings?: {
    offset?: number;
    offsetDelta?: number;
  };
}

type ContinuousRendition = Omit<Rendition, 'resize'> & {
  readonly manager?: ContinuousManagerRuntime;
  resize(width: number, height: number, epubCfi?: string): void;
};

export interface EpubNavigationItem {
  readonly id: string;
  readonly href: string;
  readonly cfi?: string;
  readonly label: string;
  readonly totalProgression?: number;
  readonly pageNumber?: number;
  readonly subitems: readonly EpubNavigationItem[];
}

interface EpubNavigationPosition {
  readonly cfi?: string;
  readonly totalProgression?: number;
  readonly pageNumber?: number;
}

/**
 * EPUB.js' continuous manager calls fill() before long reflowable sections
 * have their final widths. It can prepend the previous chapter and leave that
 * chapter visible after display(target) resolves. The default display routine
 * anchors the requested section first; ContinuousViewManager still adds the
 * adjacent section later as the reader approaches a chapter boundary.
 */
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */
class AnchoredContinuousViewManager extends ContinuousViewManager {
  private checksSuspended = true;
  private resumeDirection: -1 | 1 = 1;

  constructor(options: unknown) {
    super(options);
    const settings = (
      this as unknown as {
        settings: { offset: number; offsetDelta: number };
      }
    ).settings;
    settings.offset = 0;
    settings.offsetDelta = 0;
  }

  display(section: unknown, target?: string | number): Promise<void> {
    // Width-change scroll events can arrive long after a large iframe reports
    // itself displayed. Keep fill checks suspended until the reader actually
    // navigates instead of relying on a machine-dependent timeout.
    this.checksSuspended = true;
    return DefaultViewManager.prototype.display.call(this, section, target);
  }

  resumeContinuousChecks(direction: -1 | 1): void {
    this.resumeDirection = direction;
    this.checksSuspended = false;
  }

  check(offsetLeft?: number, offsetTop?: number): Promise<unknown> {
    const runtime = this as unknown as {
      container?: HTMLElement;
      scrollLeft: number;
      scrollTop: number;
      settings: { fullsize?: boolean };
    };
    if (!runtime.settings.fullsize && runtime.container) {
      // The recursive continuous check can run before its asynchronous scroll
      // event updates EPUB.js' cached coordinates. Always make the next
      // boundary decision from the live scroller position.
      runtime.scrollLeft = runtime.container.scrollLeft;
      runtime.scrollTop = runtime.container.scrollTop;
    }

    if (this.checksSuspended) {
      return Promise.resolve(false);
    }

    // A forward gesture starts at scrollLeft=0. Ignore any already-queued
    // layout check until the gesture has actually moved the strip; otherwise
    // that stale check prepends the previous chapter before the fingers move.
    if (
      this.resumeDirection > 0 &&
      runtime.container &&
      runtime.container.scrollLeft < runtime.container.clientWidth * 1.5 &&
      runtime.container.scrollTop < 1
    ) {
      return Promise.resolve(false);
    }

    return super.check(offsetLeft, offsetTop);
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */

async function navigationItems(
  items: readonly NavItem[],
  positionForHref: (href: string) => Promise<EpubNavigationPosition>,
): Promise<EpubNavigationItem[]> {
  return Promise.all(
    items.map(async (item) => {
      const [position, subitems] = await Promise.all([
        positionForHref(item.href),
        navigationItems(item.subitems ?? [], positionForHref),
      ]);
      return {
        id: item.id,
        href: item.href,
        label: item.label.trim() || item.href,
        ...position,
        subitems,
      };
    }),
  );
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
  } else if (!event.repeat && event.key.toLocaleLowerCase('en-US') === 'f') {
    event.preventDefault();
    onCommand?.('fullscreen');
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

function displayTarget(locator: ReaderLocator | null | undefined): string | undefined {
  if (!locator) {
    return undefined;
  }

  // EPUB TOC fragments are the publisher's authoritative destinations. A CFI
  // derived from an unloaded or unusual XHTML document can degrade to the
  // chapter start, which made every child item appear to open its parent.
  // Keep exact page CFIs for ordinary reading positions, but always honor an
  // explicit `chapter.xhtml#subheading` target.
  return locator.href.includes('#') ? locator.href : (locator.cfi ?? locator.href);
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
  private navigationRevision = 0;
  private displayQueue: Promise<void> = Promise.resolve();
  private navigationPositionCache = new Map<string, Promise<EpubNavigationPosition>>();

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
        manager: AnchoredContinuousViewManager,
        flow: 'paginated',
        spread: 'none',
        snap: false,
        ignoreClass: 'lexianchor-focus',
        allowScriptedContent: false,
      });
      if (this.rendition.manager?.settings) {
        this.rendition.manager.settings.offset = 0;
        this.rendition.manager.settings.offsetDelta = 0;
      }

      const gestureOptions = {
        getScroller: () => this.rendition?.manager?.container ?? null,
        getPageExtent: () =>
          this.rendition?.manager?.layout?.delta ??
          this.rendition?.manager?.container?.clientWidth ??
          1,
        isEnabled: () => this.preferences?.flow === 'paginated',
        // Chromium's prepared ViewTransition overlay captures pointer hit
        // testing while it waits. Start the capture from the first wheel
        // sample instead; its buffered delta is applied as soon as the next
        // paint is ready and the rest of the gesture remains one-to-one.
        shouldPrearm: () => false,
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
        prepare: () => stackedGesture.prepare?.(),
        invalidate: () => stackedGesture.invalidate?.(),
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
          const anchorTarget = displayTarget(anchor);
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
      await openedRendition.started;
      const manager = openedRendition.manager;
      if (manager?.settings) {
        manager.settings.offset = 0;
        manager.settings.offsetDelta = 0;
      }
      const initialTarget = displayTarget(initialLocator);
      this.requestedLocator = initialLocator ?? null;
      await this.queueDisplayAtStableLocation(
        openedRendition,
        initialTarget,
        () => this.book === openedBook && this.rendition === openedRendition,
        true,
      );
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
    this.navigationRevision += 1;
    this.displayQueue = Promise.resolve();
    this.navigationPositionCache.clear();
    return Promise.resolve();
  }

  async next(): Promise<void> {
    this.pageGesture?.invalidate?.();
    this.cancelLayoutRestoration();
    this.interactionRevision += 1;
    this.navigationRevision += 1;
    this.callbacks.onSelection(null);
    this.rendition?.manager?.resumeContinuousChecks?.(1);
    await this.rendition?.next();
    this.preparePageGesture();
  }

  async previous(): Promise<void> {
    this.pageGesture?.invalidate?.();
    this.cancelLayoutRestoration();
    this.interactionRevision += 1;
    this.navigationRevision += 1;
    this.callbacks.onSelection(null);
    this.rendition?.manager?.resumeContinuousChecks?.(-1);
    await this.rendition?.prev();
    this.preparePageGesture();
  }

  async goTo(locator: ReaderLocator): Promise<void> {
    this.pageGesture?.invalidate?.();
    this.cancelLayoutRestoration();
    this.interactionRevision += 1;
    const navigationRevision = ++this.navigationRevision;
    this.requestedLocator = locator;
    this.callbacks.onSelection(null);
    try {
      const rendition = this.rendition;
      if (rendition) {
        await this.queueDisplayAtStableLocation(
          rendition,
          displayTarget(locator),
          () =>
            navigationRevision === this.navigationRevision &&
            this.rendition === rendition &&
            this.requestedLocator === locator,
          false,
        );
      }
      if (
        navigationRevision === this.navigationRevision &&
        this.rendition === rendition &&
        this.requestedLocator === locator
      ) {
        await rendition?.reportLocation();
      }
    } catch (error) {
      if (this.requestedLocator === locator) {
        this.requestedLocator = null;
      }
      throw error;
    } finally {
      if (this.requestedLocator === locator) {
        this.requestedLocator = null;
      }
      this.preparePageGesture();
    }
  }

  preserveLocationForLayoutChange(locator?: ReaderLocator): void {
    this.pageGesture?.invalidate?.();
    this.interactionRevision += 1;
    this.layoutAnchor = locator ?? this.currentLocator;
  }

  async getTableOfContents(): Promise<readonly EpubNavigationItem[]> {
    const book = this.book;

    if (!book) {
      return [];
    }

    const navigation = await book.loaded.navigation;
    return navigationItems(navigation.toc, (href) => this.navigationPositionForHref(href));
  }

  async setPreferences(preferences: ReaderPreferences): Promise<void> {
    const rendition = this.rendition;

    if (!rendition) {
      return;
    }

    this.pageGesture?.invalidate?.();
    const anchor = this.requestedLocator ?? this.layoutAnchor ?? this.currentLocator;
    const anchorTarget = displayTarget(anchor);
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
      await this.queueDisplayAtStableLocation(
        rendition,
        anchorTarget,
        () =>
          update === this.preferenceUpdate &&
          interactionRevision === this.interactionRevision &&
          rendition === this.rendition,
        false,
      );
    }
    if (
      update === this.preferenceUpdate &&
      interactionRevision === this.interactionRevision &&
      rendition === this.rendition
    ) {
      // A typography update is itself a complete layout restoration. Leaving
      // layoutAnchor set caused every later `relocated` event to be discarded,
      // so the visible pages advanced while the saved checkpoint stayed at
      // the beginning of the chapter indefinitely.
      this.layoutRevision += 1;
      this.layoutAnchor = null;
      if (this.resizeSettleTimer !== null) {
        clearTimeout(this.resizeSettleTimer);
        this.resizeSettleTimer = null;
      }
      await rendition.reportLocation();
    }
    this.preparePageGesture();
  }

  private readonly handleWheelNavigation = (event: WheelEvent): void => {
    if (
      this.preferences?.flow === 'paginated' &&
      Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.15
    ) {
      this.interactionRevision += 1;
      this.rendition?.manager?.resumeContinuousChecks?.(event.deltaX > 0 ? 1 : -1);
      this.callbacks.onPageInteraction?.();
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
        await this.queueDisplayAtStableLocation(
          rendition,
          anchor,
          () => revision === this.layoutRevision && rendition === this.rendition,
          false,
        );
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
    this.preparePageGesture();
  }

  private preparePageGesture(): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.pageGesture?.prepare?.());
    });
  }

  private queueDisplayAtStableLocation(
    rendition: ContinuousRendition,
    target: string | undefined,
    isCurrent: () => boolean,
    stabilizeContinuousStrip: boolean,
  ): Promise<void> {
    const task = this.displayQueue
      .catch(() => undefined)
      .then(async () => {
        if (!isCurrent()) {
          return;
        }

        await rendition.display(target);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (!isCurrent()) {
          return;
        }

        if (!target || !stabilizeContinuousStrip || !isCurrent()) {
          return;
        }

        // On initial open, the continuous manager fills its strip after the
        // first display. Re-apply the saved target once while the loading state
        // is still hidden. Explicit TOC jumps never take this second trip.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (!isCurrent()) {
          return;
        }
        await rendition.display(target);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
    this.displayQueue = task.catch(() => undefined);
    return task;
  }

  private navigationPositionForHref(href: string): Promise<EpubNavigationPosition> {
    const book = this.book;
    if (!book) {
      return Promise.resolve({});
    }

    const cacheKey = `${book.locations.length()}:${href}`;
    const cached = this.navigationPositionCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const pending = this.resolveNavigationPosition(book, href).catch(() => ({}));
    this.navigationPositionCache.set(cacheKey, pending);
    return pending;
  }

  private async resolveNavigationPosition(
    book: Book,
    href: string,
  ): Promise<EpubNavigationPosition> {
    const [documentHref = href, encodedFragment] = href.split('#', 2);
    const section = book.spine.get(documentHref);
    if (!section?.cfiBase) {
      return {};
    }

    await (section.load(book.load.bind(book)) as unknown as Promise<Element>);
    const fragment = encodedFragment ? decodeURIComponent(encodedFragment) : '';
    const element = fragment
      ? section.document?.getElementById(fragment)
      : section.document?.body?.firstElementChild;
    const cfi = element ? section.cfiFromElement(element) : undefined;

    if (!fragment) {
      section.unload();
    }

    const rawLocation = cfi ? (book.locations.locationFromCfi(cfi) as unknown) : -1;
    const location = typeof rawLocation === 'number' ? rawLocation : -1;
    const totalProgression = cfi ? book.locations.percentageFromCfi(cfi) : undefined;
    return {
      // Passing a synthetic start CFI to rendition.display() can land near the
      // end of a long chapter in EPUB.js. A plain href is exact for top-level
      // chapters; reserve element CFIs for fragment-level TOC entries.
      cfi: fragment ? cfi : undefined,
      pageNumber: location >= 0 ? location + 1 : undefined,
      totalProgression:
        totalProgression !== undefined && Number.isFinite(totalProgression)
          ? totalProgression
          : undefined,
    };
  }
}

export { applyFocusMarkup, removeFocusMarkup } from './focus-markup';
