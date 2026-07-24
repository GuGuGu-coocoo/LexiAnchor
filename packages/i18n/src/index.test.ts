import { describe, expect, it } from 'vitest';

import { resolveLocale, translate } from './index';

describe('resolveLocale', () => {
  it('selects the first supported system language', () => {
    expect(resolveLocale(['de-DE', 'fr-FR', 'en-US'])).toBe('fr');
  });

  it('maps Chinese variants to Simplified Chinese UI for the MVP', () => {
    expect(resolveLocale(['zh-Hant-HK'])).toBe('zh-CN');
  });

  it('falls back to English', () => {
    expect(resolveLocale(['ja-JP'])).toBe('en');
    expect(resolveLocale([])).toBe('en');
  });
});

describe('translate', () => {
  it('returns a message from the requested locale', () => {
    expect(translate('zh-CN', 'library')).toBe('书库');
  });
});
