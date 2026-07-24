import './assets.d.ts';

import dataAdjectiveUrl from 'wordnet-db/dict/data.adj?url&no-inline';
import dataAdverbUrl from 'wordnet-db/dict/data.adv?url&no-inline';
import dataNounUrl from 'wordnet-db/dict/data.noun?url&no-inline';
import dataVerbUrl from 'wordnet-db/dict/data.verb?url&no-inline';
import indexAdjectiveUrl from 'wordnet-db/dict/index.adj?url&no-inline';
import indexAdverbUrl from 'wordnet-db/dict/index.adv?url&no-inline';
import indexNounUrl from 'wordnet-db/dict/index.noun?url&no-inline';
import indexVerbUrl from 'wordnet-db/dict/index.verb?url&no-inline';

import {
  findIndexLine,
  lineAtByteOffset,
  morphologyCandidates,
  normalizeLookupTerm,
  parseDataLine,
  parseIndexLine,
  type WordNetPartOfSpeech,
  type WordNetSense,
} from './parser';

export interface DictionarySource {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly languages: readonly ['en', 'en'];
  readonly license: string;
  readonly attribution: string;
}

export interface DictionaryResult {
  readonly term: string;
  readonly lemma: string;
  readonly senses: readonly WordNetSense[];
  readonly rootOrEtymology: null;
  readonly source: DictionarySource;
}

export interface DictionaryProvider {
  readonly source: DictionarySource;
  lookup(term: string): Promise<DictionaryResult | null>;
}

const source: DictionarySource = {
  id: 'princeton-wordnet-3.1',
  name: 'Princeton WordNet',
  version: '3.1',
  languages: ['en', 'en'],
  license: 'Princeton WordNet License',
  attribution: 'Princeton WordNet 3.1 database · © 2006 Princeton University.',
};

const assets: Readonly<
  Record<WordNetPartOfSpeech, { readonly index: string; readonly data: string }>
> = {
  noun: { index: indexNounUrl, data: dataNounUrl },
  verb: { index: indexVerbUrl, data: dataVerbUrl },
  adjective: { index: indexAdjectiveUrl, data: dataAdjectiveUrl },
  adverb: { index: indexAdverbUrl, data: dataAdverbUrl },
};

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Could not load the offline dictionary index (${response.status}).`);
  }

  return response.text();
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Could not load the offline dictionary data (${response.status}).`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

export class WordNetProvider implements DictionaryProvider {
  readonly source = source;
  private readonly indexCache = new Map<WordNetPartOfSpeech, Promise<string>>();
  private readonly dataCache = new Map<WordNetPartOfSpeech, Promise<Uint8Array>>();

  async lookup(value: string): Promise<DictionaryResult | null> {
    const term = normalizeLookupTerm(value);

    if (!term) {
      return null;
    }

    for (const candidate of morphologyCandidates(term)) {
      const senses = await this.lookupCandidate(candidate);

      if (senses.length > 0) {
        return {
          term: value.trim(),
          lemma: candidate.replaceAll('_', ' '),
          senses,
          rootOrEtymology: null,
          source,
        };
      }
    }

    return null;
  }

  private async lookupCandidate(lemma: string): Promise<WordNetSense[]> {
    const partsOfSpeech = Object.keys(assets) as WordNetPartOfSpeech[];
    const records = await Promise.all(
      partsOfSpeech.map(async (partOfSpeech) => {
        const indexText = await this.index(partOfSpeech);
        const line = findIndexLine(indexText, lemma);
        return line ? parseIndexLine(line) : null;
      }),
    );
    const senses: WordNetSense[] = [];

    for (const record of records) {
      if (!record) {
        continue;
      }

      const data = await this.data(record.partOfSpeech);

      for (const offset of record.offsets) {
        const line = lineAtByteOffset(data, offset);
        const sense = line ? parseDataLine(line) : null;

        if (sense) {
          senses.push(sense);
        }
      }
    }

    return senses;
  }

  private index(partOfSpeech: WordNetPartOfSpeech): Promise<string> {
    let pending = this.indexCache.get(partOfSpeech);

    if (!pending) {
      pending = fetchText(assets[partOfSpeech].index);
      this.indexCache.set(partOfSpeech, pending);
    }

    return pending;
  }

  private data(partOfSpeech: WordNetPartOfSpeech): Promise<Uint8Array> {
    let pending = this.dataCache.get(partOfSpeech);

    if (!pending) {
      pending = fetchBytes(assets[partOfSpeech].data);
      this.dataCache.set(partOfSpeech, pending);
    }

    return pending;
  }
}
