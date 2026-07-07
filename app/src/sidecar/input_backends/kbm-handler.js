'use strict';
// NOTE: this file's own functions use a local variable named 'state' for
// per-viewer KBM emulation state (buttons/lx/ly/keys/etc) — the shared
// module state is imported as 'sharedState' to avoid that local shadowing it.
const sharedState = require('./state.js');
const constants = require('./constants.js');
const bitConversion = require('./bit-conversion.js');
const slotManager = require('./slot-manager.js');

// Extracted verbatim from InputOrchestrator.js — REFACTOR_PLAN.md Phase 8.
function _emitKbmBinding(padId, key, isDown, binds) {
  const isFlat = typeof Object.values(binds)[0] === 'string';
  const slotIdx = sharedState.viewerSlots.get(padId);
  if (slotIdx === undefined) return;

  // Grab or initialize the persistent state for this KBM user
  let state = sharedState.kbmStates.get(padId);
  if (!state) {
    state = { buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0, hx: 0, hy: 0, lt: 0, rt: 0 };
    sharedState.kbmStates.set(padId, state);
  }

  if (isFlat) {
    const target = binds[key];
    if (!target) return;

    const aliasMap = { BTN_SOUTH: 'BTN_A', BTN_EAST: 'BTN_B', BTN_NORTH: 'BTN_X', BTN_WEST: 'BTN_Y' };
    const resolved = aliasMap[target] || target;

    if (resolved.startsWith('BTN_')) {
      // Map Linux BTN_ names to the JS constants.KBM_BTN_MAP bit positions
      const btnBit = {
        BTN_A: 0x0001,
        BTN_B: 0x0002,
        BTN_X: 0x0004,
        BTN_Y: 0x0008,
        BTN_TL: 0x0100,
        BTN_TR: 0x0200,
        BTN_SELECT: 0x2000,
        BTN_START: 0x1000,
        BTN_THUMBL: 0x0400,
        BTN_THUMBR: 0x0800,
        BTN_MODE: 0x4000,
      }[resolved];

      if (btnBit !== undefined) {
        if (isDown) state.buttons |= btnBit;
        else state.buttons &= ~btnBit;
      }
    } else if (resolved.startsWith('ABS_')) {
      // Apply axis values
      if (resolved === 'ABS_Y_UP') state.ly = isDown ? -32767 : 0;
      if (resolved === 'ABS_Y_DOWN') state.ly = isDown ? 32767 : 0;
      if (resolved === 'ABS_X_LEFT') state.lx = isDown ? -32767 : 0;
      if (resolved === 'ABS_X_RIGHT') state.lx = isDown ? 32767 : 0;
    }
  } else {
    // Nested JSON logic
    const btnTarget = binds.buttons?.[key];
    if (btnTarget) {
      const btnBit = { BTN_A: 0x0001, BTN_B: 0x0002, BTN_X: 0x0004, BTN_Y: 0x0008 }[btnTarget];
      if (btnBit !== undefined) {
        if (isDown) state.buttons |= btnBit;
        else state.buttons &= ~btnBit;
      }
    }
    for (const section of ['left_stick', 'dpad']) {
      const m = binds[section]?.[key];
      if (m) {
        if (m.axis === 'ABS_X') state.lx = isDown ? m.val : 0;
        if (m.axis === 'ABS_Y') state.ly = isDown ? m.val : 0;
      }
    }
  }

  // Now send the FULL PERSISTENT STATE to the C++ module using correct buffer layout
  sharedState.gpBuf.fill(0, 0, 16);
  sharedState.gpBuf[0] = 0x01; // PKT::GAMEPAD
  // state.buttons uses the JS constants.KBM_BTN_MAP format — convert before writing
  const { cpp: cppBtns, hx: kbmHx, hy: kbmHy } = bitConversion._jsBtnsToCpp(state.buttons);
  // Axes in _emitKbmBinding are already in -32767..+32767 integer range
  sharedState.gpBuf.writeInt16LE(state.lx || 0, 1);
  sharedState.gpBuf.writeInt16LE(state.ly || 0, 3);
  sharedState.gpBuf.writeInt16LE(state.rx || 0, 5);
  sharedState.gpBuf.writeInt16LE(state.ry || 0, 7);
  sharedState.gpBuf[9] = Math.round((state.lt || 0) * 255);
  sharedState.gpBuf[10] = Math.round((state.rt || 0) * 255);
  sharedState.gpBuf.writeUInt16LE(cppBtns, 11);
  sharedState.gpBuf.writeInt8(kbmHx, 13);
  sharedState.gpBuf.writeInt8(kbmHy, 14);
  sharedState.gpBuf[15] = slotIdx;

  sharedState.bridge.submitInputPacket(sharedState.gpBuf);
}

