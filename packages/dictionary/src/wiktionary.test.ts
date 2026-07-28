import { describe, expect, it, vi } from 'vitest';

import { ExpandedEnglishDictionaryProvider, parseWiktionaryDefinitions } from './wiktionary';
import type { DictionaryProvider } from './wordnet';

const payload = {
  en: [
    {
      language: 'English',
      partOfSpeech: 'Adjective',
      definitions: [
        {
          definition: 'by <a href="/wiki/serendipity">serendipity</a>; by unexpected good fortune',
          parsedExamples: [{ example: 'A <b>serendipitous</b> discovery.' }],
        },
      ],
    },
  ],
};

describe('expanded English dictionary', () => {
  it('parses structured Wiktionary definitions into reader senses', () => {
    expect(parseWiktionaryDefinitions(payload, 'serendipitous')).toMatchObject({
      lemma: 'serendipitous',
      source: { id: 'english-wiktionary' },
      senses: [
        {
          partOfSpeech: 'adjective',
          definition: 'by serendipity; by unexpected good fortune',
          examples: ['A serendipitous discovery.'],
        },
      ],
    });
  });

  it('uses the bundled dictionary when Wiktionary is unavailable', async () => {
    const fallbackResult = {
      term: 'resilient',
      lemma: 'resilient',
      senses: [],
      rootOrEtymology: null,
      source: {
        id: 'fallback',
        name: 'Fallback',
        version: '1',
        languages: ['en', 'en'] as const,
        license: 'test',
        attribution: 'test',
      },
    };
    const fallbackLookup = vi.fn().mockResolvedValue(fallbackResult);
    const fallback: DictionaryProvider = {
      source: fallbackResult.source,
      lookup: fallbackLookup,
    };
    const provider = new ExpandedEnglishDictionaryProvider(
      vi.fn().mockRejectedValue(new Error('offline')) as typeof fetch,
      fallback,
    );

    await expect(provider.lookup('resilient')).resolves.toBe(fallbackResult);
    expect(fallbackLookup).toHaveBeenCalledWith('resilient');
  });
});
