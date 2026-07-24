import { describe, expect, it } from 'vitest';

import {
  FreeDictEnglishChineseProvider,
  FreeDictEnglishFrenchProvider,
  parseFreeDictTei,
} from './freedict';

const sample = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <text><body>
    <entry>
      <form><orth>resilient</orth><pron>rɪˈzɪliənt</pron></form>
      <gramGrp><pos>adj</pos></gramGrp>
      <sense>
        <cit type="trans"><quote>résilient</quote></cit>
        <cit type="trans"><quote>robuste</quote></cit>
        <sense><def>Returning quickly to an original shape or condition.</def></sense>
      </sense>
    </entry>
  </body></text>
</TEI>`;

const chineseSample = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <text><body>
    <entry>
      <form><orth>attentive</orth><pron>/əˈtɛntɪv/</pron></form>
      <gramGrp><pos>adj</pos></gramGrp>
      <sense>
        <cit type="trans" xml:lang="zh"><quote>細緻</quote></cit>
        <sense><def>Paying attention or listening closely.</def></sense>
      </sense>
    </entry>
  </body></text>
</TEI>`;

describe('FreeDict TEI provider', () => {
  it('parses headwords, pronunciation, part of speech, and translations', () => {
    const entries = parseFreeDictTei(sample);

    expect(entries.get('resilient')).toEqual([
      {
        term: 'resilient',
        pronunciation: 'rɪˈzɪliənt',
        partOfSpeech: 'adjective',
        translations: ['résilient', 'robuste'],
        englishDefinitions: ['Returning quickly to an original shape or condition.'],
      },
    ]);
  });

  it('returns no result before the downloadable dictionary is installed', async () => {
    const provider = new FreeDictEnglishFrenchProvider({
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    });

    await expect(provider.status()).resolves.toEqual({ installed: false, size: 0 });
    await expect(provider.lookup('resilient')).resolves.toBeNull();
  });

  it('queries an installed TEI resource locally', async () => {
    const provider = new FreeDictEnglishFrenchProvider({
      get: () => Promise.resolve(sample),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    });

    const result = await provider.lookup('resilient');

    expect(result?.source.languages).toEqual(['en', 'fr']);
    expect(result?.senses[0]).toMatchObject({
      partOfSpeech: 'adjective',
      pronunciation: 'rɪˈzɪliənt',
      translations: ['résilient', 'robuste'],
      definition: 'Returning quickly to an original shape or condition.',
      englishDefinitions: ['Returning quickly to an original shape or condition.'],
    });
  });

  it('queries Chinese translations and strips surrounding pronunciation marks', async () => {
    const provider = new FreeDictEnglishChineseProvider({
      get: () => Promise.resolve(chineseSample),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    });

    const result = await provider.lookup('attentive');

    expect(result?.source.languages).toEqual(['en', 'zh']);
    expect(result?.senses[0]).toMatchObject({
      partOfSpeech: 'adjective',
      pronunciation: 'əˈtɛntɪv',
      translations: ['細緻'],
      definition: 'Paying attention or listening closely.',
    });
  });

  it('verifies, stores, and removes a downloaded resource', async () => {
    const bytes = new TextEncoder().encode(sample);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const checksum = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    let stored: string | null = null;
    const provider = new FreeDictEnglishFrenchProvider(
      {
        get: () => Promise.resolve(stored),
        put: (_id, content) => {
          stored = content;
          return Promise.resolve();
        },
        delete: () => {
          stored = null;
          return Promise.resolve();
        },
      },
      () => Promise.resolve(new Response(sample, { status: 200 })),
      {
        id: 'test-eng-fra',
        name: 'Test English–French',
        version: '1',
        languages: ['en', 'fr'],
        license: 'Test only',
        attribution: 'Test fixture',
        downloadUrl: 'https://example.test/eng-fra.tei',
        size: bytes.byteLength,
        sha256: checksum,
      },
    );

    await expect(provider.install()).resolves.toEqual({
      installed: true,
      size: bytes.byteLength,
    });
    await expect(provider.lookup('resilient')).resolves.toMatchObject({
      lemma: 'resilient',
      source: { id: 'test-eng-fra' },
    });
    await provider.remove();
    await expect(provider.status()).resolves.toEqual({ installed: false, size: 0 });
  });
});
