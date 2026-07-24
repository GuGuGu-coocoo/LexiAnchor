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

function sentenceForSelection(pageText: string, selectedText: string): string {
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

function applyFocusMarkup(textLayer: HTMLElement): void {
  const wordPattern = /([A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’][A-Za-zÀ-ÖØ-öø-ÿ]+)?)/g;

  for (const textSpan of textLayer.querySelectorAll<HTMLElement>('span')) {
    if (textSpan.closest('.markedContent') !== textSpan.parentElement && textSpan.children.length) {
      continue;
    }

    const original = textSpan.textContent ?? '';
    const parts = original.split(wordPattern);

    if (parts.length === 1) {
      continue;
    }

    const fragment = textSpan.ownerDocument.createDocumentFragment();

    for (const part of parts) {
      wordPattern.lastIndex = 0;

      if (!wordPattern.test(part)) {
        fragment.append(part);
        continue;
      }

      const prefixLength = part.length <= 3 ? 1 : Math.ceil(part.length * 0.45);
      const anchor = textSpan.ownerDocument.createElement('lexi-anchor');
      anchor.dataset.lexianchorFocus = 'anchor';
      anchor.textContent = part.slice(0, prefixLength);
      fragment.append(anchor, part.slice(prefixLength));
    }

    textSpan.replaceChildren(fragment);
  }
}

function listenForSelection(
  container: HTMLElement,
  pageText: string,
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
      sentence: sentenceForSelection(pageText, selectedText),
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
        .filter(Boolean);
      const pageText = normalizedText(textItems.join(' '));
      const hasText = pageText.length > 0;

      if (hasText) {
        this.textLayer = new TextLayer({
          textContentSource: textContent,
          container: textLayerElement,
          viewport,
        });
        await this.textLayer.render();

        if (focusMode) {
          applyFocusMarkup(textLayerElement);
          textLayerElement.dataset.focusMode = 'on';
        }

        this.removeSelectionListener = listenForSelection(
          textLayerElement,
          pageText,
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
