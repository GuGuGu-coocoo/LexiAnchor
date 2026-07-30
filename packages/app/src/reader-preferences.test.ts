import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultReaderPreferences } from '@lexianchor/reader-core';

import {
  normalizeReaderPreferences,
  persistReaderPresetStore,
  readReaderPresetStore,
} from './reader-preferences';

function memoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reader preferences', () => {
  it('upgrades saved settings with the default page spread and turn effect', () => {
    expect(
      normalizeReaderPreferences({
        flow: 'paginated',
        fontSizePercent: 125,
      }),
    ).toMatchObject({
      flow: 'paginated',
      pageSpread: 'single',
      pageTurnEffect: 'slide',
      fontSizePercent: 125,
      selectionPopoverWidthPx: 360,
      selectionPopoverHeightPx: 430,
    });
  });

  it('clamps selection popover dimensions to a usable desktop range', () => {
    expect(
      normalizeReaderPreferences({
        selectionPopoverWidthPx: 900,
        selectionPopoverHeightPx: 120,
      }),
    ).toMatchObject({
      selectionPopoverWidthPx: 620,
      selectionPopoverHeightPx: 260,
    });
  });

  it('round-trips named presets with their theme and two-column choice', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const store = {
      activePresetId: 'preset-reading',
      presets: [
        {
          id: 'preset-reading',
          name: 'Reading 1',
          theme: 'eye-care' as const,
          preferences: {
            ...defaultReaderPreferences,
            pageSpread: 'double' as const,
            pageTurnEffect: 'stack' as const,
            fontSizePercent: 115,
          },
        },
      ],
    };

    persistReaderPresetStore(store);

    expect(readReaderPresetStore()).toEqual(store);
  });
});
