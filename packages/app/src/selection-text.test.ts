import { describe, expect, it } from 'vitest';

import { normalizeSelectionText } from './selection-text';

describe('normalizeSelectionText', () => {
  it('removes punctuation around a selected word', () => {
    expect(normalizeSelectionText('“reader,”')).toBe('reader');
    expect(normalizeSelectionText('(attentive)')).toBe('attentive');
    expect(normalizeSelectionText('résilient.')).toBe('résilient');
  });

  it('keeps apostrophes inside words', () => {
    expect(normalizeSelectionText("don't!")).toBe("don't");
    expect(normalizeSelectionText('l’ancre.')).toBe('l’ancre');
  });

  it('keeps phrase punctuation for sentence translation', () => {
    expect(normalizeSelectionText('Read this, please.')).toBe('Read this, please.');
  });
});
