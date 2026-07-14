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

// GNOME's org.gnome.desktop.interface accent-color setting is a name, not
// an RGB value — these are GNOME's own preset swatches (as of GNOME 47).
const GNOME_ACCENT_COLORS = {
  blue: '#3584e4',
  teal: '#19a29b',
  green: '#33ab50',
  yellow: '#f2b935',
  orange: '#f5871f',
  red: '#cf4949',
  purple: '#825ad1',
  pink: '#de5296',
  slate: '#78788b',
};

function _execQuiet(cmd, args, timeout) {
  return execFileSync(cmd, args, { encoding: 'utf-8', timeout, stdio: ['ignore', 'pipe', 'ignore'] });
}

// Ported from upstream's accent-color package (linux.js) — the fork's prior
// implementation only tried the XDG portal tier below, which several
// desktop environments (older GNOME, KDE Plasma) don't implement. Extended
// with GNOME's gsettings accent-color/gtk-theme and KDE's kreadconfig5, each
// a best-effort try/catch tier feeding into the same '#RRGGBB' contract
// dashboard.js already expects (see its '#8b5cf6' sentinel check below).
function getLinuxAccentColor() {
  try {
    const out = _execQuiet(
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
      3000
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
  } catch {
    /* best-effort */
  }

  try {
    const out = _execQuiet('gsettings', ['get', 'org.gnome.desktop.interface', 'accent-color'], 3000);
    const name = out.trim().replace(/'/g, '');
    if (GNOME_ACCENT_COLORS[name]) return GNOME_ACCENT_COLORS[name];
  } catch {
    /* best-effort */
  }

  try {
    const out = _execQuiet('gsettings', ['get', 'org.gnome.desktop.interface', 'gtk-theme'], 3000);
    if (out.toLowerCase().includes('dark')) return '#999999';
  } catch {
    /* best-effort */
  }

  try {
    const out = _execQuiet(
      'kreadconfig5',
      ['--file', 'kdeglobals', '--group', 'General', '--key', 'AccentColor'],
      3000
    );
    const parts = out.trim().split(',').map(Number);
    if (parts.length >= 3 && parts.every((n) => !isNaN(n))) {
      const [r, g, b] = parts;
      return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    }
  } catch {
    /* best-effort */
  }

  return null;
}

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
        const linuxAccent = getLinuxAccentColor();
        if (linuxAccent) return linuxAccent;
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
