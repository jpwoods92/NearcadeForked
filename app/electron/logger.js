'use strict';
const path = require('path');
const fs = require('fs');
const { CONFIG_DIR } = require('./settings.js');

// ── SESSION FILE LOGGER ──
const LOG_FILE = path.join(CONFIG_DIR, 'latest.log');

function appendLog(msg) {
  try {
    fs.appendFileSync(LOG_FILE, msg + '\n');
  } catch (e) {}
}

/**
 * PUBLIC — creates latest.log and wraps console.log/console.error so every
 * call also lands in the session log file. Called once from electron-main.js's
 * boot sequence, before anything else that logs (in particular, before
 * cli-flags.js's applyConfigOverrides(), whose console.log calls are meant to
 * be captured here too — same ordering as the original inline code).
 */
function installSessionLogger() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(LOG_FILE, `--- Nearsec Session Log (${new Date().toISOString()}) ---\n`);
  } catch (e) {}

  const _nativeLog = console.log.bind(console);
  const _nativeErr = console.error.bind(console);

  console.log = function (...args) {
    _nativeLog(...args);
    const s = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch (_) {
          return String(a);
        }
      })
      .join(' ');
    appendLog(`[LOG] ${s}`);
  };

  console.error = function (...args) {
    _nativeErr(...args);
    const s = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch (_) {
          return String(a);
        }
      })
      .join(' ');
    appendLog(`[ERR] ${s}`);
  };
}

module.exports = { LOG_FILE, appendLog, installSessionLogger };
