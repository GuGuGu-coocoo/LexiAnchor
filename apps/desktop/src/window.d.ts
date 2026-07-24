import type { PlatformBridge } from '@lexianchor/platform';

declare global {
  interface Window {
    readonly lexiAnchor: PlatformBridge;
  }
}

export {};
