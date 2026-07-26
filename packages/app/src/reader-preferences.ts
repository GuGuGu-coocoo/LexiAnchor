import {
  defaultReaderPreferences,
  type FocusStrength,
  type ReaderFontFamily,
  type ReaderPreferences,
  type ReaderTextAlignment,
} from '@lexianchor/reader-core';

const globalKey = 'lexianchor:reader-preferences';
const focusStrengths: readonly FocusStrength[] = ['light', 'medium', 'strong'];
const fontFamilies: readonly ReaderFontFamily[] = ['serif', 'sans-serif'];
const textAlignments: readonly ReaderTextAlignment[] = ['start', 'justify'];

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

function normalizePreferences(input: Partial<ReaderPreferences>): ReaderPreferences {
  return {
    flow: input.flow === 'scrolled' ? 'scrolled' : 'paginated',
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
  return normalizePreferences({
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
