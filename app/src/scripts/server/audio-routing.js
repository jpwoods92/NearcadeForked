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
    workerData: { isPackaged },
  });

  _audioWorker.on('message', (msg) => {
    switch (msg.type) {
      case 'log':
        console.log(msg.message);
        break;
      case 'error':
        console.error(msg.message);
        break;
      case 'module-ids':
        Object.assign(_vAudioModules, msg.ids);
        break;
      case 'ready':
        console.log('[VirtualAudio] Worker ready.');
        break;
      case 'destroyed':
        console.log('[VirtualAudio] Worker teardown complete.');
        break;
      case 'backend-selected':
        console.log(`[VirtualAudio] Using ${msg.backend} backend.`);
        break;
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
 * Synchronous pre-unload evacuation: move every app stream off Nearsec
 * sinks onto a real hardware sink, and repair the default sink if it points
 * at a Nearsec device. Unloading a sink that still owns streams makes
 * PipeWire "rescue" them to an arbitrary device — observed leaving apps
 * silent (rescued to a sink nobody is listening to) or half-linked with one
 * channel until the app recreates its stream. Deliberately moving them also
 * updates stream-restore's memory, so apps don't jump back onto the next
 * session's fresh sink. Must run BEFORE any module unload, in both the
 * quit path (destroyVirtualAudio) and the purge path (purgeStaleModules) —
 * the audio worker's async 'destroy' handler does its own move-back, but
 * the sync unloads below always win that race.
 */
function _evacuateNearsecSinks() {
  if (process.platform !== 'linux') return;
  const { execSync } = require('child_process');
  const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const sinkLines = sh('pactl list short sinks').split('\n').filter(Boolean);
    const nearsecSinkIds = new Set();
    let target = null;
    for (const line of sinkLines) {
      const [id, name] = line.trim().split(/\s+/);
      if (!name) continue;
      if (name.includes('Nearsec')) nearsecSinkIds.add(id);
      else if (!target) target = name;
    }

    // Prefer the sink the loopback mirror points at — that's the device the
    // user is actually listening on, not just whichever sink lists first.
    const loopbackLine = sh('pactl list short modules')
      .split('\n')
      .find((l) => l.includes('module-loopback') && l.includes('NearsecVirtual.monitor'));
    const loopbackSink = loopbackLine && (loopbackLine.match(/sink=(\S+)/) || [])[1];
    if (loopbackSink && !loopbackSink.includes('Nearsec') && sinkLines.some((l) => l.includes(loopbackSink))) {
      target = loopbackSink;
    }
    if (!target) return;

    if (sh('pactl get-default-sink').trim().includes('Nearsec')) {
      execSync(`pactl set-default-sink ${target}`, { stdio: 'ignore' });
    }

    if (nearsecSinkIds.size === 0) return;
    for (const line of sh('pactl list short sink-inputs').split('\n').filter(Boolean)) {
      const [inputId, sinkId] = line.trim().split(/\s+/);
      if (nearsecSinkIds.has(sinkId) && /^\d+$/.test(inputId)) {
        try {
          execSync(`pactl move-sink-input ${inputId} ${target}`, { stdio: 'ignore' });
        } catch (_) {}
      }
    }
  } catch (_) {}
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
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const staleIds = parseStaleModuleIds(moduleList);
    if (staleIds.length > 0) {
      console.log(`[VirtualAudio] Purging ${staleIds.length} stale PA module(s)`);
      _evacuateNearsecSinks();
      for (const id of staleIds) {
        try {
          execSync(`pactl unload-module ${id}`, { stdio: 'ignore' });
        } catch (_) {}
      }
    }
  } catch (_) {}
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
      setTimeout(() => {
        try {
          _audioWorker && _audioWorker.terminate();
        } catch (_) {}
      }, 800);
    } catch (_) {}
  }

  if (process.platform === 'linux') {
    const { execFileSync } = require('child_process');

    // Move app streams off the virtual sink and repair the default sink
    // BEFORE unloading anything — see _evacuateNearsecSinks() for why the
    // worker's own async move-back can't be relied on here.
    _evacuateNearsecSinks();

    // THE FIX: Unload loopback BEFORE the sink to prevent the audio buzz.
    // execFileSync + parseInt (upstream v3.0.2): module ids come from parsed
    // pactl output — validate as integers rather than interpolating into a
    // shell string.
    const unloadOrder = ['loopback', 'remap', 'sink'];
    for (const key of unloadOrder) {
      const id = _vAudioModules[key];
      if (id) {
        const moduleId = parseInt(id, 10);
        if (!isNaN(moduleId)) {
          try {
            execFileSync('pactl', ['unload-module', String(moduleId)], { stdio: 'ignore' });
          } catch (_) {}
          console.log(`[VirtualAudio] Cleaned up ${key} module ${moduleId}`);
        }
      }
    }

    // Belt and braces PulseAudio cleanup
    purgeStaleModules();

    // NOTE: this used to also run a `pw-cli list-objects | grep -A2 Nearsec |
    // grep 'id ' | ... pw-cli destroy` sweep plus a `pkill pw-loopback` here,
    // claiming to clean up pw-loopback nodes "created by the worker". The
    // worker never spawns pw-loopback (it is pure pactl — "Legacy Pactl
    // Mode"), and the grep pipeline also matched `node.id = "..."` property
    // lines and bled into NEIGHBORING objects, issuing `pw-cli destroy` on
    // unrelated ids — including hardware sink nodes, killing the host's
    // audio devices at app close until re-plug/power cycle. The module
    // unloads + purgeStaleModules() above already remove everything the
    // worker creates. Do not reintroduce a pw-cli object sweep.
  }
}

module.exports = {
  initVirtualAudio,
  routeGameAudio,
  stopRouting,
  destroyVirtualAudio,
  purgeStaleModules,
};
