'use strict';
const path = require('path');
const fs = require('fs');

// ── CONFIGURATION DIR UTILS ──
function getConfigDir() {
  const home = require('os').homedir();
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'NearsecTogether');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'NearsecTogether');
  return path.join(home, '.config', 'NearsecTogether');
}
const CONFIG_DIR = getConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'nearsectogether.config.json');
// This module lives at app/electron/settings.js — two levels below the repo
// root that these paths were originally written relative to (electron-main.js
// used to sit directly at app/, one level below root).
const BUNDLED_CONTROLLERS = path.join(__dirname, '..', '..', 'config', 'controllers.json');
const USER_CONTROLLERS = path.join(CONFIG_DIR, 'controllers.json');

const DEFAULT_CONTROLLERS = {
  'Xbox 360 Controller (XInput STANDARD GAMEPAD)': {
    lt: { type: 'btn', idx: 6 },
    rt: { type: 'btn', idx: 7 },
    rsx: 2,
    rsy: 3,
  },
  'Xbox Wireless Controller (STANDARD GAMEPAD)': {
    lt: { type: 'btn', idx: 6 },
    rt: { type: 'btn', idx: 7 },
    rsx: 2,
    rsy: 3,
  },
  'DualSense Wireless Controller (STANDARD GAMEPAD)': {
    lt: { type: 'btn', idx: 6 },
    rt: { type: 'btn', idx: 7 },
    rsx: 2,
    rsy: 3,
  },
  'Wireless Controller (STANDARD GAMEPAD)': {
    lt: { type: 'btn', idx: 6 },
    rt: { type: 'btn', idx: 7 },
    rsx: 2,
    rsy: 3,
  },
};

const DEFAULTS = {
  // Window
  encoder: 'gpu',
  codec: 'h264',
  preset: 'fast',
  alwaysOnTop: false,
  w: 1280,
  h: 800,
  // App behaviour
  tray: true,
  rumble: true,
  discordRPC: true,
  hwDecode: true,
  fpsUnlock: false,
  vsyncOff: false,
  zeroCopy: false,
  // Streaming
  hidePreviewOnStart: false,
  captureMic: false,
  // Experimental
  ffmpegExperimental: false,
  // Identity
  hostName: '',
  // Controller
  forceXboxOne: false,
  enableDualShock: false,
  enableMotion: false,
  defaultInputMode: 'gamepad',
  hybridInput: false,
  // Tunnels
  tunnelProvider: null,
  neverAsk: false,
  vpsHost: '',
  // VPS SFU routing
  vpsEnabled: false,
  vpsUrl: '',
  vpsMasterKey: '',
  // Auto-hosts
  autoHosts: [],
  // Discord RPC
  discordClientId: '1522864642953711776', // Fallback default ID
  // First run
  firstRunComplete: false,
};

function loadSettings() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (fs.existsSync(CONFIG_FILE)) {
      return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    }
    // Config missing (first run or deleted) — write defaults to disk immediately
    // so the file always exists after launch and settings persist correctly.
    const seed = Object.assign({}, DEFAULTS);
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(seed, null, 2));
    } catch (_) {}
    return seed;
  } catch (_) {}
  return Object.assign({}, DEFAULTS);
}

function loadControllers() {
  let bundled = {};
  let user = {};
  try {
    if (fs.existsSync(BUNDLED_CONTROLLERS)) {
      bundled = JSON.parse(fs.readFileSync(BUNDLED_CONTROLLERS, 'utf8'));
    }
  } catch (_) {}
  try {
    if (!fs.existsSync(USER_CONTROLLERS)) {
      if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
      const seed = Object.keys(bundled).length ? bundled : DEFAULT_CONTROLLERS;
      fs.writeFileSync(USER_CONTROLLERS, JSON.stringify(seed, null, 2));
      return seed;
    }
    user = JSON.parse(fs.readFileSync(USER_CONTROLLERS, 'utf8'));
  } catch (_) {
    user = {};
  }
  return Object.assign({}, DEFAULT_CONTROLLERS, bundled, user);
}

function saveSettings(s) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error('saveSettings:', e.message);
  }
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  BUNDLED_CONTROLLERS,
  USER_CONTROLLERS,
  DEFAULT_CONTROLLERS,
  DEFAULTS,
  loadSettings,
  loadControllers,
  saveSettings,
};
