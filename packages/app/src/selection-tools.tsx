import { useEffect, useRef, useState } from 'react';

import {
  type DictionaryPartOfSpeech,
  type DictionaryProvider,
  type DictionaryResult,
} from '@lexianchor/dictionary';
import type { Locale, MessageKey } from '@lexianchor/i18n';
import type { ReaderSelection } from '@lexianchor/reader-core';
import type {
  BergamotTranslationProvider,
  LocalTranslationResult,
  TranslationTargetLanguage,
} from '@lexianchor/translation';

import { isSingleWord, normalizeSelectionText } from './selection-text';

interface SelectionToolsProps {
  readonly selection: ReaderSelection | null;
  readonly emptyHint: string;
  readonly compact?: boolean;
  readonly locale: Locale;
  readonly t: (key: MessageKey) => string;
  readonly onOpenExternal: (url: string) => Promise<void>;
  readonly onAddWordCard: (draft: WordCardDraft) => Promise<void>;
  readonly providers: readonly DictionaryProvider[];
  readonly localTranslationProvider: BergamotTranslationProvider;
  readonly installedTranslationTargets: readonly TranslationTargetLanguage[];
  readonly onDismiss?: () => void;
}

export interface WordCardDraft {
  readonly term: string;
  readonly normalizedTerm: string;
  readonly partOfSpeech: DictionaryPartOfSpeech;
  readonly definition: string;
  readonly definitions: readonly string[];
  readonly rootOrEtymology: string | null;
  readonly dictionarySource: string;
  readonly sourceSentence: string;
}

interface LookupState {
  readonly term: string;
  readonly results: readonly DictionaryResult[];
  readonly error: string;
}

interface LocalTranslationState {
  readonly text: string;
  readonly targetLanguage: TranslationTargetLanguage;
  readonly status: 'idle' | 'translating' | 'translated' | 'error';
  readonly result: LocalTranslationResult | null;
  readonly error: string;
}

function searchUrl(text: string): string {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', text);
  return url.href;
}

function translationUrl(text: string, targetLanguage: TranslationTargetLanguage): string {
  const url = new URL('https://translate.google.com/');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', targetLanguage === 'zh' ? 'zh-CN' : 'fr');
  url.searchParams.set('text', text);
  url.searchParams.set('op', 'translate');
  return url.href;
}

