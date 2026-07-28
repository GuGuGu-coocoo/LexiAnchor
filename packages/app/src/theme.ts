import type { ReaderPreferences } from '@lexianchor/reader-core';

export type Theme = 'system' | 'light' | 'dark' | 'eye-care';

const lightColors = {
  foreground: '#20211f',
  background: '#ffffff',
} satisfies Pick<ReaderPreferences, 'foreground' | 'background'>;

const darkColors = {
  foreground: '#eff1ed',
  background: '#242725',
} satisfies Pick<ReaderPreferences, 'foreground' | 'background'>;

const eyeCareColors = {
  foreground: '#2c3028',
  background: '#f8f3e5',
} satisfies Pick<ReaderPreferences, 'foreground' | 'background'>;

export function readerColorsForTheme(
  theme: Theme,
): Pick<ReaderPreferences, 'foreground' | 'background'> {
  if (theme === 'dark') {
    return darkColors;
  }

  if (theme === 'eye-care') {
    return eyeCareColors;
  }

  if (
    theme === 'system' &&
    globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  ) {
    return darkColors;
  }

  return lightColors;
}
