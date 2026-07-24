import './assets.d.ts';

import {
  getDocument,
  GlobalWorkerOptions,
  RenderingCancelledException,
  TextLayer,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';

import type { ReaderSelection, ReaderSource } from '@lexianchor/reader-core';

GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfDocumentInfo {
  readonly pageCount: number;
}

export interface PdfPageResult {
  readonly pageNumber: number;
  readonly pageCount: number;
  readonly hasText: boolean;
  readonly width: number;
  readonly height: number;
}

export interface PdfReaderCallbacks {
  readonly onSelection: (selection: ReaderSelection | null) => void;
  readonly onError: (error: Error) => void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sentenceForSelection(pageSegments: readonly string[], selectedText: string): string {
  const exactSegment = pageSegments.find((segment) => segment.includes(selectedText));

  if (exactSegment) {
    return exactSegment;
  }

  const pageText = pageSegments.join(' ');
  const sentences = pageText.split(/(?<=[.!?。！？])\s+/);
  const exactSentence = sentences.find((sentence) => sentence.includes(selectedText));

  if (exactSentence) {
    return exactSentence;
  }

  const index = pageText.indexOf(selectedText);

  if (index < 0) {
    return selectedText;
  }

  return pageText.slice(Math.max(0, index - 100), index + selectedText.length + 100).trim();
}

function applyFocusMarkup(textLayer: HTMLElement, pageElement: HTMLElement): void {
  const wordPattern = /([A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’][A-Za-zÀ-ÖØ-öø-ÿ]+)?)/g;
  const overlay = textLayer.ownerDocument.createElement('div');
  const pageRect = pageElement.getBoundingClientRect();

  overlay.className = 'pdf-focus-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  pageElement.append(overlay);

  for (const textSpan of textLayer.querySelectorAll<HTMLElement>('span')) {
    if (textSpan.children.length > 0) {
      continue;
    }

    const textNode = [...textSpan.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
    const original = textNode?.textContent ?? '';
    const computedStyle = textSpan.ownerDocument.defaultView?.getComputedStyle(textSpan);

    if (!textNode || !computedStyle) {
      continue;
    }

    for (const match of original.matchAll(wordPattern)) {
      const word = match[0];
      const start = match.index;
      const prefixLength = word.length <= 3 ? 1 : Math.ceil(word.length * 0.45);
      const range = textSpan.ownerDocument.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + prefixLength);
      const rangeRect = range.getBoundingClientRect();

      if (rangeRect.width <= 0 || rangeRect.height <= 0) {
        continue;
      }

      const anchor = textSpan.ownerDocument.createElement('span');
      anchor.className = 'pdf-focus-prefix';
      anchor.dataset.lexianchorFocus = 'anchor';
      anchor.textContent = word.slice(0, prefixLength);
      anchor.style.left = `${rangeRect.left - pageRect.left}px`;
      anchor.style.top = `${rangeRect.top - pageRect.top}px`;
      anchor.style.fontFamily = computedStyle.fontFamily;
      anchor.style.fontSize = computedStyle.fontSize;
      anchor.style.fontStyle = computedStyle.fontStyle;
      anchor.style.letterSpacing = computedStyle.letterSpacing;
      anchor.style.lineHeight = `${rangeRect.height}px`;
      anchor.style.height = `${rangeRect.height}px`;
      overlay.append(anchor);

      const naturalWidth = anchor.getBoundingClientRect().width;
      if (naturalWidth > 0) {
        anchor.style.transform = `scaleX(${rangeRect.width / naturalWidth})`;
      }
    }
  }
}

function listenForSelection(
  container: HTMLElement,
  pageSegments: readonly string[],
  pageNumber: number,
  onSelection: PdfReaderCallbacks['onSelection'],
): () => void {
  const handleSelection = () => {
    const selection = container.ownerDocument.defaultView?.getSelection();
    const selectedText = normalizedText(selection?.toString() ?? '');

    if (!selection || selection.isCollapsed || !selectedText) {
      onSelection(null);
      return;
    }

    const anchorNode = selection.anchorNode;

    if (!anchorNode || !container.contains(anchorNode)) {
      return;
    }

    onSelection({
      text: selectedText,
      sentence: sentenceForSelection(pageSegments, selectedText),
      pageNumber,
    });
  };

  container.addEventListener('mouseup', handleSelection);
  container.addEventListener('keyup', handleSelection);

  return () => {
    container.removeEventListener('mouseup', handleSelection);
    container.removeEventListener('keyup', handleSelection);
  };
}

export class PdfJsReaderEngine {
  readonly id = 'pdfjs';
  readonly label = 'PDF.js 6.1.200';

  private loadingTask: PDFDocumentLoadingTask | null = null;
  private document: PDFDocumentProxy | null = null;
  private renderTask: RenderTask | null = null;
  private textLayer: TextLayer | null = null;
  private removeSelectionListener: (() => void) | null = null;

  constructor(private readonly callbacks: PdfReaderCallbacks) {}

  async open(source: ReaderSource): Promise<PdfDocumentInfo> {
    await this.close();

    try {
      const input =
        typeof source.data === 'string'
          ? { url: source.data }
          : { data: new Uint8Array(source.data.slice(0)) };
      this.loadingTask = getDocument(input);
      this.document = await this.loadingTask.promise;
      return { pageCount: this.document.numPages };
    } catch (error) {
      const readerError = asError(error);
      this.callbacks.onError(readerError);
      await this.close();
      throw readerError;
    }
  }

  async renderPage(
    container: HTMLElement,
    pageNumber: number,
    scale: number,
    focusMode: boolean,
  ): Promise<PdfPageResult> {
    const document = this.document;

    if (!document) {
      throw new Error('Open a PDF before rendering a page.');
    }

    this.cancelPageRender();
    container.replaceChildren();

    try {
      const safePageNumber = Math.min(Math.max(1, pageNumber), document.numPages);
      const page = await document.getPage(safePageNumber);
      const viewport = page.getViewport({ scale });
      const outputScale = Math.min(globalThis.devicePixelRatio || 1, 2);
      const pageElement = container.ownerDocument.createElement('div');
      const canvas = container.ownerDocument.createElement('canvas');
      const textLayerElement = container.ownerDocument.createElement('div');

      pageElement.className = 'pdf-page';
      pageElement.style.width = `${viewport.width}px`;
      pageElement.style.height = `${viewport.height}px`;
      pageElement.style.setProperty('--total-scale-factor', String(scale));
      pageElement.setAttribute('aria-label', `Page ${safePageNumber} of ${document.numPages}`);

      canvas.className = 'pdf-canvas';
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute('aria-hidden', 'true');

      textLayerElement.className = 'textLayer pdf-text-layer';
      textLayerElement.setAttribute('aria-label', `Selectable text for page ${safePageNumber}`);
      pageElement.append(canvas, textLayerElement);
      container.append(pageElement);

      this.renderTask = page.render({
        canvas,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      });

      const textContent = await page.getTextContent();
      await this.renderTask.promise;
      this.renderTask = null;

      const textItems = textContent.items
        .map((item) => ('str' in item ? item.str : ''))
        .map(normalizedText)
        .filter(Boolean);
      const pageText = textItems.join(' ');
      const hasText = pageText.length > 0;

      if (hasText) {
        this.textLayer = new TextLayer({
          textContentSource: textContent,
          container: textLayerElement,
          viewport,
        });
        await this.textLayer.render();

        if (focusMode) {
          applyFocusMarkup(textLayerElement, pageElement);
          textLayerElement.dataset.focusMode = 'on';
        }

        this.removeSelectionListener = listenForSelection(
          textLayerElement,
          textItems,
          safePageNumber,
          this.callbacks.onSelection,
        );
      }

      return {
        pageNumber: safePageNumber,
        pageCount: document.numPages,
        hasText,
        width: viewport.width,
        height: viewport.height,
      };
    } catch (error) {
      if (error instanceof RenderingCancelledException) {
        throw error;
      }

      const readerError = asError(error);
      this.callbacks.onError(readerError);
      throw readerError;
    }
  }

  async close(): Promise<void> {
    this.cancelPageRender();

    if (this.loadingTask) {
      await this.loadingTask.destroy();
    }

    this.loadingTask = null;
    this.document = null;
  }

  private cancelPageRender(): void {
    this.renderTask?.cancel();
    this.textLayer?.cancel();
    this.removeSelectionListener?.();
    this.renderTask = null;
    this.textLayer = null;
    this.removeSelectionListener = null;
    this.callbacks.onSelection(null);
  }
}
