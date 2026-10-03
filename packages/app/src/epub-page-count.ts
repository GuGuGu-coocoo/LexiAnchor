import type { ReaderLocator, ReaderPreferences } from '@lexianchor/reader-core';

/** EPUB.js locations are text offsets, not pages. Count this chapter's views. */
export function epubPageCount(
  locator: ReaderLocator | undefined,
  preferences: Pick<ReaderPreferences, 'flow' | 'pageSpread'>,
): { current: number | undefined; total: number | undefined; remaining: number | undefined } {
  const columns = preferences.flow === 'paginated' && preferences.pageSpread === 'double' ? 2 : 1;
  const current = locator?.pageNumber ? Math.ceil(locator.pageNumber / columns) : undefined;
  const total = locator?.pageCount ? Math.ceil(locator.pageCount / columns) : undefined;
  return {
    current,
    total,
    remaining:
      current !== undefined && total !== undefined ? Math.max(0, total - current) : undefined,
  };
}
