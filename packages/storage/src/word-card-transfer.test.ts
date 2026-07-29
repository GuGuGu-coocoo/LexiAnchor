import { describe, expect, it } from 'vitest';

import type { WordCardRecord } from './types';
import { parseWordCardExport, serializeWordCards } from './word-card-transfer';

const card: WordCardRecord = {
  id: 'card-1',
  term: 'Resilient',
  normalizedTerm: 'resilient',
  partOfSpeech: 'adjective',
  definition: 'Able to recover.',
  definitions: ['Able to recover.', 'Returning quickly to a stable state.'],
  rootOrEtymology: null,
  dictionarySource: 'Princeton WordNet 3.1',
  sourceBookId: 'book-local-only',
  sourceBookTitle: 'Anchored Pages',
  sourceSentence: 'A resilient reader returns to the page.',
  occurrenceCount: 1,
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
  deletedAt: null,
  version: 1,
};

describe('word-card transfer', () => {
  it('round-trips all portable fields and detaches a device-local book id', () => {
    const exported = serializeWordCards([card], '2026-07-25T00:00:00.000Z');
    const parsed = parseWordCardExport(exported);

    expect(parsed).toMatchObject({
      format: 'lexianchor.word-cards',
      schemaVersion: 1,
      exportedAt: '2026-07-25T00:00:00.000Z',
    });
    expect(parsed.cards).toEqual([{ ...card, sourceBookId: null }]);
  });

  it('rejects malformed and unsupported backups', () => {
    expect(() => parseWordCardExport('not-json')).toThrow('not valid JSON');
    expect(() =>
      parseWordCardExport(
        JSON.stringify({
          format: 'lexianchor.word-cards',
          schemaVersion: 2,
          exportedAt: 'now',
          cards: [],
        }),
      ),
    ).toThrow('unsupported');
    expect(() =>
      parseWordCardExport(
        JSON.stringify({
          format: 'lexianchor.word-cards',
          schemaVersion: 1,
          exportedAt: '2026-07-25T00:00:00.000Z',
          cards: [{ id: 'missing-fields' }],
        }),
      ),
    ).toThrow('required text field');
    expect(() =>
      parseWordCardExport(
        serializeWordCards([{ ...card, createdAt: 'not-a-date' }], '2026-07-25T00:00:00.000Z'),
      ),
    ).toThrow('invalid timestamp');
  });
});
