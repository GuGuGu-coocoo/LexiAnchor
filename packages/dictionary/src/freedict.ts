import manifest from '../resources/freedict-eng-fra.manifest.json';

import {
  morphologyCandidates,
  normalizeLookupTerm,
  type DictionaryPartOfSpeech,
  type WordNetSense,
} from './parser';
import type { DictionaryProvider, DictionaryResult, DictionarySource } from './wordnet';

interface FreeDictEntry {
  readonly term: string;
  readonly pronunciation: string | null;
  readonly partOfSpeech: DictionaryPartOfSpeech;
  readonly translations: readonly string[];
}

export interface DictionaryAssetStore {
  get(id: string): Promise<string | null>;
  put(id: string, content: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface FreeDictInstallStatus {
  readonly installed: boolean;
  readonly size: number;
}

export interface FreeDictResource {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly languages: readonly [string, string];
  readonly license: string;
  readonly attribution: string;
  readonly downloadUrl: string;
  readonly size: number;
  readonly sha256: string;
}

export const freeDictEnglishFrenchResource: FreeDictResource = {
  id: manifest.id,
  name: 'FreeDict English–French',
  version: manifest.version,
  languages: ['en', 'fr'],
  license: manifest.license.name,
  attribution: manifest.attribution,
  downloadUrl: manifest.distribution.downloadUrl,
  size: manifest.distribution.size,
  sha256: manifest.distribution.sha256,
};

const source: DictionarySource = {
  id: freeDictEnglishFrenchResource.id,
  name: freeDictEnglishFrenchResource.name,
  version: freeDictEnglishFrenchResource.version,
  languages: freeDictEnglishFrenchResource.languages,
  license: freeDictEnglishFrenchResource.license,
  attribution: freeDictEnglishFrenchResource.attribution,
};

function decodeXmlText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f\d]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function firstTag(body: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(body);
  return match?.[1] ? decodeXmlText(match[1]) : null;
}

function partOfSpeech(body: string): DictionaryPartOfSpeech {
  const value = firstTag(body, 'pos')?.toLocaleLowerCase('en-US');
  const names: Readonly<Record<string, DictionaryPartOfSpeech>> = {
    n: 'noun',
    noun: 'noun',
    v: 'verb',
    verb: 'verb',
    adj: 'adjective',
    adjective: 'adjective',
    adv: 'adverb',
    adverb: 'adverb',
  };
  return value ? (names[value] ?? 'unknown') : 'unknown';
}

export function parseFreeDictTei(xml: string): ReadonlyMap<string, readonly FreeDictEntry[]> {
  if (!xml.includes('<TEI') || !xml.includes('<entry')) {
    throw new Error('The downloaded FreeDict resource is not valid TEI dictionary data.');
  }

  const entries = new Map<string, FreeDictEntry[]>();

  for (const match of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)) {
    const body = match[1] ?? '';
    const term = firstTag(body, 'orth');

    if (!term) {
      continue;
    }

    const translations = [...body.matchAll(/<quote(?:\s[^>]*)?>([\s\S]*?)<\/quote>/gi)]
      .map((quote) => decodeXmlText(quote[1] ?? ''))
      .filter(Boolean);

    if (translations.length === 0) {
      continue;
    }

    const key = normalizeLookupTerm(term);
    const current = entries.get(key) ?? [];
    current.push({
      term,
      pronunciation: firstTag(body, 'pron'),
      partOfSpeech: partOfSpeech(body),
      translations: [...new Set(translations)],
    });
    entries.set(key, current);
  }

  if (entries.size === 0) {
    throw new Error('The FreeDict resource contains no readable entries.');
  }

  return entries;
}

async function sha256(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function dictionaryDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const appDirectory = await root.getDirectoryHandle('lexianchor', { create: true });
  return appDirectory.getDirectoryHandle('dictionaries', { create: true });
}

export class OpfsDictionaryAssetStore implements DictionaryAssetStore {
  async get(id: string): Promise<string | null> {
    try {
      const directory = await dictionaryDirectory();
      const handle = await directory.getFileHandle(`${id}.tei`);
      return (await handle.getFile()).text();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return null;
      }
      throw error;
    }
  }

  async put(id: string, content: string): Promise<void> {
    const directory = await dictionaryDirectory();
    const handle = await directory.getFileHandle(`${id}.tei`, { create: true });
    const writer = await handle.createWritable();

    try {
      await writer.write(content);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const directory = await dictionaryDirectory();
      await directory.removeEntry(`${id}.tei`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
        throw error;
      }
    }
  }
}

export class FreeDictEnglishFrenchProvider implements DictionaryProvider {
  readonly source: DictionarySource;
  private entries: ReadonlyMap<string, readonly FreeDictEntry[]> | null = null;

  constructor(
    private readonly store: DictionaryAssetStore = new OpfsDictionaryAssetStore(),
    private readonly download: typeof fetch = fetch,
    private readonly resource: FreeDictResource = freeDictEnglishFrenchResource,
  ) {
    this.source = resource === freeDictEnglishFrenchResource ? source : resource;
  }

  async status(): Promise<FreeDictInstallStatus> {
    const content = await this.store.get(this.source.id);
    return {
      installed: content !== null,
      size: content ? new TextEncoder().encode(content).byteLength : 0,
    };
  }

  async install(): Promise<FreeDictInstallStatus> {
    const download = this.download;
    const response = await download(this.resource.downloadUrl);

    if (!response.ok) {
      throw new Error(`FreeDict download failed (${response.status}).`);
    }

    const bytes = await response.arrayBuffer();

    if (bytes.byteLength !== this.resource.size) {
      throw new Error('FreeDict download size does not match the resource manifest.');
    }

    if ((await sha256(bytes)) !== this.resource.sha256) {
      throw new Error('FreeDict download checksum does not match the resource manifest.');
    }

    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parseFreeDictTei(content);
    await this.store.put(this.source.id, content);
    this.entries = null;
    return { installed: true, size: bytes.byteLength };
  }

  async remove(): Promise<void> {
    await this.store.delete(this.source.id);
    this.entries = null;
  }

  async lookup(value: string): Promise<DictionaryResult | null> {
    const entries = await this.loadEntries();

    if (!entries) {
      return null;
    }

    for (const candidate of morphologyCandidates(normalizeLookupTerm(value))) {
      const matches = entries.get(candidate);

      if (!matches?.length) {
        continue;
      }

      const senses: WordNetSense[] = matches.map((entry) => ({
        partOfSpeech: entry.partOfSpeech,
        definition: entry.translations.join(', '),
        synonyms: [],
        examples: [],
        pronunciation: entry.pronunciation ?? undefined,
        translations: entry.translations,
      }));

      return {
        term: value.trim(),
        lemma: matches[0]?.term ?? candidate.replaceAll('_', ' '),
        senses,
        rootOrEtymology: null,
        source: this.source,
      };
    }

    return null;
  }

  private async loadEntries(): Promise<ReadonlyMap<string, readonly FreeDictEntry[]> | null> {
    if (this.entries) {
      return this.entries;
    }

    const content = await this.store.get(this.source.id);

    if (!content) {
      return null;
    }

    this.entries = parseFreeDictTei(content);
    return this.entries;
  }
}
