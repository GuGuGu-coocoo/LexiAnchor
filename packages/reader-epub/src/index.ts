import ePub, { type Book, type Contents, type Rendition } from 'epubjs';

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

  return { text, sentence, cfiRange };
}

export class EpubJsReaderEngine implements ReaderEngine {
  readonly id = 'epubjs';
  readonly label = 'EPUB.js 0.3.93';

  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private preferences: ReaderPreferences | null = null;

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
          applyFocusMarkup(contents.document);
        }
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

      this.rendition.on('click', () => this.callbacks.onSelection(null));
      await this.book.ready;
      await this.book.locations.generate(600);
      await this.rendition.display(initialLocator?.cfi);
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
    return Promise.resolve();
  }

  async next(): Promise<void> {
    await this.rendition?.next();
  }

  async previous(): Promise<void> {
    await this.rendition?.prev();
  }

  async goTo(locator: ReaderLocator): Promise<void> {
    await this.rendition?.display(locator.cfi ?? locator.href);
  }

  async setPreferences(preferences: ReaderPreferences): Promise<void> {
    const rendition = this.rendition;

    if (!rendition) {
      return;
    }

    const flowChanged = this.preferences?.flow !== preferences.flow;
    rendition.flow(preferences.flow === 'paginated' ? 'paginated' : 'scrolled-doc');
    rendition.themes.override('font-size', `${preferences.fontSizePercent}%`, true);
    rendition.themes.override('line-height', String(preferences.lineHeight), true);
    rendition.themes.override('word-spacing', `${preferences.wordSpacingEm}em`, true);
    rendition.themes.override('color', preferences.foreground, true);
    rendition.themes.override('background', preferences.background, true);
    rendition.themes.override('background-color', preferences.background, true);
    rendition.themes.override('padding', preferences.flow === 'scrolled' ? '0 7vw' : '0', true);

    // EPUB.js 0.3.93 declares a single Contents value, while runtime returns Contents[].
    const renderedContents = rendition.getContents() as unknown as Contents[];

    for (const contents of renderedContents) {
      const document = contents.document;

      if (preferences.focusMode) {
        applyFocusMarkup(document);
      } else {
        removeFocusMarkup(document);
      }
    }

    if (flowChanged && this.preferences) {
      await rendition.display();
    }

    this.preferences = preferences;
  }
}

export { applyFocusMarkup, removeFocusMarkup } from './focus-markup';
