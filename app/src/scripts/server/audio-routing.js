'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const { parseStaleModuleIds } = require('../../sidecar/audio-module-utils.js');

const isPackaged = __dirname.includes('app.asar');

// ══════════════════════════════════════════════════════════════════════════════
// VIRTUAL AUDIO — delegated to audio_worker.js via worker_threads IPC
// The main event loop never calls pactl directly; all blocking OS shell work
// runs in the dedicated worker thread.
// ══════════════════════════════════════════════════════════════════════════════

// Module IDs are reported back by the worker so destroyVirtualAudio() can
// unload them synchronously via execSync if the worker has already exited.
const _vAudioModules = { sink: null, remap: null, loopback: null, daemonHandle: null };

// Holds a reference to the running audio worker
let _audioWorker = null;

// ── Spawn and wire the audio worker ──────────────────────────────────────────
function spawnAudioWorker() {
  if (process.platform !== 'linux') return;

  // audio_worker.js requires its sibling audio_blacklist_daemon.js directly
  // (same directory, no packaging concern) — no path needs threading through
  // workerData for that anymore. See REFACTOR_PLAN.md Phase 8.
  _audioWorker = new Worker(path.join(__dirname, '..', '..', 'sidecar', 'audio_worker.js'), {
    workerData: { isPackaged }
  });

  _audioWorker.on('message', (msg) => {
    switch (msg.type) {
      case 'log': console.log(msg.message); break;
      case 'error': console.error(msg.message); break;
      case 'module-ids': Object.assign(_vAudioModules, msg.ids); break;
      case 'ready': console.log('[VirtualAudio] Worker ready.'); break;
      case 'destroyed': console.log('[VirtualAudio] Worker teardown complete.'); break;
      case 'backend-selected': console.log(`[VirtualAudio] Using ${msg.backend} backend.`); break;
    }
  });

  _audioWorker.on('error', (e) => console.error('[audio_worker] Runtime error:', e.message));
  _audioWorker.on('exit', (code) => {
    if (code !== 0) console.warn(`[audio_worker] Exited with code ${code}`);
    _audioWorker = null;
  });

  _audioWorker.postMessage({ type: 'init' });
}

/**
 * PUBLIC — Create all virtual audio modules in sequence.
 * Attempts PipeWire native (pw-loopback) first for zero-latency capture.
 * Falls back to PulseAudio (pactl) if PipeWire is unavailable.
 * Delegates heavy shell work to audio_worker.js.
 */
function initVirtualAudio(callback) {
  if (process.platform !== 'linux') {
    if (callback) callback(false, 'Linux only');
    return;
  }

  if (!_audioWorker) {
    spawnAudioWorker();
  } else {
    _audioWorker.postMessage({ type: 'init' });
  }

  // Probe PipeWire availability and pass the result to the worker
  // so it can choose the right capture path without the main thread blocking.
  const { execFile } = require('child_process');
  execFile('pw-cli', ['info', 'all'], { timeout: 2000 }, (err) => {
    const pwAvailable = !err;
    if (_audioWorker) {
      _audioWorker.postMessage({ type: 'set-audio-backend', pipewire: pwAvailable });
      console.log(`[VirtualAudio] Backend probe: ${pwAvailable ? 'PipeWire (native)' : 'PulseAudio (legacy)'}`);
    }
  });

  if (callback && _audioWorker) {
    const onMsg = (msg) => {
      if (msg.type === 'ready') {
        _audioWorker && _audioWorker.off('message', onMsg);
        callback(true);
      } else if (msg.type === 'error') {
        _audioWorker && _audioWorker.off('message', onMsg);
        callback(false, msg.message);
      }
    };
    _audioWorker.on('message', onMsg);
  }
}

/**
 * PUBLIC — Route game audio (delegates to worker).
 */
function routeGameAudio(gameProcessName) {
  if (_audioWorker) _audioWorker.postMessage({ type: 'route', processName: gameProcessName || null });
}

/**
 * PUBLIC — Stop routing (return audio to normal desktop output).
 */
function stopRouting() {
  if (_audioWorker) _audioWorker.postMessage({ type: 'route-stop' });
}

/**
 * PUBLIC — Purge any leftover Nearsec PulseAudio modules from a previous
 * run (e.g. after a crash that skipped destroyVirtualAudio()). Synchronous
 * and safe to call before the audio worker exists — used by this module's
 * own teardown as well as electron-main.js's startup purge and
 * signal-cleanup fallback (REFACTOR_PLAN.md Phase 8 — previously each of
 * those reimplemented this same module-name matching independently).
 */
function purgeStaleModules() {
  if (process.platform !== 'linux') return;
  const { execSync } = require('child_process');
  try {
    const moduleList = execSync('pactl list short modules 2>/dev/null', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const staleIds = parseStaleModuleIds(moduleList);
    if (staleIds.length > 0) {
      console.log(`[VirtualAudio] Purging ${staleIds.length} stale PA module(s)`);
      for (const id of staleIds) {
        try { execSync(`pactl unload-module ${id}`, { stdio: 'ignore' }); } catch (_) { }
      }
    }
  } catch (_) { }
}

/**
 * PUBLIC — Full virtual audio teardown: ask the worker to destroy its
 * PipeWire/PulseAudio modules, then belt-and-braces cleanup any modules
 * that survive (e.g. because the worker already exited).
 */
function destroyVirtualAudio() {
  if (_audioWorker) {
    try {
      _audioWorker.postMessage({ type: 'destroy' });
      // Give it 800ms to run pactl teardown asynchronously, then force-terminate
      setTimeout(() => { try { _audioWorker && _audioWorker.terminate(); } catch (_) { } }, 800);
    } catch (_) { }
  }

  if (process.platform === 'linux') {
    const { execSync } = require('child_process');

    // THE FIX: Unload loopback BEFORE the sink to prevent the audio buzz
    const unloadOrder = ['loopback', 'remap', 'sink'];
    for (const key of unloadOrder) {
      const id = _vAudioModules[key];
      if (id) {
        try { execSync(`pactl unload-module ${id}`, { stdio: 'ignore' }); } catch (_) { }
        console.log(`[VirtualAudio] Cleaned up ${key} module ${id}`);
      }
    }

    // Belt and braces PulseAudio cleanup
    purgeStaleModules();

    // PipeWire node cleanup — destroy any pw-loopback nodes created by the worker
    try {
      execSync("pw-cli list-objects | grep -A2 'Nearsec' | grep 'id ' | awk '{print $2}' | tr -d ',' | xargs -r -I{} pw-cli destroy {}", { stdio: 'ignore', timeout: 2000 });
    } catch (_) { }
    // Belt-and-braces: kill any dangling pw-loopback processes we spawned
    try { execSync("pkill -f 'pw-loopback.*Nearsec'", { stdio: 'ignore' }); } catch (_) { }
  }
}

module.exports = {
  initVirtualAudio,
  routeGameAudio,
  stopRouting,
  destroyVirtualAudio,
  purgeStaleModules,
};
