import { describe, expect, it } from 'vitest';

import { parseStarDictInfo, StarDictProvider, type StarDictAssetStore } from './stardict';

function fixture() {
  const encoder = new TextEncoder();
  const article = encoder.encode('A stable point that helps a reader stay oriented.');
  const term = encoder.encode('anchor');
  const index = new Uint8Array(term.byteLength + 1 + 8);
  index.set(term);
  const view = new DataView(index.buffer);
  view.setUint32(term.byteLength + 1, 0, false);
  view.setUint32(term.byteLength + 5, article.byteLength, false);
  const ifo = [
    "StarDict's dict ifo file",
    'version=2.4.2',
    'bookname=Reader Dictionary',
    'wordcount=1',
    `idxfilesize=${index.byteLength}`,
    'sametypesequence=m',
    '',
  ].join('\n');
  return { ifo, idx: index.buffer, dict: article.buffer };
}

class MemoryStore implements StarDictAssetStore {
  data: ArrayBuffer | null = null;

  get() {
    return Promise.resolve(this.data);
  }

  put(data: ArrayBuffer) {
    this.data = data;
    return Promise.resolve();
  }

  delete() {
    this.data = null;
    return Promise.resolve();
  }
}

describe('StarDict', () => {
  it('parses required metadata', () => {
    expect(parseStarDictInfo(fixture().ifo)).toMatchObject({
      version: '2.4.2',
      bookName: 'Reader Dictionary',
      wordCount: 1,
      sameTypeSequence: 'm',
    });
  });

  it('imports, queries, and removes an uncompressed dictionary', async () => {
    const store = new MemoryStore();
    const provider = new StarDictProvider(store);

    await expect(provider.install(fixture())).resolves.toMatchObject({
      installed: true,
      name: 'Reader Dictionary',
      wordCount: 1,
    });
    await expect(provider.lookup('anchors')).resolves.toMatchObject({
      lemma: 'anchor',
      senses: [{ definition: 'A stable point that helps a reader stay oriented.' }],
      source: { name: 'Reader Dictionary' },
    });

    await provider.remove();
    await expect(provider.status()).resolves.toMatchObject({ installed: false });
  });

  it('does not replace the current dictionary when validation fails', async () => {
    const store = new MemoryStore();
    const provider = new StarDictProvider(store);
    await provider.install(fixture());
    const invalid = fixture();

    await expect(
      provider.install({ ...invalid, ifo: invalid.ifo.replace('wordcount=1', 'wordcount=2') }),
    ).rejects.toThrow('word count');
    await expect(provider.lookup('anchor')).resolves.toMatchObject({
      lemma: 'anchor',
    });
  });

  it('rejects compressed and 64-bit index variants explicitly', () => {
    expect(() => parseStarDictInfo(`${fixture().ifo}idxoffsetbits=64\n`)).toThrow('64-bit offsets');
  });

  it('rejects empty dictionaries before saving them', () => {
    expect(() => parseStarDictInfo(fixture().ifo.replace('wordcount=1', 'wordcount=0'))).toThrow(
      'wordcount',
    );
    expect(() =>
      parseStarDictInfo(fixture().ifo.replace(/idxfilesize=\d+/, 'idxfilesize=0')),
    ).toThrow('idxfilesize');
  });
});
