'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const state = require('./state.js');
const profileLoader = require('./profile-loader.js');

// Native uinputBridge.node (Linux) vs Python sidecar (windows_vigem.py/
// mac_gamepad_bridge.py/linux_uinput.py) selection + lifecycle. Extracted
// verbatim from InputOrchestrator.js — REFACTOR_PLAN.md Phase 8.
// ── Initialization ─────────────────────────────────────────────────────────────
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function init(screenWidth, screenHeight) {
  profileLoader._loadProfiles();

  // On Windows and macOS the uinputBridge C++ addon is Linux-only.
  // Skip it entirely and go straight to the Python sidecar.
  if (!isWin && !isMac) {
    // 1. Try Native C++ Fast Lane (Linux only)
    // .node binaries cannot be require()'d from inside app.asar — must use the unpacked path.
    try {
      const nodePathRaw = path.join(__dirname, 'build', 'Release', 'uinputBridge.node');
      const nodePath = nodePathRaw.replace('app.asar', 'app.asar.unpacked');
      state.bridge = require(nodePath);
      state.bridge.initializeDevice(screenWidth || 1920, screenHeight || 1080);
      console.log(`[input] Native uinputBridge loaded: ${nodePath}`);
      return true;
    } catch (e) {
      console.warn(`[input] Native bridge failed to load (${e.message}). Falling back to Python.`);
      state.bridge = null;
    }
  } else if (isWin) {
    console.log('[input] Windows detected — skipping uinputBridge, using Python/ViGEmBus sidecar.');
  } else {
    console.log('[input] macOS detected — skipping uinputBridge, using Python/pynput sidecar.');
  }

  // 2. Python Sidecar — platform-aware script selection
  let scriptName;
  if (isWin) scriptName = 'windows_vigem.py';
  else if (isMac) scriptName = 'mac_gamepad_bridge.py';
  else scriptName = 'linux_uinput.py';
  // __dirname is already .../input_backends
  const pythonScriptRaw = path.join(__dirname, scriptName);
  const pythonScript = pythonScriptRaw.replace('app.asar', 'app.asar.unpacked');
  if (!fs.existsSync(pythonScript)) {
    console.error(`[input] FATAL: Python fallback not found at ${pythonScript}`);
    return false;
  }

  const pythonCmd = isWin ? 'python' : 'python3';
  const spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'] };
  if (isWin) spawnOpts.windowsHide = true;
  state.pythonProc = spawn(pythonCmd, [pythonScript], spawnOpts);

  state.pythonProc.stderr.on('data', (chunk) => {
    const s = chunk.toString('utf8').trim();
    if (s) console.error('[input][python stderr]', s);
  });

  // Parse stdout from the Python sidecar as JSON lines.
  // The sidecar emits structured { "type": "...", "message": "..." } payloads
  // so we can detect ViGEmBus driver failures and surface them to the Electron UI.
  let _stdoutBuf = '';
  state.pythonProc.stdout.on('data', (chunk) => {
    _stdoutBuf += chunk.toString('utf8');
    const lines = _stdoutBuf.split('\n');
    _stdoutBuf = lines.pop(); // keep incomplete last line in buffer
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Try JSON first
      try {
        const msg = JSON.parse(trimmed);
        if (msg.type === 'error') {
          console.error(`[input][python] ${msg.message}`);
          state.events.emit('input-error', { message: msg.message, code: msg.code || 'PYTHON_ERROR' });
        } else if (msg.type === 'ready') {
          console.log('[input][python] Sidecar ready:', msg.message || '');
          state.events.emit('input-ready', { message: msg.message });
        } else if (msg.type === 'log') {
          console.log('[input][python]', msg.message);
        } else if (msg.type === 'rumble') {
          // Python sidecar detected an EV_FF event on the uinput device.
          // Forward it through events so server.js can route it to the viewer.
          state.events.emit('rumble', {
            viewerId: msg.viewerId || '',
            strong: msg.strong || 0,
            weak: msg.weak || 0,
            duration: msg.duration || 200,
          });
        }
      } catch (_) {
        // Plain string log — pass through
        console.log('[input][python]', trimmed);
        // Still try to detect ViGEmBus errors in plain text output
        if (trimmed.toLowerCase().includes('vigembus') || trimmed.toLowerCase().includes('vigem')) {
          state.events.emit('input-error', { message: trimmed, code: 'VIGEMBUS_MISSING' });
        }
      }
    }
  });

  state.pythonProc.on('error', (e) => {
    console.error('[uinput] Python spawn error:', e.message);
    state.events.emit('input-error', { message: `Python sidecar failed to start: ${e.message}`, code: 'SPAWN_ERROR' });
  });
  state.pythonProc.on('close', (code) => {
    state.pythonProc = null;
    console.log(`[uinput] Python sidecar exited (code ${code})`);
    if (code !== 0 && code !== null) {
      state.events.emit('input-error', { message: `Python sidecar exited with code ${code}`, code: 'SIDECAR_EXIT' });
    }
  });

  console.log(`[input] Python sidecar started: ${pythonScript}`);
  return true;
}

module.exports = { init };
