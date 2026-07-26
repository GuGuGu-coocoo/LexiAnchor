import { describe, expect, it } from 'vitest';

import { focusFontWeight, focusPrefixLength } from './index';

describe('focus highlighting strength', () => {
  it('increases the emphasized prefix without exceeding the word', () => {
    expect(focusPrefixLength(10, 'light')).toBe(4);
    expect(focusPrefixLength(10, 'medium')).toBe(5);
    expect(focusPrefixLength(10, 'strong')).toBe(6);
    expect(focusPrefixLength(3, 'light')).toBe(1);
    expect(focusPrefixLength(3, 'strong')).toBe(2);
    expect(focusPrefixLength(0, 'strong')).toBe(0);
  });

  it('uses progressively stronger visual weights', () => {
    expect(focusFontWeight('light')).toBeLessThan(focusFontWeight('medium'));
    expect(focusFontWeight('medium')).toBeLessThan(focusFontWeight('strong'));
  });
});
