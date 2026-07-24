import { useEffect, useRef, useState } from 'react';

import type { Locale, MessageKey } from '@lexianchor/i18n';
import type { DictionaryProvider } from '@lexianchor/dictionary';
import type { ReaderLocator, ReaderSelection, ReaderSource } from '@lexianchor/reader-core';
import {
  PdfJsReaderEngine,
  type PdfDocumentInfo,
  type PdfPageResult,
} from '@lexianchor/reader-pdf';

import { SelectionTools, type WordCardDraft } from './selection-tools';

interface PdfReaderPageProps {
  readonly source: ReaderSource;
  readonly initialLocator?: ReaderLocator;
  readonly locale: Locale;
  readonly t: (key: MessageKey) => string;
  readonly onClose: () => void;
  readonly onLocationChange?: (locator: ReaderLocator, percentage: number) => void;
  readonly onOpenExternal: (url: string) => Promise<void>;
  readonly onAddWordCard: (draft: WordCardDraft) => Promise<void>;
  readonly dictionaryProviders: readonly DictionaryProvider[];
}

interface StoredPdfView {
  readonly pageNumber: number;
  readonly scale: number;
}

function storageKey(source: ReaderSource): string {
  return `lexianchor:pdf-view:${source.name}`;
}

function readStoredView(source: ReaderSource, initialLocator?: ReaderLocator): StoredPdfView {
  const stored = globalThis.localStorage?.getItem(storageKey(source));

  if (!stored) {
    return { pageNumber: initialLocator?.pageNumber ?? 1, scale: 1.15 };
  }

  try {
    const view = JSON.parse(stored) as Partial<StoredPdfView>;
    return {
      pageNumber: Math.max(1, Math.floor(initialLocator?.pageNumber ?? view.pageNumber ?? 1)),
      scale: Math.min(2, Math.max(0.75, view.scale ?? 1.15)),
    };
  } catch {
    return { pageNumber: 1, scale: 1.15 };
  }
}

export function PdfReaderPage({
  source,
  initialLocator,
  locale,
  t,
  onClose,
  onLocationChange,
  onOpenExternal,
  onAddWordCard,
  dictionaryProviders,
}: PdfReaderPageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PdfJsReaderEngine | null>(null);
  const [initialView] = useState(() => readStoredView(source, initialLocator));
  const [documentInfo, setDocumentInfo] = useState<PdfDocumentInfo>();
  const [pageResult, setPageResult] = useState<PdfPageResult>();
  const [pageNumber, setPageNumber] = useState(initialView.pageNumber);
  const [scale, setScale] = useState(initialView.scale);
  const [focusMode, setFocusMode] = useState(false);
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let isActive = true;
    const engine = new PdfJsReaderEngine({
      onSelection: (nextSelection) => isActive && setSelection(nextSelection),
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

    if (!container || !engine || !documentInfo) {
      return;
    }

    let isActive = true;

    void engine
      .renderPage(container, pageNumber, scale, focusMode)
      .then((result) => {
        if (!isActive) {
          return;
        }

        setPageResult(result);
        setPageNumber(result.pageNumber);
        setIsLoading(false);
        globalThis.localStorage?.setItem(
          storageKey(source),
          JSON.stringify({ pageNumber: result.pageNumber, scale }),
        );
        onLocationChange?.(
          {
            href: source.name,
            pageNumber: result.pageNumber,
            progression: result.pageNumber / result.pageCount,
            totalProgression: result.pageNumber / result.pageCount,
          },
          Math.round((result.pageNumber / result.pageCount) * 100),
        );
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
  }, [documentInfo, focusMode, onLocationChange, pageNumber, scale, source]);

  const pageCount = documentInfo?.pageCount ?? 0;
  const progress = pageCount > 0 ? Math.round((pageNumber / pageCount) * 100) : 0;
  const hasText = pageResult?.hasText ?? true;

  return (
    <section className="reader-page" aria-label={t('pdfReader')}>
      <header className="reader-toolbar">
        <button
          className="reader-icon-button"
          type="button"
          aria-label={t('backToLibrary')}
          onClick={onClose}
        >
          <span aria-hidden="true">←</span>
          <span>{t('backToLibrary')}</span>
        </button>
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
            aria-label={t('previousPage')}
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
          >
            <span aria-hidden="true">←</span>
            <span>{t('previousPage')}</span>
          </button>
          <button
            className="reader-icon-button"
            type="button"
            aria-label={t('nextPage')}
            disabled={pageCount === 0 || pageNumber >= pageCount}
            onClick={() => setPageNumber((current) => Math.min(pageCount, current + 1))}
          >
            <span>{t('nextPage')}</span>
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </header>

      <div className="reader-workspace">
        <aside className="reader-settings" aria-label={t('readingSettings')}>
          <div className="reader-setting-group">
            <p className="reader-setting-title">{t('pdfReader')}</p>
            <p className="reader-setting-copy">{t('pdfReaderDescription')}</p>
          </div>

          <label className="reader-toggle" aria-disabled={!hasText}>
            <span>
              <strong>{t('focusMode')}</strong>
              <small>{hasText ? t('pdfFocusDescription') : t('imageOnlyDescription')}</small>
            </span>
            <input
              type="checkbox"
              checked={focusMode && hasText}
              disabled={!hasText}
              onChange={(event) => setFocusMode(event.target.checked)}
            />
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
              onChange={(event) =>
                setPageNumber(
                  Math.min(pageCount || 1, Math.max(1, Number(event.target.value) || 1)),
                )
              }
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

          <SelectionTools
            key={selection?.text ?? 'empty'}
            selection={selection}
            emptyHint={hasText ? t('pdfSelectionHint') : t('imageOnlyDescription')}
            locale={locale}
            t={t}
            onOpenExternal={onOpenExternal}
            onAddWordCard={onAddWordCard}
            providers={dictionaryProviders}
          />
        </aside>

        <div className="reader-stage pdf-reader-stage">
          {isLoading ? <p className="reader-status">{t('loadingBook')}</p> : null}
          {error ? (
            <div className="reader-error" role="alert">
              <strong>{t('readerError')}</strong>
              <span>{error}</span>
            </div>
          ) : null}
          <div ref={containerRef} className="pdf-document-container" data-testid="pdf-container" />
        </div>
      </div>
    </section>
  );
}
