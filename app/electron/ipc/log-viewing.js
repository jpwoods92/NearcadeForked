'use strict';
const path = require('path');
const fs = require('fs');
const { ipcMain, shell } = require('electron');
const { LOG_FILE } = require('../logger.js');

function register() {
  ipcMain.on('open-log', () => {
    if (fs.existsSync(LOG_FILE)) {
      shell.openPath(LOG_FILE);
    } else {
      console.error('[electron] Log file not found at:', LOG_FILE);
    }
  });

  ipcMain.on('open-dir', () => {
    // This module lives at app/electron/ipc/log-viewing.js — three levels
    // below the repo root this path was originally written relative to.
    shell.openPath(path.join(__dirname, '..', '..', '..'));
  });
}

module.exports = { register };
