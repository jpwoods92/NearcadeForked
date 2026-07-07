'use strict';
const path = require('path');
const fs = require('fs');
const { ipcMain, app, nativeImage } = require('electron');
const state = require('../state.js');

function register() {
  ipcMain.on('window-close', () => {
    if (state.runtime.win && !state.runtime.win.isDestroyed()) state.runtime.win.close();
  });
  ipcMain.on('window-minimize', () => {
    if (state.runtime.win && !state.runtime.win.isDestroyed()) state.runtime.win.minimize();
  });
  ipcMain.on('window-maximize', () => {
    const win = state.runtime.win;
    if (win && !win.isDestroyed()) {
      win.isMaximized() ? win.unmaximize() : win.maximize();
    }
  });
  ipcMain.on('window-fullscreen', () => {
    const win = state.runtime.win;
    if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
  });
  ipcMain.on('app-quit', () => {
    app.isQuiting = true;
    app.quit();
  });
  ipcMain.on('update-tray-icon', (event, iconName) => {
    const tray = state.runtime.tray;
    if (tray && !tray.isDestroyed()) {
      try {
        // This module lives at app/electron/ipc/window-controls.js — three
        // levels below the repo root these paths were originally written
        // relative to.
        const p = path.join(__dirname, '..', '..', '..', 'assets', iconName);
        if (fs.existsSync(p)) {
          const newIcon = nativeImage.createFromPath(p).resize({ height: 22 });
          tray.setImage(newIcon);
        }
      } catch (e) {
        console.error('Failed to update tray icon', e);
      }
    }
  });
}

module.exports = { register };
