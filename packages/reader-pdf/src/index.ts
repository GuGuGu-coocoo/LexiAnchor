import './assets.d.ts';

import {
  getDocument,
  GlobalWorkerOptions,
  RenderingCancelledException,
  TextLayer,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type PageViewport,
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
  readonly linkCount: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfDocumentResult {
  readonly pageCount: number;
  readonly hasText: boolean;
  readonly pages: readonly PdfPageResult[];
}

export interface PdfReaderCallbacks {
  readonly onSelection: (selection: ReaderSelection | null) => void;
  readonly onExternalLink: (url: string) => Promise<void> | void;
  readonly onInternalLink: (pageNumber: number) => void;
  readonly onError: (error: Error) => void;
}

interface PdfLinkAnnotation {
  readonly subtype?: unknown;
  readonly url?: unknown;
  readonly dest?: unknown;
  readonly rect?: unknown;
  readonly contentsObj?: unknown;
  readonly titleObj?: unknown;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function renderingCancelledError(pageNumber: number): Error {
  return new RenderingCancelledException(
    `Rendering cancelled, page ${pageNumber}`,
  ) as unknown as Error;
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function annotationText(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('str' in value)) {
    return '';
  }

  return typeof value.str === 'string' ? value.str.trim() : '';
}

function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

async function destinationPageNumber(
  document: PDFDocumentProxy,
  destination: unknown,
): Promise<number | null> {
  const explicitDestination: unknown =
    typeof destination === 'string' ? await document.getDestination(destination) : destination;

  if (!Array.isArray(explicitDestination)) {
    return null;
  }

  const reference: unknown = (explicitDestination as unknown[])[0];

  if (Number.isInteger(reference)) {
    return (reference as number) + 1;
  }

  if (typeof reference !== 'object' || reference === null) {
    return null;
  }

  const typedReference = reference as Parameters<PDFDocumentProxy['getPageIndex']>[0];
  const cached = document.cachedPageNumber(typedReference);
  return cached ?? (await document.getPageIndex(typedReference)) + 1;
}

function positionLink(
  link: HTMLAnchorElement,
  rect: readonly number[],
  viewport: PageViewport,
): void {
  const firstPoint: unknown = viewport.convertToViewportPoint(rect[0] ?? 0, rect[1] ?? 0);
  const secondPoint: unknown = viewport.convertToViewportPoint(rect[2] ?? 0, rect[3] ?? 0);

  if (
    !Array.isArray(firstPoint) ||
    !Array.isArray(secondPoint) ||
    firstPoint.length < 2 ||
    secondPoint.length < 2 ||
    !firstPoint.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
    !secondPoint.every((value) => typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }

  const [firstX = 0, firstY = 0] = firstPoint as number[];
  const [secondX = 0, secondY = 0] = secondPoint as number[];
  const left = Math.min(firstX, secondX);
  const top = Math.min(firstY, secondY);

  link.style.left = `${left}px`;
  link.style.top = `${top}px`;
  link.style.width = `${Math.abs(secondX - firstX)}px`;
  link.style.height = `${Math.abs(secondY - firstY)}px`;
}

async function renderLinkAnnotations(
  document: PDFDocumentProxy,
  page: PDFPageProxy,
  viewport: PageViewport,
  pageElement: HTMLElement,
  callbacks: PdfReaderCallbacks,
): Promise<number> {
  const annotations = (await page.getAnnotations({ intent: 'display' })) as PdfLinkAnnotation[];
  const layer = pageElement.ownerDocument.createElement('div');
  let linkCount = 0;

  layer.className = 'annotationLayer pdf-annotation-layer';
  layer.setAttribute('aria-label', 'PDF links');

  for (const annotation of annotations) {
    if (
      annotation.subtype !== 'Link' ||
      !Array.isArray(annotation.rect) ||
      annotation.rect.length !== 4 ||
      !annotation.rect.every((value) => typeof value === 'number' && Number.isFinite(value))
    ) {
      continue;
    }

    const externalUrl = safeExternalUrl(annotation.url);
    const internalPage = externalUrl
      ? null
      : await destinationPageNumber(document, annotation.dest).catch(() => null);

    if (!externalUrl && internalPage === null) {
      continue;
    }

    const link = pageElement.ownerDocument.createElement('a');
    const annotationLabel =
      annotationText(annotation.contentsObj) || annotationText(annotation.titleObj);

    link.className = 'pdf-annotation-link';
    positionLink(link, annotation.rect, viewport);

    if (externalUrl) {
      const hostname = new URL(externalUrl).hostname;
      link.href = externalUrl;
      link.title = annotationLabel || externalUrl;
      link.setAttribute('aria-label', annotationLabel || `Open ${hostname}`);
      link.dataset.externalUrl = externalUrl;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        void Promise.resolve(callbacks.onExternalLink(externalUrl)).catch(callbacks.onError);
      });
    } else if (internalPage !== null) {
      link.href = `#page=${internalPage}`;
      link.title = annotationLabel || `Go to page ${internalPage}`;
      link.setAttribute('aria-label', annotationLabel || `Go to page ${internalPage}`);
      link.dataset.internalPage = String(internalPage);
      link.addEventListener('click', (event) => {
        event.preventDefault();
        callbacks.onInternalLink(internalPage);
      });
    }

    layer.append(link);
    linkCount += 1;
  }

  if (linkCount > 0) {
    pageElement.append(layer);
  }

  return linkCount;
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
    const rangeRect =
      selection.rangeCount > 0 ? selection.getRangeAt(0).getBoundingClientRect() : null;

    onSelection({
      text: selectedText,
      sentence: sentenceForSelection(pageSegments, selectedText),
      pageNumber,
      anchorRect: rangeRect
        ? {
            left: rangeRect.left,
            top: rangeRect.top,
            right: rangeRect.right,
            bottom: rangeRect.bottom,
          }
        : undefined,
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
  private removeSelectionListeners: Array<() => void> = [];
  private renderGeneration = 0;

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
  ): Promise<PdfPageResult> {
    const document = this.document;

    if (!document) {
      throw new Error('Open a PDF before rendering a page.');
    }

    this.cancelPageRender();
    const renderGeneration = this.renderGeneration;
    container.replaceChildren();
    container.classList.remove('pdf-document-container--continuous');

    try {
      return await this.renderPageInto(container, pageNumber, scale, renderGeneration);
    } catch (error) {
      if (error instanceof RenderingCancelledException) {
        throw error;
      }

      const readerError = asError(error);
      this.callbacks.onError(readerError);
      throw readerError;
    }
  }

  async renderDocument(container: HTMLElement, scale: number): Promise<PdfDocumentResult> {
    const document = this.document;

    if (!document) {
      throw new Error('Open a PDF before rendering its pages.');
    }

    this.cancelPageRender();
    const renderGeneration = this.renderGeneration;
    container.replaceChildren();
    container.classList.add('pdf-document-container--continuous');

    try {
      const pages: PdfPageResult[] = [];

      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        pages.push(await this.renderPageInto(container, pageNumber, scale, renderGeneration));
      }

      return {
        pageCount: document.numPages,
        hasText: pages.some((page) => page.hasText),
        pages,
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
    this.renderGeneration += 1;
    this.renderTask?.cancel();
    this.textLayer?.cancel();
    for (const removeSelectionListener of this.removeSelectionListeners) {
      removeSelectionListener();
    }
    this.renderTask = null;
    this.textLayer = null;
    this.removeSelectionListeners = [];
    this.callbacks.onSelection(null);
  }

  private async renderPageInto(
    container: HTMLElement,
    pageNumber: number,
    scale: number,
    renderGeneration: number,
  ): Promise<PdfPageResult> {
    const document = this.document;

    if (!document) {
      throw new Error('Open a PDF before rendering a page.');
    }

    const safePageNumber = Math.min(Math.max(1, pageNumber), document.numPages);
    const page = await document.getPage(safePageNumber);

    if (renderGeneration !== this.renderGeneration) {
      throw renderingCancelledError(safePageNumber);
    }

    const viewport = page.getViewport({ scale });
    const outputScale = Math.min(globalThis.devicePixelRatio || 1, 2);
    const pageElement = container.ownerDocument.createElement('div');
    const canvas = container.ownerDocument.createElement('canvas');
    const textLayerElement = container.ownerDocument.createElement('div');

    pageElement.className = 'pdf-page';
    pageElement.dataset.pageNumber = String(safePageNumber);
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

    const renderTask = page.render({
      canvas,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    this.renderTask = renderTask;

    const textContent = await page.getTextContent();
    await renderTask.promise;

    if (renderGeneration !== this.renderGeneration) {
      throw renderingCancelledError(safePageNumber);
    }

    if (this.renderTask === renderTask) {
      this.renderTask = null;
    }

    const textItems = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .map(normalizedText)
      .filter(Boolean);
    const pageText = textItems.join(' ');
    const hasText = pageText.length > 0;

    if (hasText) {
      const textLayer = new TextLayer({
        textContentSource: textContent,
        container: textLayerElement,
        viewport,
      });
      this.textLayer = textLayer;
      await textLayer.render();

      if (renderGeneration !== this.renderGeneration) {
        throw renderingCancelledError(safePageNumber);
      }

      if (this.textLayer === textLayer) {
        this.textLayer = null;
      }

      this.removeSelectionListeners.push(
        listenForSelection(textLayerElement, textItems, safePageNumber, this.callbacks.onSelection),
      );
    }

    const linkCount = await renderLinkAnnotations(
      document,
      page,
      viewport,
      pageElement,
      this.callbacks,
    );

    if (renderGeneration !== this.renderGeneration) {
      throw renderingCancelledError(safePageNumber);
    }

    return {
      pageNumber: safePageNumber,
      pageCount: document.numPages,
      hasText,
      linkCount,
      width: viewport.width,
      height: viewport.height,
    };
  }
}
