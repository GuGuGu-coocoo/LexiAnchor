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
  readonly end?: { readonly cfi: string };
}

interface ContinuousManagerRuntime {
  readonly container?: HTMLElement;
  readonly layout?: {
    readonly delta?: number;
    readonly pageWidth?: number;
  };
  display?: (section: unknown, target: unknown) => Promise<void>;
  resumeContinuousChecks?: (direction: -1 | 1) => void;
  prepareAdjacent?: (
    direction: -1 | 1,
    signal: AbortSignal,
    isCurrent: () => boolean,
    waitForView?: (view: unknown, signal: AbortSignal) => Promise<void>,
  ) => Promise<void>;
  invalidatePreparation?: () => void;
  trimPreparedViews?: () => void;
  setContentWidthPercent?: (percent: number) => void;
  withDisplayOwner?: <T>(isCurrent: () => boolean, display: () => T) => T;
  readonly settings?: {
    offset?: number;
    offsetDelta?: number;
  };
}

interface PreparedSection {
  readonly index: number;
  prev(): PreparedSection | null;
  next(): PreparedSection | null;
}

interface PreparedContents {
  css(name: string, value: string, priority: boolean): unknown;
}

interface PreparedLayout {
  readonly pageWidth: number;
  format(contents: PreparedContents, ...arguments_: unknown[]): unknown;
}

interface PreparedView {
  readonly section: PreparedSection;
  position(): { left: number };
  expanded: boolean;
  onDisplayed: () => void;
  on(event: string, callback: (value: unknown) => void): void;
  display(request: unknown): Promise<unknown>;
  expand(): void;
  show(): void;
  destroy(): void;
}

/** Narrow, pinned EPUB.js 0.3.93 internals used for bounded preparation only. */
interface AdjacentManagerRuntime {
  readonly container: HTMLElement;
  readonly layout: { readonly delta: number };
  readonly request: unknown;
  readonly views: {
    first(): PreparedView | undefined;
    last(): PreparedView | undefined;
    indexOf(view: PreparedView): number;
    all(): PreparedView[];
    prepend(view: PreparedView): void;
    append(view: PreparedView): void;
  };
  createView(section: PreparedSection): PreparedView;
  erase(view: PreparedView, above?: boolean): void;
  counter(bounds: unknown): void;
  updateAxis(axis: unknown): void;
  updateWritingMode(mode: unknown): void;
  afterDisplayed(view: PreparedView): void;
  visible(): PreparedView[];
}

type ContinuousRendition = Omit<Rendition, 'resize'> & {
  readonly manager?: ContinuousManagerRuntime;
  resize(width: number, height: number, epubCfi?: string): void;
};

