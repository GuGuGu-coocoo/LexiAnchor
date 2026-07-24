export type RuntimeTarget = 'desktop' | 'web';

export interface PlatformBridge {
  readonly target: RuntimeTarget;
  getAppVersion(): Promise<string>;
  isFullscreen(): Promise<boolean>;
  setFullscreen(enabled: boolean): Promise<boolean>;
  openExternal(this: void, url: string): Promise<void>;
}

export const platformChannels = {
  getAppVersion: 'platform:get-app-version',
  isFullscreen: 'platform:is-fullscreen',
  setFullscreen: 'platform:set-fullscreen',
  openExternal: 'platform:open-external',
} as const;

export function createWebPlatformBridge(): PlatformBridge {
  return {
    target: 'web',
    getAppVersion() {
      return Promise.resolve('0.1.0');
    },
    isFullscreen() {
      return Promise.resolve(document.fullscreenElement !== null);
    },
    async setFullscreen(enabled) {
      if (enabled && document.fullscreenElement === null) {
        await document.documentElement.requestFullscreen();
      } else if (!enabled && document.fullscreenElement !== null) {
        await document.exitFullscreen();
      }

      return document.fullscreenElement !== null;
    },
    openExternal(url) {
      const target = new URL(url);

      if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        return Promise.reject(new Error('Only HTTP and HTTPS links can be opened.'));
      }

      window.open(target.href, '_blank', 'noopener,noreferrer');
      return Promise.resolve();
    },
  };
}
