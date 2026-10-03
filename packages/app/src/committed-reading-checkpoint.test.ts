import { describe, expect, it } from 'vitest';
import type { ReaderLocator } from '@lexianchor/reader-core';

import {
  checkpointTimestamp,
  CommittedReadingCheckpoint,
  latestReadingCheckpoint,
} from './committed-reading-checkpoint';

describe('reopening the newest persisted checkpoint', () => {
  const local = { href: 'chapter.xhtml', cfi: 'local-page', checkpointUpdatedAt: 20 };
  const database = { href: 'chapter.xhtml', cfi: 'database-page', checkpointUpdatedAt: 30 };

  it('uses an acknowledged SQLite commit when SIGKILL leaves an older local copy', () => {
    expect(latestReadingCheckpoint(local, database)).toBe(database);
  });

  it('keeps the newer local commit while a SQLite write is still in flight', () => {
    expect(latestReadingCheckpoint(database, local)).toBe(database);
  });

  it('keeps local metadata when the same commit exists in both stores', () => {
    const sameCommit = { ...database, checkpointUpdatedAt: 20 };
    expect(latestReadingCheckpoint(local, sameCommit)).toBe(local);
  });

  it('retains legacy local-first behavior when neither record has a clock', () => {
    const legacy = { href: 'chapter.xhtml#bookmark' };
    expect(latestReadingCheckpoint(legacy, { href: 'chapter.xhtml', cfi: 'legacy-db' })).toBe(
      legacy,
    );
    expect(latestReadingCheckpoint(legacy, database)).toBe(database);
    expect(latestReadingCheckpoint(local, legacy)).toBe(local);
  });

  it('falls back to the only available store without discarding its fields', () => {
    expect(latestReadingCheckpoint(undefined, database)).toBe(database);
    expect(latestReadingCheckpoint(local, undefined)).toBe(local);
    expect(latestReadingCheckpoint(undefined, undefined)).toBeUndefined();
  });

  it('does not treat malformed clocks as a newer commit', () => {
    for (const checkpointUpdatedAt of [NaN, Infinity, -1, 0]) {
      const malformed = { ...database, checkpointUpdatedAt };
      expect(checkpointTimestamp(malformed)).toBe(0);
      expect(latestReadingCheckpoint(local, malformed)).toBe(local);
    }
    for (const malformed of [null, 1, 'not-a-locator']) {
      expect(checkpointTimestamp(malformed as unknown as ReaderLocator)).toBe(0);
    }
  });
});

describe('committed reading checkpoint', () => {
  it('does not let an older React render overwrite a newer engine commit', () => {
    const state = new CommittedReadingCheckpoint();
    const first = { href: 'chapter.xhtml', cfi: 'page-one' };
    const second = { href: 'chapter.xhtml', cfi: 'page-two' };
    state.commit(first, { layoutSignature: 'single' });
    state.commit(second, { layoutSignature: 'single' });
    expect(state.enrich(first, { navigationHref: 'chapter.xhtml#old' })).toBeNull();
    expect(state.freeze()).toMatchObject({ cfi: 'page-two', layoutSignature: 'single' });
  });

  it('can enrich only the latest committed page without changing its exact CFI', () => {
    const state = new CommittedReadingCheckpoint();
    const page = { href: 'chapter.xhtml', cfi: 'exact-page', totalProgression: 0.6 };
    state.commit(page, {});
    expect(
      state.enrich(page, {
        layoutSignature: 'double',
        navigationHref: 'chapter.xhtml#subsection',
        navigationCfi: 'subsection',
      }),
    ).toEqual({
      ...page,
      layoutSignature: 'double',
      navigationHref: 'chapter.xhtml#subsection',
      navigationCfi: 'subsection',
    });
  });

  it('retains the publisher TOC target until an actual page is committed', () => {
    const state = new CommittedReadingCheckpoint();
    const page = { href: 'chapter.xhtml', cfi: 'near-subsection' };
    expect(
      state.commit(page, {
        explicitTocHref: 'chapter.xhtml#subsection',
        navigationHref: 'chapter.xhtml#subsection',
      }),
    ).toMatchObject({ href: 'chapter.xhtml#subsection', cfi: undefined });
    expect(state.commit({ ...page, cfi: 'next-page' }, {})).toMatchObject({
      href: 'chapter.xhtml',
      cfi: 'next-page',
    });
  });

  it('freezes the final checkpoint before close and rejects late commits and metadata', () => {
    const state = new CommittedReadingCheckpoint();
    const page = { href: 'chapter.xhtml', cfi: 'last-committed' };
    const final = state.commit(page, {});
    expect(state.freeze()).toBe(final);
    expect(state.commit({ ...page, cfi: 'late-preview' }, {})).toBeNull();
    expect(state.enrich(page, { explicitTocHref: 'wrong.xhtml' })).toBeNull();
    expect(state.freeze()).toBe(final);
  });

  it('does not save an unfinished TOC request as the page to reopen', () => {
    const state = new CommittedReadingCheckpoint();
    const page = { href: 'level-five.xhtml', cfi: 'last-read-page' };
    state.commit(page, {});
    expect(
      state.enrich(page, {
        explicitTocHref: 'level-seven.xhtml#subsection',
        layoutSignature: 'single',
      }),
    ).toMatchObject({ href: 'level-five.xhtml', cfi: 'last-read-page' });
    expect(state.freeze()).toMatchObject({ href: 'level-five.xhtml', cfi: 'last-read-page' });
  });

  it('does not drop a committed publisher anchor during a later metadata render', () => {
    const state = new CommittedReadingCheckpoint();
    const page = { href: 'chapter.xhtml', cfi: 'near-anchor' };
    state.commit(page, { explicitTocHref: 'chapter.xhtml#subsection' });
    expect(state.enrich(page, { layoutSignature: 'double' })).toMatchObject({
      href: 'chapter.xhtml#subsection',
      cfi: undefined,
    });
  });
});
