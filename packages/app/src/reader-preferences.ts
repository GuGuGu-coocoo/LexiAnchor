import {
  defaultReaderPreferences,
  type FocusStrength,
  type ReaderFontFamily,
  type ReaderPageSpread,
  type ReaderPreferences,
  type ReaderTextAlignment,
} from '@lexianchor/reader-core';

import type { Theme } from './theme';

const globalKey = 'lexianchor:reader-preferences';
const presetsKey = 'lexianchor:reader-presets';
export const defaultReaderPresetId = 'default';
const focusStrengths: readonly FocusStrength[] = ['light', 'medium', 'strong'];
const fontFamilies: readonly ReaderFontFamily[] = ['serif', 'sans-serif'];
const pageSpreads: readonly ReaderPageSpread[] = ['single', 'double'];
const textAlignments: readonly ReaderTextAlignment[] = ['start', 'justify'];
const themes: readonly Theme[] = ['system', 'light', 'dark', 'eye-care'];

export interface ReaderPreset {
  readonly id: string;
  readonly name: string;
  readonly theme: Theme;
  readonly preferences: ReaderPreferences;
}

export interface ReaderPresetStore {
  readonly activePresetId: string;
  readonly presets: readonly ReaderPreset[];
}

function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function storedObject(key: string): Partial<ReaderPreferences> {
  try {
    const stored = globalThis.localStorage?.getItem(key);
    const value: unknown = stored ? JSON.parse(stored) : null;
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function scopedKey(scopeId: string): string {
  return `lexianchor:reader-preferences:${encodeURIComponent(scopeId)}`;
}

export function normalizeReaderPreferences(input: Partial<ReaderPreferences>): ReaderPreferences {
  return {
    flow: input.flow === 'scrolled' ? 'scrolled' : 'paginated',
    pageSpread: pageSpreads.includes(input.pageSpread as ReaderPageSpread)
      ? (input.pageSpread as ReaderPageSpread)
      : defaultReaderPreferences.pageSpread,
    fontSizePercent: clamp(input.fontSizePercent, 100, 80, 180),
    lineHeight: clamp(input.lineHeight, 1.55, 1.2, 2.2),
    wordSpacingEm: clamp(input.wordSpacingEm, 0, 0, 0.5),
    letterSpacingEm: clamp(input.letterSpacingEm, 0, 0, 0.15),
    fontFamily: fontFamilies.includes(input.fontFamily as ReaderFontFamily)
      ? (input.fontFamily as ReaderFontFamily)
      : defaultReaderPreferences.fontFamily,
    fontWeight: Math.round(clamp(input.fontWeight, 400, 350, 700) / 50) * 50,
    contentWidthPercent: Math.round(clamp(input.contentWidthPercent, 90, 55, 100) / 5) * 5,
    textAlignment: textAlignments.includes(input.textAlignment as ReaderTextAlignment)
      ? (input.textAlignment as ReaderTextAlignment)
      : defaultReaderPreferences.textAlignment,
    foreground:
      typeof input.foreground === 'string' ? input.foreground : defaultReaderPreferences.foreground,
    background:
      typeof input.background === 'string' ? input.background : defaultReaderPreferences.background,
    focusMode: input.focusMode === true,
    focusStrength: focusStrengths.includes(input.focusStrength as FocusStrength)
      ? (input.focusStrength as FocusStrength)
      : defaultReaderPreferences.focusStrength,
  };
}

export function readReaderPreferences(scopeId: string): ReaderPreferences {
  return normalizeReaderPreferences({
    ...defaultReaderPreferences,
    ...storedObject(globalKey),
    ...storedObject(scopedKey(scopeId)),
  });
}

export function persistReaderPreferences(scopeId: string, preferences: ReaderPreferences): void {
  try {
    const serialized = JSON.stringify(preferences);
    globalThis.localStorage?.setItem(globalKey, serialized);
    globalThis.localStorage?.setItem(scopedKey(scopeId), serialized);
  } catch {
    // The reader remains usable with in-memory preferences when storage is unavailable.
  }
}

export function readReaderPresetStore(): ReaderPresetStore {
  try {
    const stored = globalThis.localStorage?.getItem(presetsKey);
    const value: unknown = stored ? JSON.parse(stored) : null;

    if (!value || typeof value !== 'object') {
      return { activePresetId: defaultReaderPresetId, presets: [] };
    }

    const record = value as {
      readonly activePresetId?: unknown;
      readonly presets?: unknown;
    };
    const presets = Array.isArray(record.presets)
      ? record.presets.flatMap((candidate): ReaderPreset[] => {
          if (!candidate || typeof candidate !== 'object') {
            return [];
          }

          const preset = candidate as {
            readonly id?: unknown;
            readonly name?: unknown;
            readonly theme?: unknown;
            readonly preferences?: unknown;
          };

          if (
            typeof preset.id !== 'string' ||
            !preset.id ||
            typeof preset.name !== 'string' ||
            !preset.name.trim() ||
            !themes.includes(preset.theme as Theme) ||
            !preset.preferences ||
            typeof preset.preferences !== 'object'
          ) {
            return [];
          }

          return [
            {
              id: preset.id,
              name: preset.name.trim(),
              theme: preset.theme as Theme,
              preferences: normalizeReaderPreferences(preset.preferences),
            },
          ];
        })
      : [];
    const activePresetId =
      typeof record.activePresetId === 'string' &&
      (record.activePresetId === defaultReaderPresetId ||
        presets.some((preset) => preset.id === record.activePresetId))
        ? record.activePresetId
        : defaultReaderPresetId;

    return { activePresetId, presets };
  } catch {
    return { activePresetId: defaultReaderPresetId, presets: [] };
  }
}

export function persistReaderPresetStore(store: ReaderPresetStore): void {
  try {
    globalThis.localStorage?.setItem(presetsKey, JSON.stringify(store));
  } catch {
    // Presets remain usable for the current session when storage is unavailable.
  }
}