export function SelectionTools({
  selection,
  emptyHint,
  compact = false,
  locale,
  t,
  onOpenExternal,
  onAddWordCard,
  providers,
  localTranslationProvider,
  installedTranslationTargets,
  onDismiss,
}: SelectionToolsProps) {
  const selectedText = normalizeSelectionText(selection?.text ?? '');
  const canUseDictionary = isSingleWord(selectedText);
  const [lookupState, setLookupState] = useState<LookupState>({
    term: '',
    results: [],
    error: '',
  });
  const [showTranslationConsent, setShowTranslationConsent] = useState(false);
  const [translationTarget, setTranslationTarget] = useState<TranslationTargetLanguage>(() => {
    const stored = globalThis.localStorage?.getItem('lexianchor:translation-target');
    return stored === 'fr' || stored === 'zh' ? stored : locale === 'fr' ? 'fr' : 'zh';
  });
  const [localTranslation, setLocalTranslation] = useState<LocalTranslationState>({
    text: '',
    targetLanguage: translationTarget,
    status: 'idle',
    result: null,
    error: '',
  });
  const translationAbort = useRef<AbortController | null>(null);
  const [cardSaveState, setCardSaveState] = useState<{
    readonly term: string;
    readonly status: 'saving' | 'saved' | 'error';
  } | null>(null);
  const results = lookupState.term === selectedText ? lookupState.results : [];
  const error = lookupState.term === selectedText ? lookupState.error : '';
  const isLoading = Boolean(selectedText && canUseDictionary) && lookupState.term !== selectedText;
  const cardState = cardSaveState?.term === selectedText ? cardSaveState.status : ('idle' as const);
  const activeTranslation =
    localTranslation.text === selectedText && localTranslation.targetLanguage === translationTarget
      ? localTranslation
      : null;
  const localModelInstalled = installedTranslationTargets.includes(translationTarget);

  useEffect(() => {
    let isActive = true;

    if (!selectedText || !canUseDictionary) {
      return;
    }

    void Promise.allSettled(providers.map((provider) => provider.lookup(selectedText))).then(
      (settled) => {
        if (isActive) {
          const nextResults = settled.flatMap((item) =>
            item.status === 'fulfilled' && item.value ? [item.value] : [],
          );
          setLookupState({
            term: selectedText,
            results: nextResults,
            error:
              settled.length > 0 && settled.every((item) => item.status === 'rejected')
                ? t('dictionaryUnavailable')
                : '',
          });
        }
      },
    );

    return () => {
      isActive = false;
    };
  }, [canUseDictionary, providers, selectedText, t]);

  useEffect(() => {
    globalThis.localStorage?.setItem('lexianchor:translation-target', translationTarget);
    translationAbort.current?.abort();
    translationAbort.current = null;

    return () => {
      translationAbort.current?.abort();
      translationAbort.current = null;
    };
  }, [selectedText, translationTarget]);

  async function openTranslation() {
    const consentKey = 'lexianchor:external-consent:google-translate';

    if (globalThis.localStorage?.getItem(consentKey) !== 'granted') {
      setShowTranslationConsent(true);
      return;
    }

    await onOpenExternal(translationUrl(selectedText, translationTarget));
  }

  async function confirmTranslation() {
    globalThis.localStorage?.setItem('lexianchor:external-consent:google-translate', 'granted');
    setShowTranslationConsent(false);
    await onOpenExternal(translationUrl(selectedText, translationTarget));
  }

  async function translateLocally() {
    const controller = new AbortController();
    translationAbort.current?.abort();
    translationAbort.current = controller;
    setLocalTranslation({
      text: selectedText,
      targetLanguage: translationTarget,
      status: 'translating',
      result: null,
      error: '',
    });

    try {
      const result = await localTranslationProvider.translate(
        selectedText,
        translationTarget,
        controller.signal,
      );
      setLocalTranslation({
        text: selectedText,
        targetLanguage: translationTarget,
        status: 'translated',
        result,
        error: '',
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setLocalTranslation({
          text: selectedText,
          targetLanguage: translationTarget,
          status: 'error',
          result: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (translationAbort.current === controller) {
        translationAbort.current = null;
      }
    }
  }

  async function addWordCard() {
    const result = results.find((candidate) => candidate.source.languages[1] === 'en');
    const primarySense = result?.senses[0];

    if (!result || !primarySense) {
      return;
    }

    setCardSaveState({ term: selectedText, status: 'saving' });

    try {
      const definitions = [
        ...new Set(result.senses.map((sense) => sense.definition.trim()).filter(Boolean)),
      ].slice(0, 6);
      await onAddWordCard({
        term: selectedText,
        normalizedTerm: result.lemma.toLocaleLowerCase('en-US'),
        partOfSpeech: primarySense.partOfSpeech,
        definition: primarySense.definition,
        definitions,
        rootOrEtymology: result.rootOrEtymology,
        dictionarySource: `${result.source.name} ${result.source.version}`,
        sourceSentence: selection?.sentence ?? '',
      });
      setCardSaveState({ term: selectedText, status: 'saved' });
    } catch {
      setCardSaveState({ term: selectedText, status: 'error' });
    }
  }

  if (!selection) {
    return (
      <div className="selection-inspector" aria-live="polite">
        <p className="reader-setting-title">{t('selectedText')}</p>
        <p className="reader-setting-copy">{emptyHint}</p>
      </div>
    );
  }

  const cardResult = results.find((candidate) => candidate.source.languages[1] === 'en');
  const translationPanel = (
    <section className="local-translation-panel" aria-labelledby="local-translation-title">
      <div className="local-translation-heading">
        <strong id="local-translation-title">{t('localTranslation')}</strong>
        <label>
          <span className="sr-only">{t('translationTarget')}</span>
          <select
            value={translationTarget}
            onChange={(event) =>
              setTranslationTarget(event.target.value as TranslationTargetLanguage)
            }
          >
            <option value="zh">{t('simplifiedChinese')}</option>
            <option value="fr">{t('french')}</option>
          </select>
        </label>
      </div>

      {localModelInstalled ? (
        <button
          className="dictionary-action local-translation-action"
          type="button"
          disabled={selectedText.length > 2_000 || activeTranslation?.status === 'translating'}
          onClick={() => void translateLocally()}
        >
          {activeTranslation?.status === 'translating'
            ? t('translatingLocally')
            : t('translateLocally')}
        </button>
      ) : (
        <p className="dictionary-status">{t('localModelNotInstalled')}</p>
      )}

      {selectedText.length > 2_000 ? (
        <p className="dictionary-error">{t('translationSelectionTooLong')}</p>
      ) : null}
      {activeTranslation?.result ? (
        <div className="local-translation-result">
          <p>{activeTranslation.result.translatedText}</p>
          <span>{activeTranslation.result.model.attribution}</span>
        </div>
      ) : null}
      {activeTranslation?.status === 'error' ? (
        <p className="dictionary-error">{activeTranslation.error}</p>
      ) : null}
    </section>
  );

  return (
    <div
      className={`selection-inspector dictionary-panel${compact ? ' selection-inspector--compact' : ''}`}
      aria-live="polite"
    >
      <div className="dictionary-heading">
        <div>
          <p className="reader-setting-title">{t('localDictionary')}</p>
          <p className="selection-word">{selectedText}</p>
        </div>
        {onDismiss ? (
          <button
            className="selection-dismiss"
            type="button"
            aria-label={t('dismissSelection')}
            onClick={onDismiss}
          >
            ×
          </button>
        ) : null}
      </div>

      <p className="selection-sentence">{selection.sentence}</p>

      {isLoading ? <p className="dictionary-status">{t('lookingUpWord')}</p> : null}
      {error ? <p className="dictionary-error">{error}</p> : null}
      {canUseDictionary && !isLoading && !error && results.length === 0 ? (
        <p className="dictionary-status">{t('noDictionaryEntry')}</p>
      ) : null}

      {results.map((result) => (
        <article className="dictionary-result" key={result.source.id}>
          <div className="dictionary-source-heading">
            <strong>{result.source.name}</strong>
            <span className="dictionary-language">
              {result.source.languages.map((language) => language.toUpperCase()).join(' → ')}
            </span>
          </div>
          <ol className="dictionary-senses">
            {result.senses.slice(0, 6).map((sense, index) => (
              <li key={`${sense.partOfSpeech}-${sense.definition}`}>
                <span className="part-of-speech">
                  {index + 1}. {t(partOfSpeechKey(sense.partOfSpeech))}
                </span>
                {sense.pronunciation ? (
                  <span className="dictionary-pronunciation">/{sense.pronunciation}/</span>
                ) : null}
                <p>
                  {sense.translations?.length ? (
                    <>
                      <strong className="dictionary-translation-label">
                        {t(translationKey(result.source.languages[1]))}:
                      </strong>{' '}
                      {sense.translations.join(', ')}
                    </>
                  ) : (
                    sense.definition
                  )}
                </p>
                {sense.englishDefinitions?.[0] ? (
                  <p className="dictionary-detail">
                    <strong>{t('englishDefinition')}:</strong>{' '}
                    {sense.englishDefinitions.slice(0, 2).join(' · ')}
                  </p>
                ) : null}
                {sense.synonyms.length > 1 ? (
                  <p className="dictionary-detail">
                    <strong>{t('synonyms')}:</strong> {sense.synonyms.join(', ')}
                  </p>
                ) : null}
                {sense.examples[0] ? (
                  <p className="dictionary-example">“{sense.examples[0]}”</p>
                ) : null}
              </li>
            ))}
          </ol>
          <p className="dictionary-attribution">{result.source.attribution}</p>
        </article>
      ))}

      {cardResult ? (
        <button
          className="add-card-action"
          type="button"
          disabled={cardState === 'saving' || cardState === 'saved'}
          onClick={() => void addWordCard()}
        >
          {cardState === 'saving'
            ? t('savingCard')
            : cardState === 'saved'
              ? t('savedToCards')
              : t('addToCards')}
        </button>
      ) : null}
      {cardState === 'error' ? (
        <p className="dictionary-error" role="alert">
          {t('cardSaveFailed')}
        </p>
      ) : null}

      {translationPanel}

      {compact ? null : (
        <div className="selection-actions">
          <button
            className="dictionary-action"
            type="button"
            onClick={() => void openTranslation()}
          >
            {t('onlineTranslation')}
          </button>
          <button
            className="dictionary-action"
            type="button"
            onClick={() => void onOpenExternal(searchUrl(selectedText))}
          >
            {t('searchOnWeb')}
          </button>
        </div>
      )}

      {showTranslationConsent ? (
        <div className="external-consent" role="alert">
          <p>
            {t('externalTranslationNotice')} “{selectedText}”
          </p>
          <div>
            <button type="button" onClick={() => setShowTranslationConsent(false)}>
              {t('cancel')}
            </button>
            <button type="button" onClick={() => void confirmTranslation()}>
              {t('continueExternal')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function partOfSpeechKey(partOfSpeech: DictionaryPartOfSpeech): MessageKey {
  const keys: Record<DictionaryPartOfSpeech, MessageKey> = {
    noun: 'noun',
    verb: 'verb',
    adjective: 'adjective',
    adverb: 'adverb',
    unknown: 'unknownPartOfSpeech',
  };
  return keys[partOfSpeech];
}

function translationKey(targetLanguage: string): MessageKey {
  return targetLanguage === 'zh' ? 'chineseTranslation' : 'frenchTranslation';
}
