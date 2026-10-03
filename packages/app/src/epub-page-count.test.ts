import { describe, expect, it } from 'vitest';

import { epubPageCount } from './epub-page-count';

describe('EPUB chapter page count', () => {
  it('does not display the synthetic text-location index as the page number', () => {
    expect(
      epubPageCount(
        { href: 'chapter', pageNumber: 3, pageCount: 12, totalPageNumber: 40, totalPageCount: 200 },
        { flow: 'paginated', pageSpread: 'single' },
      ),
    ).toEqual({ current: 3, total: 12, remaining: 9 });
  });

  it('counts a two-column spread as one displayed page, including the last odd column', () => {
    expect(
      epubPageCount(
        { href: 'chapter', pageNumber: 3, pageCount: 11 },
        { flow: 'paginated', pageSpread: 'double' },
      ),
    ).toEqual({ current: 2, total: 6, remaining: 4 });
    expect(
      epubPageCount(
        { href: 'chapter', pageNumber: 11, pageCount: 11 },
        { flow: 'paginated', pageSpread: 'double' },
      ),
    ).toEqual({ current: 6, total: 6, remaining: 0 });
  });

  it('does not apply spread arithmetic to continuous vertical reading', () => {
    expect(
      epubPageCount(
        { href: 'chapter', pageNumber: 3, pageCount: 11 },
        { flow: 'scrolled', pageSpread: 'double' },
      ),
    ).toEqual({ current: 3, total: 11, remaining: 8 });
  });

  it('keeps unknown pagination unknown', () => {
    expect(epubPageCount(undefined, { flow: 'paginated', pageSpread: 'single' })).toEqual({
      current: undefined,
      total: undefined,
      remaining: undefined,
    });
  });
});
