import { morphologyCandidates, normalizeLookupTerm, type WordNetSense } from './parser';
import type { DictionaryProvider, DictionaryResult, DictionarySource } from './wordnet';

const packageMagic = 'LEXIANCHOR-STARDICT-1\n';
const packageMagicBytes = new TextEncoder().encode(packageMagic);

export interface StarDictFiles {
  readonly ifo: string;
  readonly idx: ArrayBuffer;
  readonly dict: ArrayBuffer;
}

export interface StarDictInfo {
  readonly version: '2.4.2' | '3.0.0';
  readonly bookName: string;
  readonly wordCount: number;
  readonly indexFileSize: number;
  readonly sameTypeSequence: string | null;
  readonly author: string | null;
  readonly description: string | null;
}

interface StarDictIndexEntry {
  readonly term: string;
  readonly offset: number;
  readonly size: number;
}

interface StarDictPackage {
  readonly info: StarDictInfo;
  readonly index: ArrayBuffer;
  readonly dictionary: ArrayBuffer;
}

export interface StarDictAssetStore {
  get(): Promise<ArrayBuffer | null>;
  put(data: ArrayBuffer): Promise<void>;
  delete(): Promise<void>;
}

export interface StarDictInstallStatus {
  readonly installed: boolean;
  readonly name: string;
  readonly wordCount: number;
  readonly size: number;
}

function parsePositiveInteger(value: string | undefined, field: string): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`StarDict ${field} is missing or invalid.`);
  }

  return parsed;
}

