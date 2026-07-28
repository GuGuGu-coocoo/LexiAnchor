import ePub, { type Book, type Contents, type NavItem, type Rendition } from 'epubjs';

import type {
  ReaderCallbacks,
  ReaderEngine,
  ReaderLocator,
  ReaderPreferences,
  ReaderSelection,
  ReaderSource,
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

export interface EpubNavigationItem {
  readonly id: string;
  readonly href: string;
  readonly label: string;
  readonly subitems: readonly EpubNavigationItem[];
}

function navigationItems(items: readonly NavItem[]): EpubNavigationItem[] {
  return items.map((item) => ({
    id: item.id,
    href: item.href,
    label: item.label.trim() || item.href,
    subitems: navigationItems(item.subitems ?? []),
  }));
}

function handleNavigationKey(
  event: KeyboardEvent,
  onCommand: ReaderCallbacks['onNavigationCommand'],
): void {
  const element = event.target as HTMLElement | null;
  const tagName = element?.tagName;

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

export class EpubJsReaderEngine implements ReaderEngine {
  readonly id = 'epubjs';
  readonly label = 'EPUB.js 0.3.93';

  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private preferences: ReaderPreferences | null = null;
  private wheelDeltaX = 0;
  private wheelResetTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWheelNavigationAt = 0;

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
        flow: 'paginated',
        spread: 'none',
        ignoreClass: 'lexianchor-focus',
        allowScriptedContent: false,
      });

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
      });

      this.rendition.on('relocated', (location: EpubLocation) => {
        const displayed = location.start.displayed;
        const progression =
          location.start.percentage ??
          (displayed && displayed.total > 0 ? displayed.page / displayed.total : undefined);

        const totalProgression = this.book?.locations.percentageFromCfi(location.start.cfi);

        this.callbacks.onLocationChange({
          href: location.start.href,
          cfi: location.start.cfi,
          progression,
          totalProgression: Number.isFinite(totalProgression) ? totalProgression : undefined,
        });
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
      await this.book.ready;
      await this.book.locations.generate(600);
      await this.rendition.display(initialLocator?.cfi ?? initialLocator?.href);
    } catch (error) {
      this.callbacks.onError(asError(error));
      await this.close();
      throw error;
    }
  }

  close(): Promise<void> {
    this.rendition?.destroy();
    this.book?.destroy();
    this.rendition = null;
    this.book = null;
    this.preferences = null;
    this.wheelDeltaX = 0;
    if (this.wheelResetTimer !== null) {
      clearTimeout(this.wheelResetTimer);
      this.wheelResetTimer = null;
    }
    return Promise.resolve();
  }

  async next(): Promise<void> {
    this.callbacks.onSelection(null);
    await this.rendition?.next();
  }

  async previous(): Promise<void> {
    this.callbacks.onSelection(null);
    await this.rendition?.prev();
  }

  async goTo(locator: ReaderLocator): Promise<void> {
    this.callbacks.onSelection(null);
    await this.rendition?.display(locator.cfi ?? locator.href);
  }

  async getTableOfContents(): Promise<readonly EpubNavigationItem[]> {
    const book = this.book;

    if (!book) {
      return [];
    }

    const navigation = await book.loaded.navigation;
    return navigationItems(navigation.toc);
  }

  async setPreferences(preferences: ReaderPreferences): Promise<void> {
    const rendition = this.rendition;

    if (!rendition) {
      return;
    }

    const flowChanged = this.preferences?.flow !== preferences.flow;
    const spreadChanged = this.preferences?.pageSpread !== preferences.pageSpread;
    rendition.flow(preferences.flow === 'paginated' ? 'paginated' : 'scrolled-doc');
    rendition.spread(
      preferences.flow === 'paginated' && preferences.pageSpread === 'double' ? 'always' : 'none',
    );
    rendition.themes.override('font-size', `${preferences.fontSizePercent}%`, true);
    rendition.themes.override('line-height', String(preferences.lineHeight), true);
    rendition.themes.override('word-spacing', `${preferences.wordSpacingEm}em`, true);
    rendition.themes.override('letter-spacing', `${preferences.letterSpacingEm}em`, true);
    rendition.themes.override(
      'font-family',
      preferences.fontFamily === 'serif'
        ? "Georgia, 'Times New Roman', serif"
        : "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      true,
    );
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

    if ((flowChanged || spreadChanged) && this.preferences) {
      await rendition.display();
    }

    this.preferences = preferences;
  }

  private readonly handleWheelNavigation = (event: WheelEvent): void => {
    if (
      this.preferences?.flow !== 'paginated' ||
      Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.15
    ) {
      this.wheelDeltaX = 0;
      return;
    }

    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    this.wheelDeltaX += event.deltaX * scale;

    if (this.wheelResetTimer !== null) {
      clearTimeout(this.wheelResetTimer);
    }
    this.wheelResetTimer = setTimeout(() => {
      this.wheelDeltaX = 0;
      this.wheelResetTimer = null;
    }, 180);

    const now = Date.now();
    if (Math.abs(this.wheelDeltaX) < 72 || now - this.lastWheelNavigationAt < 420) {
      return;
    }

    event.preventDefault();
    this.callbacks.onNavigationCommand?.(this.wheelDeltaX > 0 ? 'next' : 'previous');
    this.lastWheelNavigationAt = now;
    this.wheelDeltaX = 0;
  };
}

export { applyFocusMarkup, removeFocusMarkup } from './focus-markup';
