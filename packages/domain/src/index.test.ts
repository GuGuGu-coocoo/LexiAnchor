import { describe, expect, it } from 'vitest';

import { normalizeProgress } from './index';

describe('normalizeProgress', () => {
  it('rounds a valid percentage', () => {
    expect(normalizeProgress(37.6)).toBe(38);
  });

  it('clamps values to the progress range', () => {
    expect(normalizeProgress(-5)).toBe(0);
    expect(normalizeProgress(140)).toBe(100);
  });

  it('turns non-finite values into zero', () => {
    expect(normalizeProgress(Number.NaN)).toBe(0);
    expect(normalizeProgress(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
