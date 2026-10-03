import type { ReaderLocator } from '@lexianchor/reader-core';

export interface PersistedReadingCheckpoint extends ReaderLocator {
  readonly checkpointUpdatedAt: number;
}

export function checkpointTimestamp(locator: ReaderLocator | undefined): number {
  if (!locator || typeof locator !== 'object') return 0;
  const value = 'checkpointUpdatedAt' in locator ? locator.checkpointUpdatedAt : 0;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Chromium may lose recent localStorage writes on SIGKILL while SQLite has committed them. */
export function latestReadingCheckpoint(
  local: ReaderLocator | undefined,
  database: ReaderLocator | undefined,
): ReaderLocator | undefined {
  if (!local) return database;
  if (!database) return local;
  // Legacy locators have no comparable clock: retain their existing local-first
  // behavior. A new stamped SQLite checkpoint can supersede an old local copy.
  return checkpointTimestamp(database) > checkpointTimestamp(local) ? database : local;
}

export interface ReadingCheckpointMetadata {
  readonly explicitTocHref?: string;
  readonly layoutSignature?: string;
  readonly navigationHref?: string;
  readonly navigationCfi?: string;
}

/** A render may enrich the current commit, but may never replace a newer one. */
export class CommittedReadingCheckpoint {
  private locator: ReaderLocator | null = null;
  private checkpoint: ReaderLocator | null = null;
  private frozen = false;

  commit(locator: ReaderLocator, metadata: ReadingCheckpointMetadata): ReaderLocator | null {
    if (this.frozen) {
      return null;
    }
    this.locator = locator;
    return this.build(locator, metadata);
  }

  enrich(locator: ReaderLocator, metadata: ReadingCheckpointMetadata): ReaderLocator | null {
    if (this.frozen || locator !== this.locator || !this.checkpoint) {
      return null;
    }
    // TOC metadata can change while display() is still pending. Enrichment
    // must never turn that requested destination into a committed position.
    this.checkpoint = {
      ...this.checkpoint,
      layoutSignature: metadata.layoutSignature,
      navigationHref: metadata.navigationHref,
      navigationCfi: metadata.navigationCfi,
    };
    return this.checkpoint;
  }

  freeze(): ReaderLocator | null {
    this.frozen = true;
    return this.checkpoint;
  }

  private build(locator: ReaderLocator, metadata: ReadingCheckpointMetadata): ReaderLocator {
    const explicitHref = metadata.explicitTocHref;
    this.checkpoint = {
      ...locator,
      href: explicitHref || locator.href,
      cfi: explicitHref ? undefined : locator.cfi,
      layoutSignature: metadata.layoutSignature,
      navigationHref: metadata.navigationHref,
      navigationCfi: metadata.navigationCfi,
    };
    return this.checkpoint;
  }
}
