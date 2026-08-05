import path from 'node:path';

import { app, BrowserWindow, ipcMain, shell } from 'electron';

import { checkLatestStableRelease, platformChannels } from '@lexianchor/platform';

// Keep this profile name stable across packaging and installer changes. The
// application bundle can be replaced without moving or deleting the separate
// userData directory derived from this name.
const stableProfileDirectoryName = 'LexiAnchor';
app.setName(stableProfileDirectoryName);

function registerPlatformHandlers() {
  ipcMain.handle(platformChannels.getAppVersion, () => app.getVersion());

  ipcMain.handle(platformChannels.checkForUpdates, () =>
    checkLatestStableRelease(app.getVersion()),
  );

  ipcMain.handle(platformChannels.isFullscreen, (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false;
  });

  ipcMain.handle(platformChannels.setFullscreen, (event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('Fullscreen state must be a boolean.');
    }

    const targetWindow = BrowserWindow.fromWebContents(event.sender);

    if (targetWindow === null) {
      return false;
    }

    targetWindow.setFullScreen(enabled);
    return targetWindow.isFullScreen();
  });

  ipcMain.handle(platformChannels.openExternal, async (_event, url: unknown) => {
    if (typeof url !== 'string') {
      throw new TypeError('External URL must be a string.');
    }

    const target = new URL(url);

    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new TypeError('Only HTTP and HTTPS links can be opened.');
    }

    await shell.openExternal(target.href);
  });
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#f2f0eb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }

    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // Multiple packaged copies share the same userData directory. Letting them
  // open the OPFS-backed SQLite pool concurrently can corrupt its file map.
  app.quit();
} else {
  app.on('second-instance', () => {
    const existingWindow = BrowserWindow.getAllWindows()[0];

    if (existingWindow) {
      if (existingWindow.isMinimized()) {
        existingWindow.restore();
      }
      existingWindow.show();
      existingWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    registerPlatformHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
