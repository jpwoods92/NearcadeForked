'use strict';
// Composition root for the platform input pipeline — wires together the
// modules split out of what used to be a single 764-line file
// (REFACTOR_PLAN.md Phase 8): state.js (shared mutable state),
// constants.js (KBM/controller lookup tables), bit-conversion.js (JS<->C++
// button bitmask), profile-loader.js (CSV/JSON config), backend-init.js
// (native uinputBridge vs Python sidecar selection), slot-manager.js
// (gamepad slot allocation/LRU eviction), gamepad-handler.js/kbm-handler.js
// (per-input-type packet building), validation.js (payload clamping).
// Public API (init/send/destroy/events/getViewerForSlot/_bridge) is
// unchanged — server.js, server/ws.js, server/http.js, and
// server/input-bridge.js all require() this file directly.
const state = require('./state.js');
const backendInit = require('./backend-init.js');
const slotManager = require('./slot-manager.js');
const gamepadHandler = require('./gamepad-handler.js');
const kbmHandler = require('./kbm-handler.js');
const validation = require('./validation.js');

// ── Dispatcher & Exports ──────────────────────────────────────────────────────
function send(msg) {
  // ── Schema validation — drop malformed or oversized payloads silently ──────
  let validated = msg;
  if (msg.type === 'gamepad') {
    validated = validation._validateGamepadMsg(msg);
    if (!validated) {
      console.warn(`[DEBUG GP] DROPPED by validator — pad_id="${msg.pad_id}" lx=${msg.lx} btns=${msg.buttons}`);
      return; // drop
    }
    // Diagnostics: print bridge/python state so we know which path runs
    console.log(
      `[DEBUG GP] pad_id="${validated.pad_id}" bridge=${!!state.bridge} python=${!!state.pythonProc} hybrid=${state.hybridInputEnabled}`
    );
  } else if (msg.type === 'kbm' || msg.type === 'keyboard') {
    validated = validation._validateKbmMsg(msg);
    if (!validated) return; // drop
  }

  // Drop immediately if both backends are dead
  if (!state.bridge && !state.pythonProc) return;

  // Fallback passthrough to Python if Native module failed, OR if Hybrid Mode is explicitly enabled
  if ((!state.bridge || state.hybridInputEnabled) && state.pythonProc && state.pythonProc.stdin.writable) {
    try {
      state.pythonProc.stdin.write(JSON.stringify(validated) + '\n');
    } catch (e) {}

    // Ensure the input visualizer still works when using Python sidecar
    if (validated.type === 'gamepad') {
      state.events.emit('input-packet', {
        source: 'python_gamepad',
        viewerId: validated.viewer_id || validated.viewerId,
        slotIndex: 'PY',
        buttons: validated.buttons || 0,
        lt: validated.lt || 0,
        rt: validated.rt || 0,
        lx: validated.lx || 0,
        ly: validated.ly || 0,
        rx: validated.rx || 0,
        ry: validated.ry || 0,
      });
    }
    return;
  }

  if (validated.type === 'gamepad') {
    gamepadHandler._handleGamepad(validated);
  } else if (validated.type === 'kbm' || validated.type === 'keyboard') {
    console.log(`[DEBUG KBM] Orchestrator send() routing to _handleKbm`);
    kbmHandler._handleKbm(validated);
  } else if (msg.type === 'set-ctrl-type') {
    // Update per-viewer map AND the global default so new connections inherit the type
    if (msg.viewerId) state.viewerCtrlType.set(msg.viewerId, msg.ctrlType || 'xbox360');
    state.defaultProfileKey = msg.ctrlType || 'xbox360';
  } else if (msg.type === 'ctrl-settings-hybrid') {
    state.hybridInputEnabled = !!msg.enabled;
    console.log(
      `[input] Hybrid mode ${msg.enabled ? 'ENABLED: Routing via Python' : 'DISABLED: Restoring C++ bridge'}`
    );
  } else if (msg.type === 'set-input-mode') {
    state.viewerModes.set(msg.viewerId, msg.mode);
  } else if (msg.type === 'disconnect_viewer') {
    slotManager._freeSlot(msg.viewer_id);
  } else if (msg.type === 'flush_neutral') {
    const slot = state.viewerSlots.get(msg.viewer_id);
    if (slot !== undefined && state.bridge) {
      state.flBuf[1] = slot;
      state.bridge.submitInputPacket(state.flBuf);
    }
  } else if (msg.type === 'destroy_all') {
    destroy();
  }
}

function destroy() {
  for (const vid of state.viewerSlots.keys()) {
    slotManager._freeSlot(vid);
  }
  if (state.bridge && state.bridge.destroyDevice) {
    state.bridge.destroyDevice();
  }
  if (state.pythonProc) {
    if (state.pythonProc.stdin?.writable) {
      state.pythonProc.stdin.write(JSON.stringify({ type: 'destroy_all' }) + '\n');
    }
    state.pythonProc.kill();
    state.pythonProc = null;
  }
  console.log('[input] Orchestrator destroyed.');
}

function getViewerForSlot(slot) {
  return slotManager.getViewerForSlot(slot);
}

module.exports = {
  init: backendInit.init,
  send,
  destroy,
  events: state.events,
  getViewerForSlot,
  get _bridge() {
    return state.bridge;
  },
};
