'use strict';
const { ipcMain } = require('electron');
const state = require('../state.js');
const { saveSettings } = require('../settings.js');

// Dedicated VPS config handler — exposes only VPS fields to the renderer,
// keeping the master key separate from general settings for clarity.
function register() {
  ipcMain.handle('get-vps-config', () => {
    const settings = state.runtime.settings;
    return {
      vpsEnabled: !!settings.vpsEnabled,
      vpsUrl: String(settings.vpsUrl || ''),
      vpsMasterKey: String(settings.vpsMasterKey || ''),
    };
  });
  ipcMain.handle('save-vps-config', (_, cfg) => {
    const settings = state.runtime.settings;
    if (typeof cfg.vpsEnabled !== 'undefined') settings.vpsEnabled = !!cfg.vpsEnabled;
    if (typeof cfg.vpsUrl !== 'undefined') settings.vpsUrl = String(cfg.vpsUrl).slice(0, 512);
    if (typeof cfg.vpsMasterKey !== 'undefined') settings.vpsMasterKey = String(cfg.vpsMasterKey).slice(0, 256);

    saveSettings(settings);
    return {
      vpsEnabled: !!settings.vpsEnabled,
      vpsUrl: String(settings.vpsUrl || ''),
      vpsMasterKey: String(settings.vpsMasterKey || '')
    };
  });
}

module.exports = { register };
