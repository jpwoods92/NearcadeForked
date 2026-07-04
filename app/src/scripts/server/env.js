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
  let p;
  if (process.platform === 'win32') p = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'NearsecTogether');
  else if (process.platform === 'darwin') p = path.join(home, 'Library', 'Application Support', 'NearsecTogether');
  else p = path.join(home, '.config', 'NearsecTogether');

  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

const dataDir = getSafeDataDir();
const envFile = path.join(dataDir, '.env');

// ── Convenience symlink for source-code devs ──────────────────────────────────
// Creates config/nearsectogether.config.json → ~/.config/NearsecTogether/…
// so you can always find/edit the live config right inside the project tree.
// Windows symlinks require elevated privilege — skip on win32.
(function ensureConfigSymlink() {
  if (process.platform === 'win32' || isPackaged) return;
  try {
    const configDir = path.join(projectRoot, 'config');
    const symlinkPath = path.join(configDir, 'nearsectogether.config.json');
    const realTarget = path.join(dataDir, 'nearsectogether.config.json');
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
    } catch (_) { /* doesn't exist yet — fall through to create */ }
    fs.symlinkSync(realTarget, symlinkPath);
    console.log('[config] Symlink: config/nearsectogether.config.json → ' + realTarget);
  } catch (e) {
    // Non-fatal — just a convenience helper
    console.warn('[config] Could not create config symlink:', e.message);
  }
})();

if (!fs.existsSync(envFile)) {
  try {
    fs.writeFileSync(envFile, `CF_TOKEN=\nCUSTOM_URL=\nZROK_RESERVED_NAME=\nUSE_VPS=false\nVPS_HOST=\nIS_VPS=false\n`);
  } catch (e) { console.warn("[env] Could not create .env file:", e.message); }
}

try {
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) process.env[match[1]] = (match[2] || '').trim().replace(/^['"]|['"]$/g, '');
    });
  }
} catch (e) { }

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
  } catch (e) { }
  return null;
}

// ── Persistent config ────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(dataDir, 'nearsectogether.config.json');
function loadConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return data && typeof data === 'object' ? data : {};
  } catch (e) { return {}; }
}
function saveConfig(updates) {
  try {
    const cfg = { ...loadConfig(), ...updates };
    const configDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { encoding: 'utf8', flag: 'w' });
    console.log("[config] Saved tunnel preference:", cfg);
    return cfg;
  } catch (e) {
    console.error("[config] Error saving config:", e.message);
    return {};
  }
}

function getAppVersionInfo() {
  let version = '1.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    version = pkg.version || '1.0.0';
  } catch (e) { /* keep default */ }
  let commit = '';
  try {
    commit = fs.readFileSync(path.join(projectRoot, 'commit.txt'), 'utf8').trim().substring(0, 7);
  } catch (e) { /* keep default */ }
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