/** Pinned rendition queue internals; public display has no cancellation token. */
interface OwnedRenditionQueue {
  q: {
    enqueue(
      task: (target?: string | number) => Promise<unknown> | undefined,
      target?: string | number,
    ): Promise<unknown>;
  };
  _display(target?: string | number): Promise<unknown>;
  displaying?: { resolve(): void };
}

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
  private preparationRevision = 0;
  private preparationCleanups = new Set<() => void>();
  private contentWidthPercent = 90;
  private paddedLayout: PreparedLayout | null = null;
  private displayOwner: (() => boolean) | null = null;

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
    const isCurrent = this.displayOwner ?? (() => true);
    if (!isCurrent()) return Promise.resolve();
    // Width-change scroll events can arrive long after a large iframe reports
    // itself displayed. Keep fill checks suspended until the reader actually
    // navigates instead of relying on a machine-dependent timeout.
    this.checksSuspended = true;
    this.invalidatePreparation();
    // Default display can await add(view) before moving/showing it. Bind its
    // late mutations to this display's lease, not the next active operation.
    const mutations = new Set<PropertyKey>([
      'moveTo',
      'scrollTo',
      'scrollBy',
      'clear',
      'add',
      'handleNextPrePaginated',
    ]);
    const scoped = new Proxy(this, {
      get: (runtime, key) => {
        const value = Reflect.get(runtime, key) as unknown;
        if (key === 'views' && value && typeof value === 'object') {
          return new Proxy(value, {
            get(views, viewKey) {
              const viewValue = Reflect.get(views, viewKey) as unknown;
              if (typeof viewValue !== 'function') return viewValue;
              const method = viewValue as (...arguments_: unknown[]) => unknown;
              if (viewKey === 'show')
                return (...arguments_: unknown[]) =>
                  isCurrent() ? method.apply(views, arguments_) : undefined;
              return method.bind(views);
            },
          });
        }
        if (typeof value !== 'function') return value;
        const method = value as (...arguments_: unknown[]) => unknown;
        if (mutations.has(key))
          return (...arguments_: unknown[]) =>
            isCurrent() ? method.apply(this, arguments_) : Promise.resolve();
        return method.bind(this);
      },
    });
    return DefaultViewManager.prototype.display.call(scoped, section, target);
  }

  withDisplayOwner<T>(isCurrent: () => boolean, display: () => T): T {
    const previous = this.displayOwner;
    this.displayOwner = isCurrent;
    try {
      return display();
    } finally {
      this.displayOwner = previous;
    }
  }

  invalidatePreparation(): void {
    this.preparationRevision += 1;
    for (const cleanup of this.preparationCleanups) cleanup();
    this.preparationCleanups.clear();
  }

  setContentWidthPercent(percent: number): void {
    this.contentWidthPercent = percent;
  }

  setLayout(layout: PreparedLayout): void {
    if (this.paddedLayout !== layout) {
      const format = layout.format.bind(layout);
      layout.format = (contents: PreparedContents, ...arguments_: unknown[]) => {
        const result = format(contents, ...arguments_);
        const padding = `${(layout.pageWidth * (100 - this.contentWidthPercent)) / 200}px`;
        // columns() writes important inline padding on every location read.
        // Apply the reader's fixed column margin before view.expand(), not
        // after expansion, to keep both reading width and strip size stable.
        contents.css('padding-left', padding, true);
        contents.css('padding-right', padding, true);
        contents.css('padding-top', '0', true);
        contents.css('padding-bottom', '0', true);
        return result;
      };
      this.paddedLayout = layout;
    }
    DefaultViewManager.prototype.setLayout.call(this, layout);
  }

  async prepareAdjacent(
    direction: -1 | 1,
    signal: AbortSignal,
    isCurrent: () => boolean,
    waitForView?: (view: unknown, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const runtime = this as unknown as AdjacentManagerRuntime;
    const anchorView = runtime.visible()[0] ?? runtime.views.first();
    const anchorLeft = anchorView?.position().left;
    const anchorScroll = runtime.container.scrollLeft;
    const anchorContentLeft = anchorLeft === undefined ? undefined : anchorLeft + anchorScroll;
    const revision = this.preparationRevision;
    const alive = () => !signal.aborted && revision === this.preparationRevision && isCurrent();
    // Do not call continuous fill(): it recursively loads the whole strip.
    // The requested side is prepared first, and at most one section per side.
    for (const side of [direction, -direction]) {
      if (!alive()) return;
      const extent = Math.max(1, runtime.layout.delta || runtime.container.clientWidth);
      const needsSection =
        side < 0
          ? runtime.container.scrollLeft < extent - 1
          : runtime.container.scrollWidth -
              runtime.container.scrollLeft -
              runtime.container.clientWidth <
            extent - 1;
      if (!needsSection) continue;
      const boundary = side < 0 ? runtime.views.first() : runtime.views.last();
      const section = side < 0 ? boundary?.section.prev() : boundary?.section.next();
      if (!section || !alive()) continue;
      const view = runtime.createView(section);
      // An iframe needs an attached browsing context to render. Register the
      // abort cleanup before attachment; stale reframe callbacks never rebase
      // the live strip after navigation, timeout, resize, or close.
      let attached = false;
      const viewReady = new AbortController();
      const cleanup = () => {
        viewReady.abort();
        if (attached && runtime.views.indexOf(view) >= 0) {
          runtime.erase(view, side < 0);
        }
        attached = false;
        view.destroy();
      };
      signal.addEventListener('abort', cleanup, { once: true });
      this.preparationCleanups.add(cleanup);
      view.on('resized', (bounds: unknown) => {
        if (!alive() || !attached) return;
        if (side < 0) runtime.counter(bounds);
        view.expanded = true;
      });
      view.on('axis', (axis: unknown) => {
        if (alive()) runtime.updateAxis(axis);
      });
      view.on('writingMode', (mode: unknown) => {
        if (alive()) runtime.updateWritingMode(mode);
      });
      view.onDisplayed = () => {
        if (alive() && attached) runtime.afterDisplayed(view);
      };
      try {
        if (!alive()) return;
        if (side < 0) runtime.views.prepend(view);
        else runtime.views.append(view);
        attached = true;
        const rendered = waitForView?.(view, viewReady.signal);
        await view.display(runtime.request);
        if (!alive()) {
          cleanup();
          return;
        }
        // view.display resolves before rendition render/content hooks finish.
        // Themes can change a long section's width by several columns. Wait
        // for those hooks, then measure once before core captures its origin.
        await rendered;
        if (!alive()) {
          cleanup();
          return;
        }
        view.expand();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (!alive()) {
          cleanup();
          return;
        }
        // EPUB.js counter() can be clamped while the hidden iframe is still
        // growing. Rebase from the unchanged original view, not accumulated
        // resize deltas, after themes and final layout have been measured.
        if (
          anchorView &&
          anchorContentLeft !== undefined &&
          runtime.views.indexOf(anchorView) >= 0
        ) {
          const contentLeft = anchorView.position().left + runtime.container.scrollLeft;
          runtime.container.scrollLeft = anchorScroll + contentLeft - anchorContentLeft;
        }
        view.show();
      } catch (error) {
        cleanup();
        if (alive()) throw error;
      } finally {
        signal.removeEventListener('abort', cleanup);
        this.preparationCleanups.delete(cleanup);
      }
    }
  }

  trimPreparedViews(): void {
    const runtime = this as unknown as AdjacentManagerRuntime;
    const visible = runtime.visible();
    const first = visible[0]?.section.index;
    const last = visible[visible.length - 1]?.section.index;
    if (typeof first !== 'number' || typeof last !== 'number') return;
    for (const view of [...runtime.views.all()]) {
      if (view.section.index < first - 1 || view.section.index > last + 1) {
        runtime.erase(view, view.section.index < first);
      }
    }
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
      settings: { fullsize?: boolean; axis?: string };
    };
    if (!runtime.settings.fullsize && runtime.container) {
      // The recursive continuous check can run before its asynchronous scroll
      // event updates EPUB.js' cached coordinates. Always make the next
      // boundary decision from the live scroller position.
      runtime.scrollLeft = runtime.container.scrollLeft;
      runtime.scrollTop = runtime.container.scrollTop;
    }

    if (runtime.settings.axis === 'horizontal' || this.checksSuspended) {
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
  private committedPageStartCfi: string | null = null;
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
  private pendingLinkOrigin: ReaderLocator | null = null;
  private locationGeneration = 0;
  private locationGate: 'open' | 'gesture' | 'navigation' | 'layout' | null = null;
  private gestureGeneration = -1;
  private locationFrozen = true;

  constructor(
    private readonly callbacks: ReaderCallbacks & { readonly onPageInteractionStart?: () => void },
  ) {}

  async open(
    container: HTMLElement,
    source: ReaderSource,
    initialLocator?: ReaderLocator,
  ): Promise<void> {
    await this.close();
    this.locationFrozen = false;
    const openingGeneration = this.beginLocationOperation('open');

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
      const sessionRendition = this.rendition;
      this.installOwnedDisplay(sessionRendition);
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
        onInteractionStart: () => {
          this.gestureGeneration = this.beginLocationOperation('gesture', false);
          this.interactionRevision += 1;
          this.cancelLayoutRestoration();
          this.requestedLocator = null;
          this.callbacks.onPageInteractionStart?.();
        },
        preparePage: async (direction: -1 | 1, signal: AbortSignal) => {
          const rendition = this.rendition;
          const generation = this.gestureGeneration;
          if (!rendition || !this.isLocationOperationCurrent(generation, rendition)) return;
          await rendition.manager?.prepareAdjacent?.(
            direction,
            signal,
            () => this.isLocationOperationCurrent(generation, rendition),
            (view, readySignal) => this.waitForPreparedView(rendition, view, readySignal),
          );
        },
        onSettled: (direction: -1 | 0 | 1) => {
          const rendition = this.rendition;
          const generation = this.gestureGeneration;
          if (!rendition || !this.isLocationOperationCurrent(generation, rendition)) return;
          this.locationGate = null;
          this.gestureGeneration = -1;
          if (direction === 0) return;
          // Clear a publisher TOC checkpoint only for a committed page turn,
          // before publishing its exact live CFI. Preview/cancel changes none.
          this.callbacks.onPageInteraction?.();
          this.callbacks.onSelection(null);
          this.commitLiveLocation(rendition, generation);
          rendition.manager?.trimPreparedViews?.();
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
        invalidate: () => {
          slidingGesture.invalidate?.();
          stackedGesture.invalidate?.();
        },
        dispose: () => {
          slidingGesture.dispose();
          stackedGesture.dispose();
        },
      };
      this.resizeObserver = new ResizeObserver((entries) => {
        if (this.locationFrozen || this.locationGate === 'open') return;
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
          if (!rendition || this.locationFrozen) {
            return;
          }

          const anchor = this.requestedLocator ?? this.layoutAnchor ?? this.currentLocator;
          const anchorTarget = displayTarget(anchor);
          const generation = this.beginLocationOperation('layout');
          const revision = ++this.layoutRevision;
          this.layoutAnchor = anchor ?? null;
          rendition.resize(width, height, anchorTarget);
          this.applyContentWidthPadding(rendition);

          if (this.resizeSettleTimer !== null) {
            clearTimeout(this.resizeSettleTimer);
          }
          this.resizeSettleTimer = setTimeout(() => {
            this.resizeSettleTimer = null;
            void this.restoreLayoutAnchor(revision, anchor, generation);
          }, 60);
        });
      });
      this.resizeObserver.observe(container);

      this.rendition.hooks.content.register((contents: Contents) => {
        if (sessionRendition !== this.rendition || this.locationFrozen) return;
        if (this.preferences?.focusMode) {
          applyFocusMarkup(contents.document, this.preferences.focusStrength);
        }

        contents.document.addEventListener('keydown', (event) =>
          handleNavigationKey(
            event,
            this.locationFrozen || sessionRendition !== this.rendition
              ? undefined
              : this.callbacks.onNavigationCommand,
          ),
        );
        contents.document.addEventListener('wheel', this.handleWheelNavigation, {
          passive: false,
        });
        contents.document.addEventListener(
          'click',
          (event) => {
            this.pendingLinkOrigin = null;
            const target = event.target as Element | null;
            const link = target?.closest('a[href]');
            const href = link?.getAttribute('href') ?? '';

            if (
              this.locationFrozen ||
              sessionRendition !== this.rendition ||
              !link ||
              !href ||
              href.startsWith('mailto:') ||
              href.startsWith('http://') ||
              href.startsWith('https://')
            ) {
              return;
            }

            const sectionHref =
              this.book?.spine.get(contents.sectionIndex)?.href ?? this.currentLocator?.href;
            if (!sectionHref) {
              return;
            }

            try {
              // currentLocator is the beginning of EPUB.js' reported page and
              // can be stale by several columns in a long continuous section.
              // The clicked link itself is an exact, layout-independent return
              // point and is captured before EPUB.js handles the navigation.
              this.pendingLinkOrigin = {
                ...(this.currentLocator ?? {}),
                href: sectionHref,
                cfi: contents.cfiFromNode(link, 'lexianchor-focus'),
              };
            } catch {
              this.pendingLinkOrigin = this.currentLocator;
            }
            // Own internal-link navigation so EPUB.js cannot schedule an
            // untagged display/report after another TOC or Back operation.
            event.preventDefault();
            event.stopImmediatePropagation();
            const origin = this.pendingLinkOrigin;
            this.pendingLinkOrigin = null;
            if (origin) this.callbacks.onLinkNavigation?.(origin);
            const resolved = new URL(href, `https://epub.invalid/${sectionHref}`).pathname.slice(1);
            const fragment = new URL(href, `https://epub.invalid/${sectionHref}`).hash;
            void this.goTo({ href: `${resolved}${fragment}` }).catch((error: unknown) => {
              if (!this.locationFrozen) this.callbacks.onError(asError(error));
            });
          },
          true,
        );
      });

      this.rendition.on('relocated', () => {
        if (
          this.locationFrozen ||
          sessionRendition !== this.rendition ||
          this.locationGate ||
          this.layoutAnchor
        )
          return;
        if (this.preferences?.flow === 'scrolled') {
          // reportLocation() can deliver a queued old report after scrolling.
          // Read the current rendition before clearing a publisher anchor;
          // same-CFI metadata enrichment is not a reading interaction.
          const live = sessionRendition.currentLocation() as unknown as EpubLocation | undefined;
          if (!live?.start?.cfi || !live.start.href) return;
          const moved = live.start.cfi !== this.committedPageStartCfi;
          if (moved) this.callbacks.onPageInteraction?.();
          this.committedPageStartCfi = live.start.cfi;
          this.publishLocation(
            this.mapLocation(
              live,
              moved
                ? undefined
                : this.visibleExactAnchor(sessionRendition, live, this.currentLocator),
            ),
          );
          return;
        }
        // reportLocation() queues a later RAF; it is not a completion barrier.
        // In paginated flow only an explicit commit owns a new CFI. A late
        // preview/open/layout report may enrich that CFI, never replace it.
        const live = sessionRendition.currentLocation() as unknown as EpubLocation | undefined;
        if (
          !live?.start?.cfi ||
          live.start.cfi !== this.committedPageStartCfi ||
          !this.currentLocator?.href ||
          !refersToSameDocument(live.start.href, this.currentLocator.href)
        )
          return;
        this.publishLocation(this.mapLocation(live, this.currentLocator.cfi));
      });

      this.rendition.on('selected', (cfiRange: string, contents: Contents) => {
        if (!this.locationFrozen && sessionRendition === this.rendition) {
          this.callbacks.onSelection(selectionFrom(contents, cfiRange));
        }
      });

      this.rendition.on('click', (_event: MouseEvent, contents: Contents) => {
        const liveSelection = contents?.window.getSelection();

        if (
          !this.locationFrozen &&
          sessionRendition === this.rendition &&
          (!liveSelection || liveSelection.isCollapsed || !liveSelection.toString().trim())
        ) {
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
        () =>
          this.book === openedBook &&
          this.isLocationOperationCurrent(openingGeneration, openedRendition),
        true,
      );
      if (!this.isLocationOperationCurrent(openingGeneration, openedRendition)) return;
      this.requestedLocator = null;
      this.locationGate = null;
      this.commitLiveLocation(openedRendition, openingGeneration, false, initialLocator);

      // Generating a full-book locations index can take several seconds for a
      // long EPUB. The exact saved CFI does not depend on that index, so show
      // the requested page first and calculate the percentage in the
      // background. A later report enriches the same locator once ready.
      void openedBook.locations
        .generate(600)
        .then(() => {
          if (
            !this.locationFrozen &&
            this.book === openedBook &&
            this.rendition === openedRendition
          ) {
            // Derive new index metadata from the latest committed CFI, not
            // from a queued rendition report or a gesture's live preview.
            if (!this.locationGate && this.currentLocator)
              this.publishLocation(this.enrichLocation(this.currentLocator));
            this.callbacks.onPaginationReady?.();
          }
        })
        .catch((error: unknown) => {
          if (!this.locationFrozen && this.book === openedBook) {
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
    this.freezeLocation();
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
    this.committedPageStartCfi = null;
    this.requestedLocator = null;
    this.layoutAnchor = null;
    this.layoutRevision = 0;
    this.preferenceUpdate = 0;
    this.interactionRevision = 0;
    this.observedSize = '';
    this.navigationRevision += 1;
    this.displayQueue = Promise.resolve();
    this.navigationPositionCache.clear();
    this.pendingLinkOrigin = null;
    return Promise.resolve();
  }

  async next(): Promise<void> {
    await this.stepPage(1);
  }

  async previous(): Promise<void> {
    await this.stepPage(-1);
  }

  async goTo(locator: ReaderLocator): Promise<void> {
    if (this.locationFrozen) return;
    const generation = this.beginLocationOperation('navigation');
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
            this.isLocationOperationCurrent(generation, rendition) &&
            this.rendition === rendition &&
            this.requestedLocator === locator,
          true,
        );
      }
      if (
        navigationRevision === this.navigationRevision &&
        rendition &&
        this.isLocationOperationCurrent(generation, rendition) &&
        this.rendition === rendition &&
        this.requestedLocator === locator
      ) {
        this.locationGate = null;
        // Two child anchors can share the same displayed page/spread CFI.
        // A completed explicit navigation still needs an owned commit so
        // the host can adopt its publisher anchor after the pending gate.
        this.commitLiveLocation(rendition, generation, true, locator);
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
    if (this.locationFrozen) return;
    this.beginLocationOperation('layout');
    this.interactionRevision += 1;
    this.requestedLocator = null;
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

    if (!rendition || this.locationFrozen) {
      return;
    }

    const anchor = this.layoutAnchor ?? this.requestedLocator ?? this.currentLocator;
    const generation = this.beginLocationOperation('layout');
    this.layoutAnchor = anchor;
    const anchorTarget = displayTarget(anchor);
    const update = ++this.preferenceUpdate;
    const interactionRevision = this.interactionRevision;
    this.preferences = preferences;
    rendition.manager?.setContentWidthPercent?.(preferences.contentWidthPercent);
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
    // Percent padding is relative to the iframe's full, multi-column width.
    // It makes a long chapter alternately shrink/grow as expand() changes the
    // iframe size. Keep the requested margin relative to one reading column.
    this.applyContentWidthPadding(rendition);
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
    if (this.isLocationOperationCurrent(generation, rendition))
      this.applyContentWidthPadding(rendition);

    if (
      update === this.preferenceUpdate &&
      this.isLocationOperationCurrent(generation, rendition) &&
      interactionRevision === this.interactionRevision &&
      anchorTarget
    ) {
      await this.queueDisplayAtStableLocation(
        rendition,
        anchorTarget,
        () =>
          update === this.preferenceUpdate &&
          this.isLocationOperationCurrent(generation, rendition) &&
          interactionRevision === this.interactionRevision &&
          rendition === this.rendition,
        true,
      );
    }
    if (
      update === this.preferenceUpdate &&
      this.isLocationOperationCurrent(generation, rendition) &&
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
      this.locationGate = null;
      this.commitLiveLocation(rendition, generation, false, anchor);
      if (preferences.flow === 'scrolled') rendition.manager?.resumeContinuousChecks?.(1);
    }
    this.preparePageGesture();
  }

  private readonly handleWheelNavigation = (event: WheelEvent): void => {
    if (this.locationFrozen) return;
    this.pageGesture?.handleWheel(event);
  };

  private applyContentWidthPadding(rendition: ContinuousRendition): void {
    if (!this.preferences) return;
    const columnWidth =
      rendition.manager?.layout?.pageWidth ??
      rendition.manager?.layout?.delta ??
      rendition.manager?.container?.clientWidth ??
      1;
    rendition.themes.override(
      'padding',
      `0 ${(columnWidth * (100 - this.preferences.contentWidthPercent)) / 200}px`,
      true,
    );
  }

  /** Freeze the committed checkpoint before the host starts closing/flushing. */
  freezeLocation(): ReaderLocator | null {
    this.locationFrozen = true;
    this.beginLocationOperation('navigation');
    this.cancelLayoutRestoration();
    return this.currentLocator ? { ...this.currentLocator } : null;
  }

  private beginLocationOperation(
    gate: NonNullable<EpubJsReaderEngine['locationGate']>,
    invalidateGesture = true,
  ): number {
    const generation = ++this.locationGeneration;
    this.locationGate = gate;
    this.gestureGeneration = -1;
    if (invalidateGesture) this.pageGesture?.invalidate?.();
    this.rendition?.manager?.invalidatePreparation?.();
    return generation;
  }

  private isLocationOperationCurrent(generation: number, rendition: ContinuousRendition): boolean {
    return (
      !this.locationFrozen && generation === this.locationGeneration && rendition === this.rendition
    );
  }

  private enrichLocation(locator: ReaderLocator): ReaderLocator {
    if (!locator.cfi || !this.book) return locator;
    const totalProgression = this.book.locations.percentageFromCfi(locator.cfi);
    const count = this.book.locations.length();
    const rawLocation = this.book.locations.locationFromCfi(locator.cfi) as unknown;
    const location = typeof rawLocation === 'number' ? rawLocation : -1;
    return {
      ...locator,
      totalProgression: Number.isFinite(totalProgression) ? totalProgression : undefined,
      totalPageNumber: location >= 0 ? location + 1 : undefined,
      totalPageCount: count > 0 ? count : undefined,
    };
  }

  private mapLocation(location: EpubLocation, exactCfi?: string): ReaderLocator {
    const displayed = location.start.displayed;
    return this.enrichLocation({
      href: location.start.href,
      cfi: exactCfi ?? location.start.cfi,
      progression:
        location.start.percentage ??
        (displayed && displayed.total > 0 ? displayed.page / displayed.total : undefined),
      pageNumber: displayed?.page,
      pageCount: displayed?.total,
      chapterPagesRemaining:
        displayed && displayed.total > 0
          ? Math.max(0, displayed.total - displayed.page)
          : undefined,
    });
  }

  private publishLocation(locator: ReaderLocator, forceCommit = false): void {
    if (
      this.locationFrozen ||
      (!forceCommit && JSON.stringify(locator) === JSON.stringify(this.currentLocator))
    )
      return;
    this.currentLocator = locator;
    this.callbacks.onLocationChange(locator);
  }

  private commitLiveLocation(
    rendition: ContinuousRendition,
    generation: number,
    forceCommit = false,
    anchor?: ReaderLocator | null,
  ): void {
    if (!this.isLocationOperationCurrent(generation, rendition)) return;
    // The pinned continuous manager returns synchronously. Do not await
    // reportLocation(): its queued RAF can belong to an obsolete operation.
    const location = rendition.currentLocation() as unknown as EpubLocation | undefined;
    if (location?.start?.cfi && location.start.href) {
      this.committedPageStartCfi = location.start.cfi;
      this.publishLocation(
        this.mapLocation(location, this.visibleExactAnchor(rendition, location, anchor)),
        forceCommit,
      );
    }
  }

  private visibleExactAnchor(
    rendition: ContinuousRendition,
    location: EpubLocation,
    anchor?: ReaderLocator | null,
  ): string | undefined {
    if (!anchor?.href || !refersToSameDocument(location.start.href, anchor.href)) return undefined;
    let cfi = anchor.cfi;
    const scroller = rendition.manager?.container;
    const fragment = anchor.href.split('#')[1];
    if (!cfi && fragment && scroller) {
      // A completed publisher-child navigation has the same semantic
      // precision as an exact Back CFI, even when its input was only a href.
      for (const contents of rendition.getContents() as unknown as Contents[]) {
        if (!this.isCurrentAnchorContents(contents, anchor.href, scroller)) continue;
        try {
          const element = contents.document.getElementById(decodeURIComponent(fragment));
          if (element) {
            cfi = contents.cfiFromNode(element, 'lexianchor-focus');
            break;
          }
        } catch {
          // Unresolvable fragments still safely commit the actual page.
        }
      }
    }
    if (!cfi) return undefined;
    if (cfi === location.start.cfi) return cfi;
    let spinePos: number;
    try {
      spinePos = rendition.epubcfi.parse(cfi).spinePos;
      const startSpine = rendition.epubcfi.parse(location.start.cfi).spinePos;
      const sectionHref = this.book?.spine?.get(spinePos)?.href;
      if (
        spinePos < 0 ||
        spinePos !== startSpine ||
        !sectionHref ||
        !refersToSameDocument(sectionHref, anchor.href)
      )
        return undefined;
    } catch {
      return undefined;
    }
    try {
      if (
        location.end?.cfi &&
        rendition.epubcfi.compare(location.start.cfi, cfi) <= 0 &&
        rendition.epubcfi.compare(location.end.cfi, cfi) >= 0
      )
        return cfi;
    } catch {
      // Missing/invalid interval metadata cannot prove the requested point.
    }

    // EPUB.js' end mapping stops at a multi-column text node's union bounds.
    // That can omit a later child anchor whose first character is really on
    // screen. Prove the character itself, never a section/element union box.
    if (!scroller) return undefined;
    const viewport = scroller.getBoundingClientRect();
    for (const contents of rendition.getContents() as unknown as Contents[]) {
      if (
        contents.sectionIndex !== spinePos ||
        !this.isCurrentAnchorContents(contents, anchor.href, scroller)
      )
        continue;
      const document = contents.document;
      const frame = document.defaultView!.frameElement!;
      try {
        const resolved = contents.range(cfi, 'lexianchor-focus');
        let node = resolved.startContainer;
        let offset = resolved.startOffset;
        if (node.nodeType === 1) {
          let found: { node: Node; offset: number } | undefined;
          for (const child of Array.from(node.childNodes).slice(offset)) {
            const walker = child.nodeType === 3 ? undefined : document.createTreeWalker(child, 4);
            let text = walker ? walker.nextNode() : child;
            while (text) {
              const start = text.textContent?.search(/\S/) ?? -1;
              if (start >= 0) {
                found = { node: text, offset: start };
                break;
              }
              text = walker?.nextNode() ?? null;
            }
            if (found) break;
          }
          if (!found) continue;
          node = found.node;
          offset = found.offset;
        }
        if (node.nodeType !== 3) continue;
        const text = node.textContent ?? '';
        const next = text.slice(offset).search(/\S/);
        if (next < 0) continue;
        offset += next;
        const point = document.createRange();
        point.setStart(node, offset);
        point.setEnd(node, offset + ((text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1));
        const frameBox = frame.getBoundingClientRect();
        for (const box of Array.from(point.getClientRects())) {
          const x = frameBox.left + (box.left + box.right) / 2;
          const y = frameBox.top + (box.top + box.bottom) / 2;
          if (
            box.width > 0 &&
            box.height > 0 &&
            x > viewport.left &&
            x < viewport.right &&
            y > viewport.top &&
            y < viewport.bottom
          )
            return cfi;
        }
      } catch {
        // A stale or unresolvable target is never promoted to committed data.
      }
    }
    return undefined;
  }

  private isCurrentAnchorContents(
    contents: Contents,
    href: string,
    scroller: HTMLElement,
  ): boolean {
    const sectionHref = this.book?.spine?.get(contents.sectionIndex)?.href;
    const frame = contents.document.defaultView?.frameElement;
    return Boolean(
      sectionHref &&
      refersToSameDocument(sectionHref, href) &&
      frame?.isConnected &&
      scroller.contains(frame),
    );
  }

  private async stepPage(direction: -1 | 1): Promise<void> {
    const rendition = this.rendition;
    if (!rendition || this.locationFrozen) return;
    const generation = this.beginLocationOperation('navigation');
    this.cancelLayoutRestoration();
    this.interactionRevision += 1;
    this.navigationRevision += 1;
    this.callbacks.onSelection(null);
    const preparation = new AbortController();
    try {
      if (this.preferences?.flow === 'paginated') {
        await rendition.manager?.prepareAdjacent?.(
          direction,
          preparation.signal,
          () => this.isLocationOperationCurrent(generation, rendition),
          (view, readySignal) => this.waitForPreparedView(rendition, view, readySignal),
        );
      } else rendition.manager?.resumeContinuousChecks?.(direction);
      if (!this.isLocationOperationCurrent(generation, rendition)) return;
      if (direction > 0) await rendition.next();
      else await rendition.prev();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (!this.isLocationOperationCurrent(generation, rendition)) return;
      this.locationGate = null;
      this.commitLiveLocation(rendition, generation);
      rendition.manager?.trimPreparedViews?.();
      this.preparePageGesture();
    } finally {
      preparation.abort();
    }
  }

  private waitForPreparedView(
    rendition: ContinuousRendition,
    expectedView: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = () => {
        rendition.off('rendered', rendered);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const rendered = (_section: unknown, view: unknown) => {
        if (view === expectedView) finish();
      };
      rendition.on('rendered', rendered);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }

  private cancelLayoutRestoration(): void {
    this.layoutRevision += 1;
    this.layoutAnchor = null;
    if (this.resizeSettleTimer !== null) {
      clearTimeout(this.resizeSettleTimer);
      this.resizeSettleTimer = null;
    }
  }

  private async restoreLayoutAnchor(
    revision: number,
    anchor: ReaderLocator | null | undefined,
    generation: number,
  ): Promise<void> {
    const rendition = this.rendition;

    if (
      !rendition ||
      revision !== this.layoutRevision ||
      !this.isLocationOperationCurrent(generation, rendition)
    ) {
      return;
    }

    try {
      const target = displayTarget(anchor);
      if (target) {
        await this.queueDisplayAtStableLocation(
          rendition,
          target,
          () =>
            revision === this.layoutRevision &&
            this.isLocationOperationCurrent(generation, rendition),
          true,
        );
      }
    } catch (error) {
      if (
        revision === this.layoutRevision &&
        this.isLocationOperationCurrent(generation, rendition)
      ) {
        this.callbacks.onError(asError(error));
      }
    }

    if (
      revision !== this.layoutRevision ||
      !this.isLocationOperationCurrent(generation, rendition)
    ) {
      return;
    }

    this.layoutAnchor = null;
    this.locationGate = null;
    this.commitLiveLocation(rendition, generation, false, anchor);
    this.preparePageGesture();
  }

  private preparePageGesture(): void {
    const generation = this.locationGeneration;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!this.locationFrozen && generation === this.locationGeneration)
          this.pageGesture?.prepare?.();
      });
    });
  }

  private installOwnedDisplay(rendition: ContinuousRendition): void {
    const runtime = rendition as unknown as Partial<OwnedRenditionQueue>;
    // Test doubles and alternate engines can retain the public-only path.
    if (!runtime.q?.enqueue || !runtime._display) return;
    const queue = runtime.q;
    const display = runtime._display.bind(rendition);
    rendition.display = (target?: string | number): Promise<void> => {
      const generation = this.locationGeneration;
      const isCurrent = () => this.isLocationOperationCurrent(generation, rendition);
      // Preserve the pinned public method's completion/serial queue contract.
      runtime.displaying?.resolve();
      return queue
        .enqueue((queuedTarget) => {
          if (!isCurrent()) return undefined;
          return rendition.manager?.withDisplayOwner
            ? rendition.manager.withDisplayOwner(isCurrent, () => display(queuedTarget))
            : display(queuedTarget);
        }, target)
        .then(() => undefined);
    };
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

        // The continuous manager can fill or resize its strip after the first
        // display. Re-apply the target once after those first paints so saved
        // positions, TOC jumps, and Back links all land on the intended CFI.
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

    const contents = await (section.load(book.load.bind(book)) as unknown as Promise<Element>);
    // Parent and child TOC entries resolve concurrently. The parent's
    // unload() may clear section.document before a child resumes; use the
    // document owned by this load result rather than that mutable field.
    const document = contents?.ownerDocument;
    const fragment = encodedFragment ? decodeURIComponent(encodedFragment) : '';
    const element = fragment
      ? document?.getElementById(fragment)
      : document?.body?.firstElementChild;
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
