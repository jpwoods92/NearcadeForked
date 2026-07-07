'use strict';
const { ipcMain, clipboard } = require('electron');

// FIX #22: Clipboard IPC bridge
function register() {
  ipcMain.handle('clipboard-write', (_, text) => {
    try {
      clipboard.writeText(String(text));
      return true;
    } catch (_) {
      return false;
    }
  });
  ipcMain.handle('clipboard-read', () => {
    try {
      return clipboard.readText();
    } catch (_) {
      return '';
    }
  });
}

module.exports = { register };
