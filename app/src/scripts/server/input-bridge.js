'use strict';
const inputDriver = require('../../sidecar/input_backends/InputOrchestrator.js');

function toUinput(msg) {
  // The Orchestrator handles routing to either the native binary or the Python stdin
  inputDriver.send(msg);
}

// ── Gamepad Wire-Format Normalizer ───────────────────────────────────────────
// viewer.js sends the raw Gamepad API format:
//   axes:    [lx, ly, rx, ry, ...]  as int16 (-32767..+32767)
//   buttons: [{pressed, value}...]  value is 0-255 int
// InputOrchestrator._handleGamepad expects NAMED scalar fields:
//   lx, ly, rx, ry  → int16 passed straight through to C++ buffer
//   lt, rt          → float 0..1
//   buttons         → 16-bit bitmask in JS viewer layout
//
// If msg already has named fields (Python path) it is returned as-is.
function normalizeGamepadMsg(msg) {
  // Already normalized — named axes present, nothing to do
  if (msg.lx !== undefined || !Array.isArray(msg.axes)) return msg;

  const axes = msg.axes || [];
  const btns = msg.buttons || [];

  // ── STRICT DATA VALIDATION REWRITE ──
  // Actively drop malformed or maliciously large data chunks.
  // NOTE: We do NOT reject empty arrays — an all-zero/rest state is
  // still valid and MUST be processed so that _claimSlot runs for new viewers.
  if (axes.length > 20 || btns.length > 40) {
    console.warn(`[input_validator] REJECTED: Gamepad API arrays exceed maximum size. Axes: ${axes.length}, Buttons: ${btns.length}`);
    return null;
  }

  // Axes arrive as int16 (-32767..+32767) — pass directly.
  // _validateGamepadMsg → _clampAxis handles range clamping.
  const lx = Number(axes[0]) || 0;
  const ly = Number(axes[1]) || 0;
  const rx = Number(axes[2]) || 0;
  const ry = Number(axes[3]) || 0;

  // Triggers: buttons[6]=LT, buttons[7]=RT (viewer encodes value 0-255)
  const lt = (Number((btns[6] && btns[6].value) || 0)) / 255;
  const rt = (Number((btns[7] && btns[7].value) || 0)) / 255;

  //  W3C Gamepad API index → JS viewer bitmask (correct per W3C spec)
  const W3C_TO_JS = [
    0x0001, // 0  A (South)
    0x0002, // 1  B (East)
    0x0004, // 2  X (West)
    0x0008, // 3  Y (North)
    0x0100, // 4  LB
    0x0200, // 5  RB
    0,      // 6  LT — handled as lt float above
    0,      // 7  RT — handled as rt float above
    0x2000, // 8  Select / Back
    0x1000, // 9  Start
    0x0400, // 10 L3
    0x0800, // 11 R3
    0x0010, // 12 D-Up
    0x0020, // 13 D-Down
    0x0040, // 14 D-Left
    0x0080, // 15 D-Right
    0x4000, // 16 Guide / Home
  ];
  let buttons = 0;
  for (let i = 0; i < btns.length && i < W3C_TO_JS.length; i++) {
    if (!W3C_TO_JS[i]) continue;
    if (btns[i] && (btns[i].pressed || btns[i].value > 127)) buttons |= W3C_TO_JS[i];
  }

  return {
    ...msg,
    axes, btns, // Preserving varying length arrays for python sidecar
    lx, ly, rx, ry, lt, rt, buttons,
  };
}

module.exports = { toUinput, normalizeGamepadMsg };
