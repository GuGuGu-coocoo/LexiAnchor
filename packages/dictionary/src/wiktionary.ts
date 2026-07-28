import { normalizeLookupTerm, type DictionaryPartOfSpeech, type WordNetSense } from './parser';
import {
  WordNetProvider,
  type DictionaryProvider,
  type DictionaryResult,
  type DictionarySource,
} from './wordnet';

interface WiktionaryDefinition {
  readonly definition?: unknown;
  readonly examples?: unknown;
  readonly parsedExamples?: unknown;
}

interface WiktionaryEntry {
  readonly language?: unknown;
  readonly partOfSpeech?: unknown;
  readonly definitions?: unknown;
}

const source: DictionarySource = {
  id: 'english-wiktionary',
  name: 'English Wiktionary',
  version: 'live',
  languages: ['en', 'en'],
  license: 'CC BY-SA 4.0',
  attribution: 'English Wiktionary contributors · CC BY-SA 4.0',
};

const partOfSpeechNames: Readonly<Record<string, DictionaryPartOfSpeech>> = {
  noun: 'noun',
  verb: 'verb',
  adjective: 'adjective',
  adverb: 'adverb',
};

function plainText(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function examplesFrom(definition: WiktionaryDefinition): readonly string[] {
  const examples = Array.isArray(definition.examples)
    ? definition.examples.map(plainText).filter(Boolean)
    : [];
  const parsedExamples = Array.isArray(definition.parsedExamples)
    ? definition.parsedExamples
        .map((example) =>
          typeof example === 'object' && example !== null && 'example' in example
            ? plainText((example as { readonly example?: unknown }).example)
            : '',
        )
        .filter(Boolean)
    : [];
  return [...new Set([...parsedExamples, ...examples])];
}

export function parseWiktionaryDefinitions(
  payload: unknown,
  value: string,
): DictionaryResult | null {
  if (typeof payload !== 'object' || payload === null || !('en' in payload)) {
    return null;
  }

  const entries = (payload as { readonly en?: unknown }).en;
  if (!Array.isArray(entries)) {
    return null;
  }

  const senses: WordNetSense[] = [];

  for (const entry of entries as WiktionaryEntry[]) {
    if (entry.language !== 'English' || !Array.isArray(entry.definitions)) {
      continue;
    }

    const partOfSpeech =
      typeof entry.partOfSpeech === 'string'
        ? (partOfSpeechNames[entry.partOfSpeech.toLocaleLowerCase('en-US')] ?? 'unknown')
        : 'unknown';

    for (const definition of entry.definitions as WiktionaryDefinition[]) {
      const text = plainText(definition.definition);
      if (!text) {
        continue;
      }

      senses.push({
        partOfSpeech,
        definition: text,
        synonyms: [],
        examples: examplesFrom(definition),
      });

      if (senses.length >= 12) {
        break;
      }
    }

    if (senses.length >= 12) {
      break;
    }
  }

  if (senses.length === 0) {
    return null;
  }

  return {
    term: value.trim(),
    lemma: normalizeLookupTerm(value).replaceAll('_', ' '),
    senses,
    rootOrEtymology: null,
    source,
  };
}

/**
 * Uses the substantially broader English Wiktionary when online and keeps the
 * bundled WordNet database as a transparent offline fallback.
 */
export class ExpandedEnglishDictionaryProvider implements DictionaryProvider {
  readonly source = source;

  constructor(
    private readonly download: typeof fetch = fetch,
    private readonly offlineFallback: DictionaryProvider = new WordNetProvider(),
  ) {}

  async lookup(value: string): Promise<DictionaryResult | null> {
    const term = normalizeLookupTerm(value);

    if (!term) {
      return null;
    }

    const candidate = term;

    try {
      const response = await this.download(
        `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(
          candidate.replaceAll('_', ' '),
        )}`,
        {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(3500),
        },
      );

      if (response.ok) {
        const result = parseWiktionaryDefinitions(await response.json(), value);
        if (result) {
          return { ...result, lemma: candidate.replaceAll('_', ' ') };
        }
      }
    } catch {
      // The bundled provider below keeps lookup available without a network.
    }

    return this.offlineFallback.lookup(value);
  }
}
