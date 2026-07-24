export type WordNetPartOfSpeech = 'noun' | 'verb' | 'adjective' | 'adverb';
export type DictionaryPartOfSpeech = WordNetPartOfSpeech | 'unknown';

export interface WordNetIndexRecord {
  readonly lemma: string;
  readonly partOfSpeech: WordNetPartOfSpeech;
  readonly offsets: readonly number[];
}

export interface WordNetSense {
  readonly partOfSpeech: DictionaryPartOfSpeech;
  readonly definition: string;
  readonly synonyms: readonly string[];
  readonly examples: readonly string[];
  readonly pronunciation?: string;
  readonly translations?: readonly string[];
  readonly englishDefinitions?: readonly string[];
}

const partOfSpeechNames: Readonly<Record<string, WordNetPartOfSpeech>> = {
  n: 'noun',
  v: 'verb',
  a: 'adjective',
  s: 'adjective',
  r: 'adverb',
};

export function normalizeLookupTerm(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/^[^a-z]+|[^a-z]+$/g, '')
    .replace(/[\s-]+/g, '_');
}

export function morphologyCandidates(term: string): readonly string[] {
  const candidates = new Set([term]);

  if (term.endsWith('ies') && term.length > 4) {
    candidates.add(`${term.slice(0, -3)}y`);
  }

  if (term.endsWith('ing') && term.length > 5) {
    candidates.add(term.slice(0, -3));
    candidates.add(`${term.slice(0, -3)}e`);
  }

  if (term.endsWith('ed') && term.length > 4) {
    candidates.add(term.slice(0, -2));
    candidates.add(`${term.slice(0, -1)}`);
  }

  if (term.endsWith('es') && term.length > 4) {
    candidates.add(term.slice(0, -2));
  }

  if (term.endsWith('s') && term.length > 3) {
    candidates.add(term.slice(0, -1));
  }

  return [...candidates];
}

export function findIndexLine(indexText: string, lemma: string): string | null {
  const marker = `\n${lemma} `;
  const start = indexText.indexOf(marker);

  if (start < 0) {
    return indexText.startsWith(`${lemma} `) ? indexText.slice(0, indexText.indexOf('\n')) : null;
  }

  const lineStart = start + 1;
  const lineEnd = indexText.indexOf('\n', lineStart);
  return indexText.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim();
}

export function parseIndexLine(line: string): WordNetIndexRecord | null {
  const fields = line.trim().split(/\s+/);
  const partOfSpeech = partOfSpeechNames[fields[1] ?? ''];
  const synsetCount = Number(fields[2]);
  const pointerCount = Number(fields[3]);

  if (
    !fields[0] ||
    !partOfSpeech ||
    !Number.isInteger(synsetCount) ||
    !Number.isInteger(pointerCount)
  ) {
    return null;
  }

  const offsetStart = 6 + pointerCount;
  const offsets = fields
    .slice(offsetStart, offsetStart + synsetCount)
    .map(Number)
    .filter(Number.isInteger);

  return offsets.length === synsetCount
    ? {
        lemma: fields[0].replaceAll('_', ' '),
        partOfSpeech,
        offsets,
      }
    : null;
}

export function lineAtByteOffset(data: Uint8Array, offset: number): string | null {
  if (offset < 0 || offset >= data.byteLength) {
    return null;
  }

  let end = offset;

  while (end < data.byteLength && data[end] !== 0x0a) {
    end += 1;
  }

  return new TextDecoder('utf-8').decode(data.subarray(offset, end)).trim();
}

export function parseDataLine(line: string): WordNetSense | null {
  const separator = line.indexOf('|');

  if (separator < 0) {
    return null;
  }

  const fields = line.slice(0, separator).trim().split(/\s+/);
  const partOfSpeech = partOfSpeechNames[fields[2] ?? ''];
  const wordCount = Number.parseInt(fields[3] ?? '', 16);

  if (!partOfSpeech || !Number.isInteger(wordCount)) {
    return null;
  }

  const synonyms: string[] = [];

  for (let index = 0; index < wordCount; index += 1) {
    const word = fields[4 + index * 2];

    if (word) {
      synonyms.push(word.replaceAll('_', ' '));
    }
  }

  const gloss = line.slice(separator + 1).trim();
  const examples = [...gloss.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '').filter(Boolean);
  const definition = gloss
    .replace(/;\s*"[^"]*"/g, '')
    .replace(/;\s*$/, '')
    .trim();

  return definition
    ? {
        partOfSpeech,
        definition,
        synonyms,
        examples,
      }
    : null;
}
