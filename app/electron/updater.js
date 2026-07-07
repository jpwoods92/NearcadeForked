'use strict';
const { ipcMain } = require('electron');
const state = require('./state.js');

function register() {
  ipcMain.on('install-update', () => {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.quitAndInstall();
    } catch (e) {
      console.error('[electron] Failed to install update:', e);
    }
  });
}

/**
 * PUBLIC — wires up auto-update checking. Called from electron-main.js's
 * app.whenReady() handler, after createWindow() (same position the inline
 * logic used to run in).
 */
function init() {
  const settings = state.runtime.settings;
  if (settings.checkForUpdates === false) return;

  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-downloaded', (info) => {
      console.log('[electron] Update downloaded:', info.version);
      const win = state.runtime.win;
      if (win && !win.isDestroyed()) {
        win.webContents.send('update-ready', info.version);

        // Inject "Update Required" button
        win.webContents
          .executeJavaScript(
            `
          if (!document.getElementById('ns-update-btn') && window.electronAPI) {
            const btn = document.createElement('button');
            btn.id = 'ns-update-btn';
            btn.innerHTML = 'Update Required (' + '${info.version}' + ')';
            btn.style.cssText = 'position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:999999;padding:12px 24px;background:#d32f2f;color:#fff;border:none;border-radius:8px;font-family:monospace;font-weight:bold;cursor:pointer;box-shadow:0 8px 16px rgba(0,0,0,0.5);';
            btn.onclick = () => window.electronAPI.installUpdate();
            document.body.appendChild(btn);
          }
        `
          )
          .catch(() => {});
      }
    });

    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error('[electron] Auto-update check failed:', e));
  } catch (e) {
    console.error('[electron] autoUpdater error:', e);
  }
}

module.exports = { register, init };
