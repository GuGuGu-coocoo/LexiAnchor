import { useEffect, useState } from 'react';

import {
  type DictionaryPartOfSpeech,
  type DictionaryProvider,
  type DictionaryResult,
} from '@lexianchor/dictionary';
import type { Locale, MessageKey } from '@lexianchor/i18n';
import type { ReaderSelection } from '@lexianchor/reader-core';

interface SelectionToolsProps {
  readonly selection: ReaderSelection | null;
  readonly emptyHint: string;
  readonly locale: Locale;
  readonly t: (key: MessageKey) => string;
  readonly onOpenExternal: (url: string) => Promise<void>;
  readonly onAddWordCard: (draft: WordCardDraft) => Promise<void>;
  readonly providers: readonly DictionaryProvider[];
}

export interface WordCardDraft {
  readonly term: string;
  readonly normalizedTerm: string;
  readonly partOfSpeech: DictionaryPartOfSpeech;
  readonly definition: string;
  readonly rootOrEtymology: string | null;
  readonly dictionarySource: string;
  readonly sourceSentence: string;
}

interface LookupState {
  readonly term: string;
  readonly results: readonly DictionaryResult[];
  readonly error: string;
}

function isSingleWord(value: string): boolean {
  return /^[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’][A-Za-zÀ-ÖØ-öø-ÿ]+)?$/.test(value.trim());
}

function searchUrl(text: string): string {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', text);
  return url.href;
}

function translationUrl(text: string, locale: Locale): string {
  const url = new URL('https://translate.google.com/');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', locale === 'zh-CN' ? 'zh-CN' : locale);
  url.searchParams.set('text', text);
  url.searchParams.set('op', 'translate');
  return url.href;
}

export function SelectionTools({
  selection,
  emptyHint,
  locale,
  t,
  onOpenExternal,
  onAddWordCard,
  providers,
}: SelectionToolsProps) {
  const selectedText = selection?.text.trim() ?? '';
  const canUseDictionary = isSingleWord(selectedText);
  const [lookupState, setLookupState] = useState<LookupState>({
    term: '',
    results: [],
    error: '',
  });
  const [showTranslationConsent, setShowTranslationConsent] = useState(false);
  const [cardSaveState, setCardSaveState] = useState<{
    readonly term: string;
    readonly status: 'saving' | 'saved' | 'error';
  } | null>(null);
  const results = lookupState.term === selectedText ? lookupState.results : [];
  const error = lookupState.term === selectedText ? lookupState.error : '';
  const isLoading = Boolean(selectedText && canUseDictionary) && lookupState.term !== selectedText;
  const cardState = cardSaveState?.term === selectedText ? cardSaveState.status : ('idle' as const);

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

  async function openTranslation() {
    const consentKey = 'lexianchor:external-consent:google-translate';

    if (globalThis.localStorage?.getItem(consentKey) !== 'granted') {
      setShowTranslationConsent(true);
      return;
    }

    await onOpenExternal(translationUrl(selectedText, locale));
  }

  async function confirmTranslation() {
    globalThis.localStorage?.setItem('lexianchor:external-consent:google-translate', 'granted');
    setShowTranslationConsent(false);
    await onOpenExternal(translationUrl(selectedText, locale));
  }

  async function addWordCard() {
    const result = results.find((candidate) => candidate.source.languages[1] === 'en');
    const primarySense = result?.senses[0];

    if (!result || !primarySense) {
      return;
    }

    setCardSaveState({ term: selectedText, status: 'saving' });

    try {
      await onAddWordCard({
        term: selectedText,
        normalizedTerm: result.lemma.toLocaleLowerCase('en-US'),
        partOfSpeech: primarySense.partOfSpeech,
        definition: primarySense.definition,
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

  return (
    <div className="selection-inspector dictionary-panel" aria-live="polite">
      <div className="dictionary-heading">
        <div>
          <p className="reader-setting-title">{t('localDictionary')}</p>
          <p className="selection-word">{selectedText}</p>
        </div>
      </div>

      <p className="selection-sentence">{selection.sentence}</p>

      {isLoading ? <p className="dictionary-status">{t('lookingUpWord')}</p> : null}
      {error ? <p className="dictionary-error">{error}</p> : null}
      {!canUseDictionary ? (
        <p className="dictionary-status">{t('localTranslationUnavailable')}</p>
      ) : null}
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

      <div className="selection-actions">
        <button className="dictionary-action" type="button" onClick={() => void openTranslation()}>
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
