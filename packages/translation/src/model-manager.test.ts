import { describe, expect, it } from 'vitest';

import {
  TranslationModelManager,
  type TranslationModelPart,
  type TranslationModelResource,
  type TranslationModelStore,
  type TranslationTargetLanguage,
} from './model-manager';

class MemoryStore implements TranslationModelStore {
  readonly parts = new Map<string, ArrayBuffer>();
  readonly complete = new Set<string>();

  hasPart(resourceId: string, part: TranslationModelPart, size: number) {
    return Promise.resolve(this.parts.get(`${resourceId}:${part}`)?.byteLength === size);
  }

  getPart(resourceId: string, part: TranslationModelPart) {
    return Promise.resolve(this.parts.get(`${resourceId}:${part}`) ?? null);
  }

  putPart(resourceId: string, part: TranslationModelPart, value: ArrayBuffer) {
    this.parts.set(`${resourceId}:${part}`, value);
    return Promise.resolve();
  }

  isComplete(resourceId: string) {
    return Promise.resolve(this.complete.has(resourceId));
  }

  markComplete(resourceId: string) {
    this.complete.add(resourceId);
    return Promise.resolve();
  }

  remove(resourceId: string) {
    for (const key of this.parts.keys()) {
      if (key.startsWith(`${resourceId}:`)) {
        this.parts.delete(key);
      }
    }
    this.complete.delete(resourceId);
    return Promise.resolve();
  }
}

async function sha256(value: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fixtureResource(targetLanguage: TranslationTargetLanguage) {
  const raw = new TextEncoder().encode(`local translation model for ${targetLanguage}`).buffer;
  const compressed = await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
  const resource: TranslationModelResource = {
    id: `test-en-${targetLanguage}`,
    name: 'Test model',
    sourceLanguage: 'en',
    targetLanguage,
    architecture: 'test',
    license: 'Test only',
    licenseUrl: 'https://example.test/license',
    sourceUrl: 'https://example.test/source',
    files: [
      {
        part: 'model',
        url: `https://example.test/${targetLanguage}.gz`,
        compressedSize: compressed.byteLength,
        compressedSha256: await sha256(compressed),
        size: raw.byteLength,
        sha256: await sha256(raw),
      },
    ],
    downloadSize: compressed.byteLength,
    installedSize: raw.byteLength,
    attribution: 'Test fixture',
  };
  return { compressed, raw, resource };
}

describe('TranslationModelManager', () => {
  it('validates, decompresses, stores, resumes, and removes a model', async () => {
    const fixture = await fixtureResource('fr');
    const chinese = await fixtureResource('zh');
    const store = new MemoryStore();
    let downloads = 0;
    const manager = new TranslationModelManager(
      store,
      () => {
        downloads += 1;
        return Promise.resolve(new Response(fixture.compressed, { status: 200 }));
      },
      { fr: fixture.resource, zh: chinese.resource },
    );
    const progress: number[] = [];

    await expect(
      manager.install('fr', {
        onProgress: (update) => progress.push(update.downloadedBytes),
      }),
    ).resolves.toMatchObject({ installed: true, installedParts: 1 });
    expect(store.parts.get('test-en-fr:model')).toEqual(fixture.raw);
    expect(progress.at(-1)).toBe(fixture.compressed.byteLength);

    await manager.install('fr');
    expect(downloads).toBe(1);

    await manager.remove('fr');
    await expect(manager.status('fr')).resolves.toMatchObject({
      installed: false,
      partial: false,
    });
  });

  it('rejects corrupted downloads before saving', async () => {
    const fixture = await fixtureResource('fr');
    const chinese = await fixtureResource('zh');
    const store = new MemoryStore();
    const manager = new TranslationModelManager(
      store,
      () => Promise.resolve(new Response('not the model', { status: 200 })),
      { fr: fixture.resource, zh: chinese.resource },
    );

    await expect(manager.install('fr')).rejects.toThrow('resource manifest');
    await expect(manager.status('fr')).resolves.toMatchObject({
      installed: false,
      installedParts: 0,
    });
  });
});
