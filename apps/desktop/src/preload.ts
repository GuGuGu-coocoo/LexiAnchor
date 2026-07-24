import { contextBridge, ipcRenderer } from 'electron';

import { platformChannels, type PlatformBridge } from '@lexianchor/platform';

const platformBridge: PlatformBridge = {
  target: 'desktop',
  getAppVersion() {
    return ipcRenderer.invoke(platformChannels.getAppVersion) as Promise<string>;
  },
  isFullscreen() {
    return ipcRenderer.invoke(platformChannels.isFullscreen) as Promise<boolean>;
  },
  setFullscreen(enabled) {
    return ipcRenderer.invoke(platformChannels.setFullscreen, enabled) as Promise<boolean>;
  },
};

contextBridge.exposeInMainWorld('lexiAnchor', platformBridge);
