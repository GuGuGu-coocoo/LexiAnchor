function isSingleWord(value: string): boolean {
  return /^[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)?$/u.test(value);
}

/**
 * Removes quotation marks and sentence punctuation only when the remaining
 * selection is one word. Phrases keep their punctuation because it can matter
 * to sentence translation.
 */
export function normalizeSelectionText(value: string): string {
  const trimmed = value.trim();
  const withoutBoundaryPunctuation = trimmed
    .replace(/^[\p{P}\p{S}]+/u, '')
    .replace(/[\p{P}\p{S}]+$/u, '');

  return isSingleWord(withoutBoundaryPunctuation) ? withoutBoundaryPunctuation : trimmed;
}

export { isSingleWord };