export function parseStarDictInfo(value: string): StarDictInfo {
  const lines = value.replaceAll('\r\n', '\n').split('\n');

  if (lines[0]?.trim() !== "StarDict's dict ifo file") {
    throw new Error('The selected .ifo file is not a StarDict dictionary.');
  }

  const options = new Map<string, string>();

  for (const line of lines.slice(1)) {
    const separator = line.indexOf('=');

    if (separator > 0) {
      options.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
  }

  const version = options.get('version');

  if (version !== '2.4.2' && version !== '3.0.0') {
    throw new Error('Only StarDict 2.4.2 and 3.0.0 dictionaries are supported.');
  }

  if (options.get('idxoffsetbits') === '64') {
    throw new Error('StarDict indexes with 64-bit offsets are not supported yet.');
  }

  const bookName = options.get('bookname')?.trim();

  if (!bookName) {
    throw new Error('StarDict bookname is missing.');
  }

  return {
    version,
    bookName,
    wordCount: parsePositiveInteger(options.get('wordcount'), 'wordcount'),
    indexFileSize: parsePositiveInteger(options.get('idxfilesize'), 'idxfilesize'),
    sameTypeSequence: options.get('sametypesequence') || null,
    author: options.get('author') || null,
    description: options.get('description') || null,
  };
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function parseStarDictIndex(
  data: ArrayBuffer,
  dictionarySize: number,
): readonly StarDictIndexEntry[] {
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: StarDictIndexEntry[] = [];
  let cursor = 0;

  while (cursor < bytes.byteLength) {
    const termStart = cursor;

    while (cursor < bytes.byteLength && bytes[cursor] !== 0) {
      cursor += 1;
    }

    if (cursor === bytes.byteLength || cursor === termStart || cursor + 9 > bytes.byteLength) {
      throw new Error('The StarDict index is truncated or malformed.');
    }

    const term = decoder.decode(bytes.subarray(termStart, cursor));
    cursor += 1;
    const offset = readUint32(view, cursor);
    const size = readUint32(view, cursor + 4);
    cursor += 8;

    if (size === 0 || offset + size > dictionarySize) {
      throw new Error('A StarDict index entry points outside the .dict file.');
    }

    entries.push({ term, offset, size });
  }

  return entries;
}

function stripMarkup(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/\0/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readTextField(
  bytes: Uint8Array,
  cursor: number,
  isLast: boolean,
): { readonly value: string; readonly next: number } {
  let end = bytes.byteLength;

  if (!isLast) {
    end = bytes.indexOf(0, cursor);

    if (end < 0) {
      throw new Error('A StarDict text field is not terminated correctly.');
    }
  }

  return {
    value: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor, end)),
    next: isLast ? bytes.byteLength : end + 1,
  };
}

function articleFields(data: Uint8Array, sameTypeSequence: string | null) {
  const fields: Array<{ readonly type: string; readonly value: string }> = [];
  const sequence = sameTypeSequence ? [...sameTypeSequence] : null;
  let cursor = 0;
  let sequenceIndex = 0;

  while (cursor < data.byteLength) {
    const type = sequence?.[sequenceIndex] ?? String.fromCharCode(data[cursor] ?? 0);

    if (!sequence) {
      cursor += 1;
    }

    if (!type || !/[A-Za-z]/.test(type)) {
      throw new Error('The StarDict article contains an unsupported field marker.');
    }

    const isLast = sequence ? sequenceIndex === sequence.length - 1 : false;

    if (type === type.toLowerCase()) {
      const field = readTextField(data, cursor, isLast);
      fields.push({ type, value: field.value });
      cursor = field.next;
    } else {
      let size: number;

      if (isLast) {
        size = data.byteLength - cursor;
      } else {
        if (cursor + 4 > data.byteLength) {
          throw new Error('A StarDict binary field is truncated.');
        }
        size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(cursor, false);
        cursor += 4;
      }

      if (cursor + size > data.byteLength) {
        throw new Error('A StarDict binary field exceeds its article.');
      }

      cursor += size;
    }

    if (sequence) {
      sequenceIndex += 1;
      if (sequenceIndex === sequence.length) {
        break;
      }
    }
  }

  return fields;
}

function parseArticle(data: Uint8Array, sameTypeSequence: string | null): WordNetSense[] {
  const fields = articleFields(data, sameTypeSequence);
  const pronunciation = fields.find((field) => field.type === 't' || field.type === 'y')?.value;
  const definitions = fields
    .filter((field) => ['m', 'l', 'g', 'h', 'x'].includes(field.type))
    .map((field) => stripMarkup(field.value))
    .filter(Boolean);

  return definitions.map((definition) => ({
    partOfSpeech: 'unknown',
    definition,
    synonyms: [],
    examples: [],
    pronunciation: pronunciation ? stripMarkup(pronunciation) : undefined,
  }));
}

function encodePackage(files: StarDictFiles, info: StarDictInfo): ArrayBuffer {
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      info,
      indexLength: files.idx.byteLength,
      dictionaryLength: files.dict.byteLength,
    }),
  );
  const totalLength =
    packageMagicBytes.byteLength +
    4 +
    metadata.byteLength +
    files.idx.byteLength +
    files.dict.byteLength;
  const packageBytes = new Uint8Array(totalLength);
  packageBytes.set(packageMagicBytes);
  new DataView(packageBytes.buffer).setUint32(
    packageMagicBytes.byteLength,
    metadata.byteLength,
    false,
  );
  let cursor = packageMagicBytes.byteLength + 4;
  packageBytes.set(metadata, cursor);
  cursor += metadata.byteLength;
  packageBytes.set(new Uint8Array(files.idx), cursor);
  cursor += files.idx.byteLength;
  packageBytes.set(new Uint8Array(files.dict), cursor);
  return packageBytes.buffer;
}

function decodePackage(data: ArrayBuffer): StarDictPackage {
  const bytes = new Uint8Array(data);
  const magic = new TextDecoder().decode(bytes.subarray(0, packageMagicBytes.byteLength));

  if (magic !== packageMagic || data.byteLength < packageMagicBytes.byteLength + 4) {
    throw new Error('The saved StarDict package is invalid.');
  }

  const metadataLength = new DataView(data).getUint32(packageMagicBytes.byteLength, false);
  const metadataStart = packageMagicBytes.byteLength + 4;
  const metadataEnd = metadataStart + metadataLength;
  const metadata = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(metadataStart, metadataEnd)),
  ) as {
    readonly info: StarDictInfo;
    readonly indexLength: number;
    readonly dictionaryLength: number;
  };
  const indexEnd = metadataEnd + metadata.indexLength;

  if (
    metadataEnd > data.byteLength ||
    indexEnd > data.byteLength ||
    indexEnd + metadata.dictionaryLength !== data.byteLength
  ) {
    throw new Error('The saved StarDict package is truncated.');
  }

  return {
    info: metadata.info,
    index: data.slice(metadataEnd, indexEnd),
    dictionary: data.slice(indexEnd),
  };
}

async function starDictDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const appDirectory = await root.getDirectoryHandle('lexianchor', { create: true });
  return appDirectory.getDirectoryHandle('dictionaries', { create: true });
}

