import { describe, expect, it } from 'vitest';

import {
  findIndexLine,
  lineAtByteOffset,
  morphologyCandidates,
  normalizeLookupTerm,
  parseDataLine,
  parseIndexLine,
} from './parser';

describe('WordNet parser', () => {
  it('normalizes a selected word without accepting surrounding punctuation', () => {
    expect(normalizeLookupTerm(' “Resilient!” ')).toBe('resilient');
    expect(normalizeLookupTerm('reading difficulty')).toBe('reading_difficulty');
  });

  it('adds conservative morphology candidates', () => {
    expect(morphologyCandidates('readers')).toContain('reader');
    expect(morphologyCandidates('studies')).toContain('study');
  });

  it('finds and parses an index record', () => {
    const text = [
      '  WordNet license header',
      'resilient a 2 2 & + 2 0 02288300 00847134  ',
      'resinous a 1 1 & 1 0 02289003',
    ].join('\n');
    const line = findIndexLine(text, 'resilient');

    expect(line).not.toBeNull();
    expect(parseIndexLine(line ?? '')).toEqual({
      lemma: 'resilient',
      partOfSpeech: 'adjective',
      offsets: [2288300, 847134],
    });
  });

  it('parses definitions, synonyms, and examples from a data record', () => {
    const sense = parseDataLine(
      '00847134 00 s 03 bouncy 0 lively 0 resilient 0 001 & 00846685 a 0000 | elastic; rebounds readily; "a lively ball"; "resilient hickory"',
    );

    expect(sense).toEqual({
      partOfSpeech: 'adjective',
      definition: 'elastic; rebounds readily',
      synonyms: ['bouncy', 'lively', 'resilient'],
      examples: ['a lively ball', 'resilient hickory'],
    });
  });

  it('reads a record at an ASCII byte offset', () => {
    const bytes = new TextEncoder().encode('header\nrecord one\nrecord two\n');
    expect(lineAtByteOffset(bytes, 7)).toBe('record one');
  });
});
