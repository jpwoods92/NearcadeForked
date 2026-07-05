'use strict';
const { ipcMain } = require('electron');
const state = require('../state.js');
const { flags } = require('../cli-flags.js');

function register() {
  ipcMain.handle('join-session', async (event, data) => {
    // When the user clicks "Join" from the dashboard, load the viewer UI
    // and pass the host connection data in the URL
    const win = state.runtime.win;
    if (win && !win.isDestroyed()) {
      let url = data?.url || data || '';
      if (typeof url !== 'string') url = '';

      let viewerUrl = `http://localhost:${state.runtime.serverPort}/?client=1&compat=1&host=${encodeURIComponent(url)}`;
      if (data?.pin) {
        viewerUrl += `&pin=${encodeURIComponent(data.pin)}`;
      }
      if (data?.meta?.game && data.meta.game !== 'Direct Connect' && data.meta.game !== 'P2P Session') {
        viewerUrl += `&arcade=1`;
      }

      win.loadURL(viewerUrl);
    }
    return true;
  });

  // FIX #7 / openHost: version param forwarded correctly from preload
  ipcMain.on('open-host', (event, version) => {
    // FIX #7: version param ('new' | 'old') is now forwarded from preload
    const route = version === 'old' ? '/old_host' : '/host';
    const captureParams = [];
    if (flags.isWebCodecs) captureParams.push('wc=1');
    if (flags.isFFmpegCapture) captureParams.push('ffmpeg=1');
    const qs = captureParams.length ? '?' + captureParams.join('&') : '';
    const win = state.runtime.win;
    if (win && !win.isDestroyed()) win.loadURL(`http://localhost:${state.runtime.serverPort}${route}${qs}`);
  });

  ipcMain.on('back-to-dashboard-from-host', () => {
    const win = state.runtime.win;
    if (win && !win.isDestroyed()) {
      win.loadURL(`http://localhost:${state.runtime.serverPort}/dashboard?port=${state.runtime.serverPort}&noAutoHost=1`);
    }
  });

  ipcMain.on('back-to-dashboard', () => {
    const win = state.runtime.win;
    if (win && !win.isDestroyed()) {
      win.loadURL(`http://localhost:${state.runtime.serverPort}/dashboard?port=${state.runtime.serverPort}&noAutoHost=1`);
    }
  });
}

module.exports = { register };
