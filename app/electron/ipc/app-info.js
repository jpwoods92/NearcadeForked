'use strict';
const path = require('path');
const fs = require('fs');
const { ipcMain, desktopCapturer } = require('electron');

// This module lives at app/electron/ipc/app-info.js — three levels below the
// repo root (package.json/commit.txt) and two levels below app/ (src/docs).
function register() {
  ipcMain.handle('get-app-version', () => {
    const pkgPath = path.join(__dirname, '..', '..', '..', 'package.json');
    let version = '1.0.0';
    try { version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version; } catch (_) { }
    let commit = '';
    try { commit = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'commit.txt'), 'utf8').trim().substring(0, 7); } catch (_) { }
    return { version, commit };
  });

  ipcMain.handle('get-window-sources', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
      });
      return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), isScreen: s.id.startsWith('screen:') }));
    } catch (_) { return []; }
  });

  ipcMain.handle('read-doc', async (event, filename) => {
    if (!filename || filename.includes('..') || filename.includes('/')) throw new Error('Invalid filename');
    return fs.promises.readFile(path.join(__dirname, '..', '..', 'src', 'docs', filename), 'utf8');
  });
}

module.exports = { register };
