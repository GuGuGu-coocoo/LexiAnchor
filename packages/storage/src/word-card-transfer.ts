import type { WordCardRecord } from './types';

const format = 'lexianchor.word-cards';
const schemaVersion = 1;

export interface WordCardExport {
  readonly format: typeof format;
  readonly schemaVersion: typeof schemaVersion;
  readonly exportedAt: string;
  readonly cards: readonly WordCardRecord[];
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function parseCard(value: unknown): WordCardRecord {
  if (!value || typeof value !== 'object') {
    throw new Error('A word-card entry is not an object.');
  }

  const card = value as Record<string, unknown>;
  const requiredStrings = [
    'id',
    'term',
    'normalizedTerm',
    'partOfSpeech',
    'definition',
    'dictionarySource',
    'sourceBookTitle',
    'sourceSentence',
    'createdAt',
    'updatedAt',
  ] as const;

  if (requiredStrings.some((key) => !isString(card[key]))) {
    throw new Error('A word-card entry is missing a required text field.');
  }

  if (
    !isNullableString(card.rootOrEtymology) ||
    !isNullableString(card.sourceBookId) ||
    !isNullableString(card.deletedAt) ||
    typeof card.version !== 'number' ||
    !Number.isInteger(card.version) ||
    card.version < 1
  ) {
    throw new Error('A word-card entry contains an invalid field.');
  }

  const term = String(card.term).trim();
  const definition = String(card.definition).trim();
  const definitions = Array.isArray(card.definitions)
    ? card.definitions
        .filter(isString)
        .map((candidate) => candidate.trim())
        .filter(Boolean)
    : [];
  const dictionarySource = String(card.dictionarySource).trim();
  const sourceBookTitle = String(card.sourceBookTitle).trim();
  const sourceSentence = String(card.sourceSentence).trim();
  const createdAt = String(card.createdAt);
  const updatedAt = String(card.updatedAt);

  if (!term || !definition || !dictionarySource || !sourceBookTitle || !sourceSentence) {
    throw new Error('A word-card entry is missing required content.');
  }

  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) {
    throw new Error('A word-card entry contains an invalid timestamp.');
  }

  return {
    id: String(card.id),
    term,
    normalizedTerm: term.toLocaleLowerCase('en-US'),
    partOfSpeech: String(card.partOfSpeech).trim() || 'unknown',
    definition,
    definitions: definitions.length > 0 ? definitions : [definition],
    rootOrEtymology: card.rootOrEtymology ? String(card.rootOrEtymology).trim() || null : null,
    dictionarySource,
    // A book identifier is local to one database. The human-readable source
    // title remains portable, while the relation is safely detached.
    sourceBookId: null,
    sourceBookTitle,
    sourceSentence,
    createdAt,
    updatedAt,
    deletedAt: null,
    version: Number(card.version),
  };
}

export function serializeWordCards(
  cards: readonly WordCardRecord[],
  exportedAt = new Date().toISOString(),
): string {
  const payload: WordCardExport = {
    format,
    schemaVersion,
    exportedAt,
    cards,
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function parseWordCardExport(input: string): WordCardExport {
  let value: unknown;

  try {
    value = JSON.parse(input);
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }

  if (!value || typeof value !== 'object') {
    throw new Error('The selected file is not a LexiAnchor word-card backup.');
  }

  const payload = value as Record<string, unknown>;

  if (
    payload.format !== format ||
    payload.schemaVersion !== schemaVersion ||
    !isString(payload.exportedAt) ||
    !isTimestamp(payload.exportedAt) ||
    !Array.isArray(payload.cards)
  ) {
    throw new Error('The selected file uses an unsupported word-card backup format.');
  }

  return {
    format,
    schemaVersion,
    exportedAt: payload.exportedAt,
    cards: payload.cards.map(parseCard),
  };
}
