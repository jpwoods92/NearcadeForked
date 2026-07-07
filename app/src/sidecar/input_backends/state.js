'use strict';
// Shared mutable state for the input_backends/*.js modules — mirrors the
// app/electron/state.js pattern from Phase 4: an object whose properties get
// reassigned (bridge/pythonProc/gameProfiles/etc.), since plain `let`
// bindings can't be shared-by-reference across separate require()'d files.
// Extracted verbatim from InputOrchestrator.js's module-level state —
// REFACTOR_PLAN.md Phase 8.
const { EventEmitter } = require('events');

// ── Visualizer event bus — host.js listens on inputDriver.events ──────────────
const events = new EventEmitter();

// ── Shared Buffers for Zero-Copy Native C++ Submission ──
// Buffer layout MUST match uinputBridge.cpp exactly.
// GAMEPAD packet (16 bytes):
//   [0]     = 0x01 (PKT::GAMEPAD)
//   [1-2]   = lx  (int16LE)
//   [3-4]   = ly  (int16LE)
//   [5-6]   = rx  (int16LE)
//   [7-8]   = ry  (int16LE)
//   [9]     = lt  (uint8, 0-255)
//   [10]    = rt  (uint8, 0-255)
//   [11-12] = btn (uint16LE, C++ W3C_BTN bit format)
//   [13]    = hx  (int8, dpad X: -1/0/1)
//   [14]    = hy  (int8, dpad Y: -1/0/1)
//   [15]    = slot (uint8)
const gpBuf = Buffer.alloc(16);
const alBuf = Buffer.alloc(104);
const flBuf = Buffer.alloc(2);
const frBuf = Buffer.alloc(2);

alBuf[0] = 0x10; // PKT::ALLOC_GP
flBuf[0] = 0x20; // PKT::FLUSH
frBuf[0] = 0x11; // PKT::FREE_GP

// ── State ──────────────────────────────────────────────────────────────────────
const viewerSlots = new Map();
const slotViewers = new Map();
const viewerCtrlType = new Map();
const viewerModes = new Map();

// KBM Emulation State
const kbmStates = new Map();

// Tracks millisecond activity for Auto-Eviction
const slotLastUsed = new Map();

module.exports = {
    events,
    gpBuf, alBuf, flBuf, frBuf,
    viewerSlots, slotViewers, viewerCtrlType, viewerModes, kbmStates, slotLastUsed,

    bridge: null,
    pythonProc: null,

    gameProfiles: {},
    kbmBindings: { keys: {}, mouse: { sensitivity: 1.5, deadzone: 0.1 } },

    // Global default profile key — updated whenever the host broadcasts ctrl-settings.
    // This ensures all newly allocated slots inherit the host's chosen controller type
    // rather than always falling back to xbox360.
    defaultProfileKey: 'xbox360',
    hybridInputEnabled: false,
};
