import path from 'node:path';

import { app, BrowserWindow, ipcMain, shell } from 'electron';

import { platformChannels } from '@lexianchor/platform';

function registerPlatformHandlers() {
  ipcMain.handle(platformChannels.getAppVersion, () => app.getVersion());

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
