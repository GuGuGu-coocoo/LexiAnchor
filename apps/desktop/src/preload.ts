import { contextBridge, ipcRenderer } from 'electron';

import { platformChannels, type PlatformBridge, type TrackpadSample } from '@lexianchor/platform';

const platformBridge: PlatformBridge = {
  target: 'desktop',
  trackpad:
    process.platform === 'darwin'
      ? {
          setBounds(bounds) {
            ipcRenderer.send(platformChannels.trackpadBounds, bounds);
          },
          subscribe(callback) {
            const listener = (_event: Electron.IpcRendererEvent, sample: TrackpadSample) =>
              callback(sample);
            ipcRenderer.on(platformChannels.trackpadSample, listener);
            return () => ipcRenderer.removeListener(platformChannels.trackpadSample, listener);
          },
        }
      : undefined,
  getAppVersion() {
    return ipcRenderer.invoke(platformChannels.getAppVersion) as Promise<string>;
  },
  checkForUpdates() {
    return ipcRenderer.invoke(platformChannels.checkForUpdates) as ReturnType<
      PlatformBridge['checkForUpdates']
    >;
  },
  isFullscreen() {
    return ipcRenderer.invoke(platformChannels.isFullscreen) as Promise<boolean>;
  },
  setFullscreen(enabled) {
    return ipcRenderer.invoke(platformChannels.setFullscreen, enabled) as Promise<boolean>;
  },
  openExternal(url) {
    return ipcRenderer.invoke(platformChannels.openExternal, url) as Promise<void>;
  },
};

contextBridge.exposeInMainWorld('lexiAnchor', platformBridge);
