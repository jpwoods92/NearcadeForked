'use strict';
const state = require('./state.js');
const bitConversion = require('./bit-conversion.js');
const slotManager = require('./slot-manager.js');

// ── Emulation Handlers ─────────────────────────────────────────────────────────
function _handleGamepad(msg) {
    const viewerId = msg.pad_id;
    if (!viewerId) return;

    if (!state.bridge && !state.pythonProc) return;

    const profileKey = state.viewerCtrlType.get(viewerId) || state.defaultProfileKey || 'xbox360';
    const slotIndex = slotManager._allocateSlot(viewerId, profileKey);
    console.log(`[DEBUG GAMEPAD] Viewer ${viewerId} allocated slot ${slotIndex}`);
    if (slotIndex < 0) return;

    if (!state.bridge) return;

    // Convert JS viewer bitmask to C++ W3C_BTN format and extract dpad as hx/hy
    const { cpp: cppBtns, hx, hy } = bitConversion._jsBtnsToCpp(msg.buttons || 0);

    // Write packet in the EXACT layout uinputBridge.cpp expects.
    // axes arrive as int16 (-32767..+32767) from the normalizer — write directly.
    // lt/rt arrive as 0..1 floats from the normalizer — scale to 0..255.
    state.gpBuf[0] = 0x01;
    state.gpBuf.writeInt16LE(Math.max(-32767, Math.min(32767, msg.lx || 0)), 1);
    state.gpBuf.writeInt16LE(Math.max(-32767, Math.min(32767, msg.ly || 0)), 3);
    state.gpBuf.writeInt16LE(Math.max(-32767, Math.min(32767, msg.rx || 0)), 5);
    state.gpBuf.writeInt16LE(Math.max(-32767, Math.min(32767, msg.ry || 0)), 7);
    state.gpBuf[9] = Math.round(Math.max(0, Math.min(1, msg.lt || 0)) * 255);
    state.gpBuf[10] = Math.round(Math.max(0, Math.min(1, msg.rt || 0)) * 255);
    state.gpBuf.writeUInt16LE(cppBtns, 11);
    state.gpBuf.writeInt8(hx, 13);
    state.gpBuf.writeInt8(hy, 14);
    state.gpBuf[15] = slotIndex;

    state.bridge.submitInputPacket(state.gpBuf);
    state.events.emit('input-packet', {
        source: 'gamepad', viewerId, slotIndex,
        buttons: msg.buttons || 0,
        lt: msg.lt || 0, rt: msg.rt || 0,
        lx: msg.lx || 0, ly: msg.ly || 0,
        rx: msg.rx || 0, ry: msg.ry || 0,
    });
}

module.exports = { _handleGamepad };
