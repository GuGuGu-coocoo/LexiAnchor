import { lazy, Suspense, useEffect, useRef, useState } from 'react';

import {
  defaultReaderPreferences,
  type ReaderLocator,
  type ReaderPreferences,
  type ReaderSelection,
  type ReaderSource,
} from '@lexianchor/reader-core';
import { EpubJsReaderEngine } from '@lexianchor/reader-epub';
import type { MessageKey } from '@lexianchor/i18n';

const PdfReaderPage = lazy(async () => {
  const module = await import('./pdf-reader-page');
  return { default: module.PdfReaderPage };
});

interface ReaderPageProps {
  readonly source: ReaderSource;
  readonly t: (key: MessageKey) => string;
  readonly onClose: () => void;
}

function storageKey(source: ReaderSource): string {
  return `lexianchor:epub-location:${source.name}`;
}

function readLocator(source: ReaderSource): ReaderLocator | undefined {
  const stored = globalThis.localStorage?.getItem(storageKey(source));

  if (!stored) {
    return undefined;
  }

  try {
    return JSON.parse(stored) as ReaderLocator;
  } catch {
    return undefined;
  }
}

function readerColors(): Pick<ReaderPreferences, 'foreground' | 'background'> {
  const styles = globalThis.getComputedStyle(document.documentElement);
  return {
    foreground: styles.getPropertyValue('--text').trim() || '#20211f',
    background: styles.getPropertyValue('--surface-raised').trim() || '#faf9f6',
  };
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

function EpubReaderPage({ source, t, onClose }: ReaderPageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<EpubJsReaderEngine | null>(null);
  const [preferences, setPreferences] = useState<ReaderPreferences>(() => ({
    ...defaultReaderPreferences,
    ...readerColors(),
  }));
  const initialPreferencesRef = useRef(preferences);
  const [locator, setLocator] = useState<ReaderLocator>();
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    let isActive = true;
    const engine = new EpubJsReaderEngine({
      onLocationChange: (nextLocator) => {
        if (!isActive) {
          return;
        }

        setLocator(nextLocator);
        globalThis.localStorage?.setItem(storageKey(source), JSON.stringify(nextLocator));
      },
      onSelection: (nextSelection) => isActive && setSelection(nextSelection),
      onError: (readerError) => isActive && setError(readerError.message),
    });
    engineRef.current = engine;
    container.replaceChildren();
    setIsLoading(true);
    setError('');

    void engine
      .open(container, source, readLocator(source))
      .then(() => engine.setPreferences(initialPreferencesRef.current))
      .then(() => isActive && setIsLoading(false))
      .catch(() => isActive && setIsLoading(false));

    return () => {
      isActive = false;
      engineRef.current = null;
      void engine.close();
    };
  }, [source]);

  useEffect(() => {
    void engineRef.current
      ?.setPreferences(preferences)
      .catch((preferenceError: unknown) =>
        setError(
          preferenceError instanceof Error ? preferenceError.message : String(preferenceError),
        ),
      );
  }, [preferences]);

  const progress = Math.round((locator?.totalProgression ?? 0) * 100);

  function updatePreference<Key extends keyof ReaderPreferences>(
    key: Key,
    value: ReaderPreferences[Key],
  ) {
    setPreferences((current) => ({ ...current, [key]: value }));
  }

  return (
    <section className="reader-page" aria-label={t('readerExperiment')}>
      <header className="reader-toolbar">
        <button className="reader-icon-button" type="button" onClick={onClose}>
          <span aria-hidden="true">←</span>
          <span>{t('backToLibrary')}</span>
        </button>
        <div className="reader-title-group">
          <p className="reader-title">{source.name}</p>
          <p className="reader-engine-label">EPUB.js · {progress}%</p>
        </div>
        <div className="reader-toolbar-actions">
          <button
            className="reader-icon-button"
            type="button"
            onClick={() => void engineRef.current?.previous()}
          >
            <span aria-hidden="true">←</span>
            <span>{t('previousPage')}</span>
          </button>
          <button
            className="reader-icon-button"
            type="button"
            onClick={() => void engineRef.current?.next()}
          >
            <span>{t('nextPage')}</span>
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </header>

      <div className="reader-workspace">
        <aside className="reader-settings" aria-label={t('readingSettings')}>
          <div className="reader-setting-group">
            <p className="reader-setting-title">{t('readerExperiment')}</p>
            <p className="reader-setting-copy">{t('readerExperimentBody')}</p>
          </div>

          <label className="reader-toggle">
            <span>
              <strong>{t('focusMode')}</strong>
              <small>{t('focusModeDescription')}</small>
            </span>
            <input
              type="checkbox"
              checked={preferences.focusMode}
              onChange={(event) => updatePreference('focusMode', event.target.checked)}
            />
          </label>

          <label className="reader-control">
            <span>{t('readingLayout')}</span>
            <select
              value={preferences.flow}
              onChange={(event) =>
                updatePreference('flow', event.target.value as ReaderPreferences['flow'])
              }
            >
              <option value="paginated">{t('pageMode')}</option>
              <option value="scrolled">{t('scrollMode')}</option>
            </select>
          </label>

          <label className="reader-control">
            <span>
              {t('fontSize')} <output>{preferences.fontSizePercent}%</output>
            </span>
            <input
              type="range"
              min="80"
              max="180"
              step="5"
              value={preferences.fontSizePercent}
              onChange={(event) => updatePreference('fontSizePercent', Number(event.target.value))}
            />
          </label>

          <label className="reader-control">
            <span>
              {t('lineHeight')} <output>{preferences.lineHeight.toFixed(2)}</output>
            </span>
            <input
              type="range"
              min="1.2"
              max="2.2"
              step="0.05"
              value={preferences.lineHeight}
              onChange={(event) => updatePreference('lineHeight', Number(event.target.value))}
            />
          </label>

          <label className="reader-control">
            <span>
              {t('wordSpacing')} <output>{preferences.wordSpacingEm.toFixed(2)} em</output>
            </span>
            <input
              type="range"
              min="0"
              max="0.5"
              step="0.05"
              value={preferences.wordSpacingEm}
              onChange={(event) => updatePreference('wordSpacingEm', Number(event.target.value))}
            />
          </label>

          <div className="selection-inspector" aria-live="polite">
            <p className="reader-setting-title">{t('selectedText')}</p>
            {selection ? (
              <>
                <p className="selection-word">{selection.text}</p>
                <p className="selection-sentence">{selection.sentence}</p>
              </>
            ) : (
              <p className="reader-setting-copy">{t('selectionHint')}</p>
            )}
          </div>
        </aside>

        <div className="reader-stage">
          {isLoading ? <p className="reader-status">{t('loadingBook')}</p> : null}
          {error ? (
            <div className="reader-error" role="alert">
              <strong>{t('readerError')}</strong>
              <span>{error}</span>
            </div>
          ) : null}
          <div ref={containerRef} className="epub-container" data-testid="epub-container" />
        </div>
      </div>
    </section>
  );
}
