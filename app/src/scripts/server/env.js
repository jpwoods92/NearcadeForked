'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const isPackaged = __dirname.includes('app.asar');

// This file lives at app/src/scripts/server/env.js — four levels below the
// true repo root (server -> scripts -> src -> app -> root).
const projectRoot = path.join(__dirname, '..', '..', '..', '..');

// ── Safe App Data Pathing for Production ASAR ──
function getSafeDataDir() {
  const home = os.homedir();
  let p, legacy;
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    p = path.join(roaming, 'Nearcade');
    legacy = path.join(roaming, 'NearsecTogether');
  } else if (process.platform === 'darwin') {
    p = path.join(home, 'Library', 'Application Support', 'Nearcade');
    legacy = path.join(home, 'Library', 'Application Support', 'NearsecTogether');
  } else {
    p = path.join(home, '.config', 'Nearcade');
    legacy = path.join(home, '.config', 'NearsecTogether');
  }

  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });

  // Nearsec→Nearcade rebrand migration: users of this fork have live settings
  // under the old NearsecTogether dir. Copy them over once (never overwrite
  // anything already in the new dir; the old dir is left untouched).
  try {
    const newCfg = path.join(p, 'nearcade.config.json');
    const oldCfg = path.join(legacy, 'nearsectogether.config.json');
    if (!fs.existsSync(newCfg) && fs.existsSync(oldCfg)) {
      fs.copyFileSync(oldCfg, newCfg);
      console.log('[config] Migrated settings from', oldCfg);
    }
    const newEnv = path.join(p, '.env');
    const oldEnv = path.join(legacy, '.env');
    if (!fs.existsSync(newEnv) && fs.existsSync(oldEnv)) {
      fs.copyFileSync(oldEnv, newEnv);
      console.log('[config] Migrated .env from', oldEnv);
    }
  } catch (e) {
    console.warn('[config] Legacy settings migration failed:', e.message);
  }

  return p;
}

const dataDir = getSafeDataDir();
const envFile = path.join(dataDir, '.env');

// ── Convenience symlink for source-code devs ──────────────────────────────────
// Creates config/nearcade.config.json → ~/.config/Nearcade/…
// so you can always find/edit the live config right inside the project tree.
// Windows symlinks require elevated privilege — skip on win32.
(function ensureConfigSymlink() {
  if (process.platform === 'win32' || isPackaged) return;
  try {
    const configDir = path.join(projectRoot, 'config');
    const symlinkPath = path.join(configDir, 'nearcade.config.json');
    const realTarget = path.join(dataDir, 'nearcade.config.json');
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    try {
      const existing = fs.lstatSync(symlinkPath);
      // Remove stale symlinks or wrong files before re-creating
      if (existing.isSymbolicLink() && fs.realpathSync(symlinkPath) !== realTarget) {
        fs.unlinkSync(symlinkPath);
      } else if (!existing.isSymbolicLink()) {
        return; // A real file exists there — don't clobber it
      } else {
        return; // Already correct
      }
    } catch (_) {
      /* doesn't exist yet — fall through to create */
    }
    fs.symlinkSync(realTarget, symlinkPath);
    console.log('[config] Symlink: config/nearcade.config.json → ' + realTarget);
  } catch (e) {
    // Non-fatal — just a convenience helper
    console.warn('[config] Could not create config symlink:', e.message);
  }
})();

if (!fs.existsSync(envFile)) {
  try {
    fs.writeFileSync(envFile, `CF_TOKEN=\nCUSTOM_URL=\nZROK_RESERVED_NAME=\nUSE_VPS=false\nVPS_HOST=\nIS_VPS=false\n`);
  } catch (e) {
    console.warn('[env] Could not create .env file:', e.message);
  }
}

try {
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8')
      .split('\n')
      .forEach((line) => {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) process.env[match[1]] = (match[2] || '').trim().replace(/^['"]|['"]$/g, '');
      });
  }
} catch (e) {}

// Native fallback reader since dotenv is not in package dependencies.
// NOTE: this reads the repo-root .env (used by local source-code dev via
// bin/start.cmd), which is intentionally distinct from dataDir/.env above
// (the OS-standard per-user app-data .env parsed into process.env).
function readEnv(key) {
  if (process.env[key]) return process.env[key];
  try {
    const envPath = path.join(projectRoot, '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (let line of lines) {
        if (line.trim().startsWith(key + '=')) {
          return line.split('=')[1].trim();
        }
      }
    }
  } catch (e) {}
  return null;
}

// ── Persistent config ────────────────────────────────────────────────────────
const CONFIG_VERSION = 1;
const CONFIG_FILE = path.join(dataDir, 'nearcade.config.json');

function migrateConfig(cfg) {
  let v = cfg.configVersion || 0;
  if (v >= CONFIG_VERSION) return cfg;
  // v0 → v1: rename legacy keys if present
  if (v < 1) {
    if (cfg.discordRPC === undefined && cfg.discord_rpc !== undefined) cfg.discordRPC = cfg.discord_rpc;
    if (cfg.hostName === undefined && cfg.host_name !== undefined) cfg.hostName = cfg.host_name;
    if (cfg.checkForUpdates === undefined && cfg.autoUpdate !== undefined) cfg.checkForUpdates = cfg.autoUpdate;
    v = 1;
  }
  cfg.configVersion = CONFIG_VERSION;
  return cfg;
}

function loadConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return data && typeof data === 'object' ? migrateConfig(data) : {};
  } catch (e) {
    return {};
  }
}
function saveConfig(updates) {
  try {
    const cfg = { ...loadConfig(), ...updates, configVersion: CONFIG_VERSION };
    const configDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { encoding: 'utf8', flag: 'w' });
    console.log('[config] Saved:', cfg);
    return cfg;
  } catch (e) {
    console.error('[config] Error saving config:', e.message);
    return {};
  }
}

function getAppVersionInfo() {
  let version = '1.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    version = pkg.version || '1.0.0';
  } catch (e) {
    /* keep default */
  }
  let commit = '';
  try {
    commit = fs.readFileSync(path.join(projectRoot, 'commit.txt'), 'utf8').trim().substring(0, 7);
  } catch (e) {
    /* keep default */
  }
  return { version, commit };
}

module.exports = {
  isPackaged,
  projectRoot,
  dataDir,
  envFile,
  CONFIG_FILE,
  loadConfig,
  saveConfig,
  readEnv,
  getAppVersionInfo,
};