function _handleKbm(msg) {
  const viewerId = msg.pad_id || msg.viewerId + '_0';
  if (!viewerId) return;

  const profileKey = sharedState.viewerCtrlType.get(viewerId) || sharedState.defaultProfileKey || 'xbox360';
  const slotIndex = slotManager._allocateSlot(viewerId, profileKey);
  if (slotIndex < 0) {
    console.log(`[DEBUG KBM] _handleKbm dropped due to slotIndex < 0`);
    return;
  }

  let state = sharedState.kbmStates.get(viewerId);
  if (!state) {
    state = { buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0, keys: {} };
    sharedState.kbmStates.set(viewerId, state);
  }

  // --- THE FIX: Built-in default layout matching viewer.js 'KEY_' prefix ---
  const defaultKeys = {
    KEY_W: 'LS_UP',
    KEY_A: 'LS_LEFT',
    KEY_S: 'LS_DOWN',
    KEY_D: 'LS_RIGHT',
    KEY_SPACE: 'A',
    KEY_LEFTSHIFT: 'L3',
    KEY_LEFTCTRL: 'B',
    KEY_ESC: 'START',
    KEY_TAB: 'SELECT',
    KEY_E: 'X',
    KEY_R: 'Y',
    KEY_F: 'LB',
    KEY_G: 'RB',
    KEY_C: 'R3',
    KEY_UP: 'UP',
    KEY_DOWN: 'DOWN',
    KEY_LEFT: 'LEFT',
    KEY_RIGHT: 'RIGHT',
    BTN_LEFT: 'RT',
    BTN_RIGHT: 'LT',
    BTN_MIDDLE: 'RB',
  };

  let flatKeys = { ...defaultKeys };
  if (typeof sharedState.kbmBindings !== 'undefined' && sharedState.kbmBindings) {
    if (sharedState.kbmBindings.buttons) {
      for (const [k, v] of Object.entries(sharedState.kbmBindings.buttons)) {
        if (!v) continue;
        const normalized = String(v).trim().toUpperCase();
        flatKeys[k] = constants.BUTTON_ALIASES[normalized] || normalized.replace(/^BTN_/, '');
      }
    }
    if (sharedState.kbmBindings.left_stick) {
      for (const [k, v] of Object.entries(sharedState.kbmBindings.left_stick)) {
        if (v.axis === 'ABS_Y') flatKeys[k] = v.val < 0 ? 'LS_UP' : 'LS_DOWN';
        if (v.axis === 'ABS_X') flatKeys[k] = v.val < 0 ? 'LS_LEFT' : 'LS_RIGHT';
      }
    }
    if (sharedState.kbmBindings.right_stick) {
      for (const [k, v] of Object.entries(sharedState.kbmBindings.right_stick)) {
        if (v.axis === 'ABS_RY') flatKeys[k] = v.val < 0 ? 'RS_UP' : 'RS_DOWN';
        if (v.axis === 'ABS_RX') flatKeys[k] = v.val < 0 ? 'RS_LEFT' : 'RS_RIGHT';
      }
    }
    if (sharedState.kbmBindings.dpad) {
      for (const [k, v] of Object.entries(sharedState.kbmBindings.dpad)) {
        if (v.axis === 'ABS_HAT0Y') flatKeys[k] = v.val < 0 ? 'UP' : 'DOWN';
        if (v.axis === 'ABS_HAT0X') flatKeys[k] = v.val < 0 ? 'LEFT' : 'RIGHT';
      }
    }
    if (sharedState.kbmBindings.triggers) {
      for (const [k, v] of Object.entries(sharedState.kbmBindings.triggers)) {
        flatKeys[k] = String(v).toUpperCase();
      }
    }
  }
  const layout = {
    keys: flatKeys,
    mouse: {
      sensitivity: sharedState.kbmBindings?.right_stick_multiplier
        ? sharedState.kbmBindings.right_stick_multiplier / 1000
        : 1.5,
      deadzone: 0.1,
    },
  };

  if (msg.event === 'keydown' || msg.event === 'keyup') {
    // Try the loaded layout first, fallback to the hardcoded default
    const action = layout.keys[msg.key] || defaultKeys[msg.key];

    if (!action) {
      console.log(`[DEBUG KBM] _handleKbm dropped because ${msg.key} has no mapping action!`);
      return;
    }

    const isDown = msg.event === 'keydown';

    // FIX: Ignore OS key-repeats. If it's already held down,
    // do not force a release or spam the bridge. Just let the game read the continuous hold.
    if (state.keys[action] === isDown) {
      return;
    }

    state.keys[action] = isDown;

    if (constants.KBM_BTN_MAP[action]) {
      if (isDown) state.buttons |= constants.KBM_BTN_MAP[action];
      else state.buttons &= ~constants.KBM_BTN_MAP[action];
    } else if (action === 'LT') {
      state.lt = isDown ? 1.0 : 0.0;
    } else if (action === 'RT') {
      state.rt = isDown ? 1.0 : 0.0;
    } else if (action.startsWith('LS_')) {
      // Revert back to -1.0 to 1.0 float range, because _sendKbmStateToBuffer multiplies by 32767
      state.lx = (state.keys['LS_RIGHT'] ? 1.0 : 0) - (state.keys['LS_LEFT'] ? 1.0 : 0);
      state.ly = (state.keys['LS_DOWN'] ? 1.0 : 0) - (state.keys['LS_UP'] ? 1.0 : 0);
    } else if (action.startsWith('RS_')) {
      state.rx = (state.keys['RS_RIGHT'] ? 1.0 : 0) - (state.keys['RS_LEFT'] ? 1.0 : 0);
      state.ry = (state.keys['RS_DOWN'] ? 1.0 : 0) - (state.keys['RS_UP'] ? 1.0 : 0);
    }
  } else if (msg.event === 'mousemove') {
    const mult = sharedState.kbmBindings?.right_stick_multiplier || 1500;
    const deadzone = 0.1; // 10% deadzone

    // Python matched formula: (dx * mult) / 32767.0 to fit into the -1.0 to 1.0 float range expected by _sendKbmStateToBuffer
    let dx = (msg.dx * mult) / 32767.0;
    let dy = (msg.dy * mult) / 32767.0;

    dx = Math.max(-1.0, Math.min(1.0, dx));
    dy = Math.max(-1.0, Math.min(1.0, dy));

    if (Math.abs(dx) < deadzone) dx = 0;
    if (Math.abs(dy) < deadzone) dy = 0;

    state.rx = dx;
    state.ry = dy;

    if (state.resetTimer) clearTimeout(state.resetTimer);
    state.resetTimer = setTimeout(() => {
      state.rx = 0;
      state.ry = 0;
      if (typeof _sendKbmStateToBuffer === 'function') _sendKbmStateToBuffer(slotIndex, state);
    }, 32); // 32ms matches the old Python timeout
  }

  if (typeof _sendKbmStateToBuffer === 'function') {
    console.log(`[DEBUG KBM] calling _sendKbmStateToBuffer: lx=${state.lx}, ly=${state.ly}, buttons=${state.buttons}`);
    _sendKbmStateToBuffer(slotIndex, state);
  }
}

