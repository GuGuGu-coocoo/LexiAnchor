export type RuntimeTarget = 'desktop' | 'web';

export interface PlatformBridge {
  readonly target: RuntimeTarget;
  getAppVersion(): Promise<string>;
  isFullscreen(): Promise<boolean>;
  setFullscreen(enabled: boolean): Promise<boolean>;
}

export const platformChannels = {
  getAppVersion: 'platform:get-app-version',
  isFullscreen: 'platform:is-fullscreen',
  setFullscreen: 'platform:set-fullscreen',
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
  };
}
