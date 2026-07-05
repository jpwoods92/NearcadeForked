'use strict';
const { ipcMain } = require('electron');
const state = require('../state.js');
const { CONFIG_FILE, loadControllers, saveSettings } = require('../settings.js');

function register() {
  ipcMain.handle('get-settings', () => state.runtime.settings);
  ipcMain.handle('get-controllers', () => loadControllers());
  ipcMain.handle('save-settings', (_, s) => {
    state.runtime.settings = Object.assign(state.runtime.settings, s);
    saveSettings(state.runtime.settings);
    if (state.runtime.win) state.runtime.win.webContents.send('settings-updated', state.runtime.settings);
    return state.runtime.settings;
  });
  // hydrate-settings: merges a patch from the renderer into the config WITHOUT
  // overwriting keys the renderer doesn't know about. Used to migrate
  // localStorage-only values (ctrlSettings, quality_*, captureMethod, etc.)
  // into the authoritative config file on first load.
  ipcMain.handle('hydrate-settings', (_, patch) => {
    if (!patch || typeof patch !== 'object') return state.runtime.settings;
    state.runtime.settings = Object.assign(state.runtime.settings, patch);
    saveSettings(state.runtime.settings);
    return state.runtime.settings;
  });
  ipcMain.handle('get-config-path', () => CONFIG_FILE);

  ipcMain.handle('toggle-always-on-top', () => {
    const settings = state.runtime.settings;
    settings.alwaysOnTop = !settings.alwaysOnTop;
    if (state.runtime.win) state.runtime.win.setAlwaysOnTop(settings.alwaysOnTop);
    saveSettings(settings);
    return settings.alwaysOnTop;
  });
}

module.exports = { register };
