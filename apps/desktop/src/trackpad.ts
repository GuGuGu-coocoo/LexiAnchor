import { createRequire } from 'node:module';
import path from 'node:path';

import { app, type BrowserWindow } from 'electron';

import { platformChannels, type TrackpadBounds, type TrackpadSample } from '@lexianchor/platform';

// NSEventPhase values (AppKit), not Core Graphics scroll phase values.
const began = 1;
const changed = 4;
const ended = 8;
const cancelled = 16;

interface TrackpadMonitor {
  start(
    handle: Buffer,
    listener: (
      phase: number,
      momentum: number,
      deltaX: number,
      deltaY: number,
      x: number,
      y: number,
      modified: boolean,
    ) => boolean,
  ): void;
  stop(): void;
}

function parseBounds(value: unknown): TrackpadBounds | null {
  if (typeof value !== 'object' || value === null) return null;
  const { left, top, right, bottom } = value as Record<string, unknown>;
  if (
    typeof left !== 'number' ||
    typeof top !== 'number' ||
    typeof right !== 'number' ||
    typeof bottom !== 'number' ||
    ![left, top, right, bottom].every(Number.isFinite) ||
    left >= right ||
    top >= bottom
  )
    return null;
  return { left, top, right, bottom };
}

export function installTrackpadMonitor(window: BrowserWindow): void {
  const addon = process.env.LEXIANCHOR_MAC_TRACKPAD_ADDON;
  if (process.platform !== 'darwin' || app.isPackaged || !addon || !path.isAbsolute(addon)) return;
  const contents = window.webContents;
  let bounds: TrackpadBounds | null = null;
  let contact: 'undecided' | 'page' | 'other' = 'undecided';
  let ignoreMomentum = false;
  const send = (phase: TrackpadSample['phase'], deltaX = 0) =>
    contents.send(platformChannels.trackpadSample, { phase, deltaX } satisfies TrackpadSample);
  const reset = () => {
    if (contact === 'page' && !contents.isDestroyed()) send('cancel');
    contact = 'undecided';
    ignoreMomentum = false;
  };

  try {
    const native = createRequire(__filename)(addon) as TrackpadMonitor;
    native.start(window.getNativeWindowHandle(), (phase, momentum, dx, dy, x, y, modified) => {
      if (contents.isDestroyed()) return false;
      if (momentum) return ignoreMomentum;
      if (phase & began) {
        if (contact === 'page') send('cancel');
        contact = 'undecided';
      }
      if (phase & (ended | cancelled)) {
        const owned = contact === 'page';
        if (owned) {
          if (!(phase & cancelled) && dx) send('move', dx);
          send(phase & cancelled ? 'cancel' : 'end');
        }
        ignoreMomentum = owned;
        contact = 'undecided';
        return owned;
      }
      if (!(phase & (began | changed))) return contact === 'page';
      if (contact === 'page') {
        if (dx) send('move', dx);
        return true;
      }
      if (contact === 'other' || (!dx && !dy)) return false;
      const zoom = contents.getZoomFactor();
      if (
        !bounds ||
        modified ||
        Math.abs(dx) <= Math.abs(dy) * 1.15 ||
        x / zoom < bounds.left ||
        x / zoom >= bounds.right ||
        y / zoom < bounds.top ||
        y / zoom >= bounds.bottom
      ) {
        contact = 'other';
        return false;
      }
      contact = 'page';
      send('begin', dx);
      return true;
    });
    contents.ipc.on(platformChannels.trackpadBounds, (event, value: unknown) => {
      if (event.senderFrame !== contents.mainFrame) return;
      bounds = parseBounds(value);
      if (!bounds) reset();
    });
    contents.on('did-start-navigation', (details) => {
      // EPUB chapter iframes come and go during preparation. They don't own
      // the reader bounds; only a new top-level document clears them.
      if (!details.isMainFrame || details.isSameDocument) return;
      bounds = null;
      reset();
    });
    window.on('blur', reset);
    window.once('closed', () => native.stop());
  } catch (error) {
    console.warn('Native Mac trackpad unavailable; using browser wheel input.', error);
  }
}