export class OpfsStarDictAssetStore implements StarDictAssetStore {
  async get(): Promise<ArrayBuffer | null> {
    try {
      const directory = await starDictDirectory();
      const handle = await directory.getFileHandle('user-stardict.package');
      return (await handle.getFile()).arrayBuffer();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return null;
      }
      throw error;
    }
  }

  async put(data: ArrayBuffer): Promise<void> {
    const directory = await starDictDirectory();
    const handle = await directory.getFileHandle('user-stardict.package', { create: true });
    const writer = await handle.createWritable();

    try {
      await writer.write(data);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
  }

  async delete(): Promise<void> {
    try {
      const directory = await starDictDirectory();
      await directory.removeEntry('user-stardict.package');
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
        throw error;
      }
    }
  }
}

export class StarDictProvider implements DictionaryProvider {
  private package: StarDictPackage | null = null;
  private index: ReadonlyMap<string, readonly StarDictIndexEntry[]> | null = null;

  constructor(private readonly store: StarDictAssetStore = new OpfsStarDictAssetStore()) {}

  get source(): DictionarySource {
    return {
      id: 'user-stardict',
      name: this.package?.info.bookName ?? 'User StarDict',
      version: this.package?.info.version ?? '2.4.2',
      languages: ['und', 'und'],
      license: 'User supplied',
      attribution:
        'User-installed StarDict data. Content and licensing remain the user’s responsibility.',
    };
  }

  async status(): Promise<StarDictInstallStatus> {
    const data = await this.store.get();

    if (!data) {
      return { installed: false, name: '', wordCount: 0, size: 0 };
    }

    const dictionaryPackage = decodePackage(data);
    return {
      installed: true,
      name: dictionaryPackage.info.bookName,
      wordCount: dictionaryPackage.info.wordCount,
      size: data.byteLength,
    };
  }

  async install(files: StarDictFiles): Promise<StarDictInstallStatus> {
    const info = parseStarDictInfo(files.ifo);

    if (files.idx.byteLength !== info.indexFileSize) {
      throw new Error('The selected .idx size does not match the .ifo file.');
    }

    const entries = parseStarDictIndex(files.idx, files.dict.byteLength);

    if (entries.length !== info.wordCount) {
      throw new Error('The selected .idx word count does not match the .ifo file.');
    }

    for (const entry of entries) {
      parseArticle(new Uint8Array(files.dict, entry.offset, entry.size), info.sameTypeSequence);
    }

    const data = encodePackage(files, info);
    await this.store.put(data);
    this.package = null;
    this.index = null;
    return {
      installed: true,
      name: info.bookName,
      wordCount: info.wordCount,
      size: data.byteLength,
    };
  }

  async remove(): Promise<void> {
    await this.store.delete();
    this.package = null;
    this.index = null;
  }

  async lookup(value: string): Promise<DictionaryResult | null> {
    const dictionaryPackage = await this.loadPackage();

    if (!dictionaryPackage) {
      return null;
    }

    const index = this.loadIndex(dictionaryPackage);

    for (const candidate of morphologyCandidates(normalizeLookupTerm(value))) {
      const entries = index.get(candidate);

      if (!entries?.length) {
        continue;
      }

      const dictionary = new Uint8Array(dictionaryPackage.dictionary);
      const senses = entries.flatMap((entry) =>
        parseArticle(
          dictionary.subarray(entry.offset, entry.offset + entry.size),
          dictionaryPackage.info.sameTypeSequence,
        ),
      );

      if (senses.length > 0) {
        return {
          term: value.trim(),
          lemma: entries[0]?.term ?? candidate,
          senses,
          rootOrEtymology: null,
          source: this.source,
        };
      }
    }

    return null;
  }

  private async loadPackage(): Promise<StarDictPackage | null> {
    if (this.package) {
      return this.package;
    }

    const data = await this.store.get();

    if (!data) {
      return null;
    }

    this.package = decodePackage(data);
    return this.package;
  }

  private loadIndex(dictionaryPackage: StarDictPackage) {
    if (this.index) {
      return this.index;
    }

    const parsed = parseStarDictIndex(
      dictionaryPackage.index,
      dictionaryPackage.dictionary.byteLength,
    );
    const index = new Map<string, StarDictIndexEntry[]>();

    for (const entry of parsed) {
      const key = normalizeLookupTerm(entry.term);
      const current = index.get(key) ?? [];
      current.push(entry);
      index.set(key, current);
    }

    this.index = index;
    return index;
  }
}