// Ensure this helper function exists right below _handleKbm
function _sendKbmStateToBuffer(slotIndex, state) {
  if (!sharedState.bridge) return;

  // state.buttons uses JS constants.KBM_BTN_MAP format — convert to C++ W3C_BTN and extract dpad
  const { cpp: cppBtns, hx, hy } = bitConversion._jsBtnsToCpp(state.buttons);

  sharedState.gpBuf[0] = 0x01;
  // KBM lx/ly/rx/ry are -1..1 floats; scale to int16 range for C++
  sharedState.gpBuf.writeInt16LE(Math.round((state.lx || 0) * 32767), 1);
  sharedState.gpBuf.writeInt16LE(Math.round((state.ly || 0) * 32767), 3);
  sharedState.gpBuf.writeInt16LE(Math.round((state.rx || 0) * 32767), 5);
  sharedState.gpBuf.writeInt16LE(Math.round((state.ry || 0) * 32767), 7);
  sharedState.gpBuf[9] = Math.round((state.lt || 0) * 255);
  sharedState.gpBuf[10] = Math.round((state.rt || 0) * 255);
  sharedState.gpBuf.writeUInt16LE(cppBtns, 11);
  sharedState.gpBuf.writeInt8(hx, 13);
  sharedState.gpBuf.writeInt8(hy, 14);
  sharedState.gpBuf[15] = slotIndex;

  sharedState.bridge.submitInputPacket(sharedState.gpBuf);
  sharedState.events.emit('input-packet', {
    source: 'kbm',
    slotIndex,
    buttons: state.buttons,
    lt: state.lt,
    rt: state.rt,
    lx: state.lx,
    ly: state.ly,
    rx: state.rx,
    ry: state.ry,
  });
}

module.exports = { _emitKbmBinding, _handleKbm, _sendKbmStateToBuffer };
