'use strict';
const { ipcMain, shell, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, execFileSync } = require('child_process');
const state = require('../state.js');
const { CONFIG_DIR, saveSettings } = require('../settings.js');

// ── First-run setup / tunnel installer / appearance IPC (upstream v3.0.2) ──
// Backs the new setup.html onboarding flow: detects whether system setup has
// run, checks/downloads tunnel binaries into <config>/bin, exposes the OS
// accent color, and reports HmBridge availability for Windows gamepad input.

function register() {
  ipcMain.handle('check-hm-bridge', () => {
    // This module lives at app/electron/ipc/ — the sidecar tree is under app/src.
    const hmPath = path.join(__dirname, '..', '..', 'src', 'sidecar', 'input_backends', 'HmBridge', 'HmBridge.exe');
    const altPath = hmPath.replace('app.asar', 'app.asar.unpacked');
    const exists = fs.existsSync(hmPath) || fs.existsSync(altPath);
    return { exists, path: fs.existsSync(hmPath) ? hmPath : fs.existsSync(altPath) ? altPath : null };
  });

  ipcMain.handle('check-system-setup', () => {
    const settings = state.runtime.settings;
    if (settings.firstRunComplete || settings.neverBotherSetup) return { needsSetup: false };
    let artifactsFound = false;
    try {
      if (process.platform === 'linux') {
        artifactsFound = fs.existsSync('/etc/udev/rules.d/99-nearsec-input.rules');
      }
    } catch {
      /* best-effort */
    }

    if (artifactsFound) {
      settings.firstRunComplete = true;
      settings.neverBotherSetup = true;
      saveSettings(settings);
      return { needsSetup: false };
    }
    return { needsSetup: true };
  });

  ipcMain.on('continue-boot', () => {
    const settings = state.runtime.settings;
    settings.firstRunComplete = true;
    settings.neverBotherSetup = true;
    saveSettings(settings);
    if (state.runtime.win && !state.runtime.win.isDestroyed()) {
      state.runtime.win.loadURL(
        `http://localhost:${state.runtime.serverPort}/dashboard?port=${state.runtime.serverPort}`
      );
    }
  });

  ipcMain.handle('check-tunnel-installed', (_event, name) => {
    const destDir = path.join(CONFIG_DIR, 'bin');
    const ext = process.platform === 'win32' ? '.exe' : '';
    const altNames = { zrok: ['zrok', 'zrok2'] };
    const names = altNames[name] || [name];
    let inConfig = false;
    for (const n of names) {
      if (fs.existsSync(path.join(destDir, n + ext))) {
        inConfig = true;
        break;
      }
    }
    let onPath = false;
    for (const n of names) {
      try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        execSync(`${cmd} ${n}`, { stdio: 'ignore' });
        onPath = true;
        break;
      } catch {
        /* best-effort */
      }
    }
    return { installed: inConfig || onPath, inConfig, onPath };
  });

  ipcMain.handle('download-tunnel', async (_event, { name, url }) => {
    const destDir = path.join(CONFIG_DIR, 'bin');
    try {
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      const ext = process.platform === 'win32' ? '.exe' : '';
      const destPath = path.join(destDir, name + ext);
      const res = await fetch(url);
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(destPath, buf);
      try {
        fs.chmodSync(destPath, 0o755);
      } catch {
        /* best-effort */
      }
      return { success: true, path: destPath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-accent-color', () => {
    try {
      if (process.platform === 'win32' || process.platform === 'darwin') {
        if (typeof systemPreferences.getAccentColor === 'function') {
          const color = systemPreferences.getAccentColor();
          if (color) return '#' + color.slice(0, 6);
        }
      }
      if (process.platform === 'linux') {
        const out = execFileSync(
          'dbus-send',
          [
            '--session',
            '--print-reply',
            '--dest=org.freedesktop.portal.Desktop',
            '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.Settings.ReadOne',
            'string:org.freedesktop.appearance',
            'string:accent-color',
          ],
          { timeout: 3000, encoding: 'utf-8' }
        );
        const doubles = [...out.matchAll(/double\s+([\d.]+)/g)];
        if (doubles.length >= 3) {
          const r = Math.round(parseFloat(doubles[0][1]) * 255)
            .toString(16)
            .padStart(2, '0');
          const g = Math.round(parseFloat(doubles[1][1]) * 255)
            .toString(16)
            .padStart(2, '0');
          const b = Math.round(parseFloat(doubles[2][1]) * 255)
            .toString(16)
            .padStart(2, '0');
          return `#${r}${g}${b}`;
        }
      }
    } catch {
      /* best-effort */
    }
    return '#8b5cf6';
  });

  ipcMain.handle('open-external', (_event, url) => {
    try {
      shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  });
}

module.exports = { register };
