import { useEffect, useState } from 'react';

import {
  WordNetProvider,
  type DictionaryResult,
  type WordNetPartOfSpeech,
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
}

export interface WordCardDraft {
  readonly term: string;
  readonly normalizedTerm: string;
  readonly partOfSpeech: WordNetPartOfSpeech;
  readonly definition: string;
  readonly rootOrEtymology: string | null;
  readonly dictionarySource: string;
  readonly sourceSentence: string;
}

const wordNet = new WordNetProvider();

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
}: SelectionToolsProps) {
  const selectedText = selection?.text.trim() ?? '';
  const canUseDictionary = isSingleWord(selectedText);
  const [result, setResult] = useState<DictionaryResult | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(selectedText && canUseDictionary));
  const [error, setError] = useState('');
  const [showTranslationConsent, setShowTranslationConsent] = useState(false);
  const [cardState, setCardState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    let isActive = true;

    if (!selectedText || !canUseDictionary) {
      return;
    }

    void wordNet
      .lookup(selectedText)
      .then((nextResult) => {
        if (isActive) {
          setResult(nextResult);
          setIsLoading(false);
        }
      })
      .catch((lookupError: unknown) => {
        if (isActive) {
          setError(lookupError instanceof Error ? lookupError.message : String(lookupError));
          setIsLoading(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [canUseDictionary, selectedText]);

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
    const primarySense = result?.senses[0];

    if (!result || !primarySense) {
      return;
    }

    setCardState('saving');

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
      setCardState('saved');
    } catch {
      setCardState('error');
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

  return (
    <div className="selection-inspector dictionary-panel" aria-live="polite">
      <div className="dictionary-heading">
        <div>
          <p className="reader-setting-title">{t('localDictionary')}</p>
          <p className="selection-word">{selectedText}</p>
        </div>
        <span className="dictionary-language">EN · EN</span>
      </div>

      <p className="selection-sentence">{selection.sentence}</p>

      {isLoading ? <p className="dictionary-status">{t('lookingUpWord')}</p> : null}
      {error ? <p className="dictionary-error">{t('dictionaryUnavailable')}</p> : null}
      {!canUseDictionary ? (
        <p className="dictionary-status">{t('localTranslationUnavailable')}</p>
      ) : null}
      {canUseDictionary && !isLoading && !error && !result ? (
        <p className="dictionary-status">{t('noDictionaryEntry')}</p>
      ) : null}

      {result ? (
        <>
          <ol className="dictionary-senses">
            {result.senses.slice(0, 6).map((sense, index) => (
              <li key={`${sense.partOfSpeech}-${sense.definition}`}>
                <span className="part-of-speech">
                  {index + 1}. {t(partOfSpeechKey(sense.partOfSpeech))}
                </span>
                <p>{sense.definition}</p>
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
          {cardState === 'error' ? (
            <p className="dictionary-error" role="alert">
              {t('cardSaveFailed')}
            </p>
          ) : null}
        </>
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

function partOfSpeechKey(partOfSpeech: WordNetPartOfSpeech): MessageKey {
  const keys: Record<WordNetPartOfSpeech, MessageKey> = {
    noun: 'noun',
    verb: 'verb',
    adjective: 'adjective',
    adverb: 'adverb',
  };
  return keys[partOfSpeech];
}
