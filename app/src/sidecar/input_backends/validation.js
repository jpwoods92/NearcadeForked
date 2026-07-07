'use strict';
// Payload schema validation/clamping — extracted verbatim from InputOrchestrator.js.
// REFACTOR_PLAN.md Phase 8.

// ── Payload Schema Validation ─────────────────────────────────────────────────
// Malicious or corrupted viewer payloads can crash the C++ bridge or overflow
// integer buffers. Validate and clamp every field before it reaches the backend.
const MAX_PAYLOAD_BYTES = 4096;

function _clampAxis(val) {
  // Axes: -32767..+32767 as integers (already scaled by viewer.js)
  return Math.max(-32767, Math.min(32767, Number(val) || 0));
}
function _clampTrigger(val) {
  // Triggers: 0..1 float range
  return Math.max(0, Math.min(1, Number(val) || 0));
}
function _clampButtons(val) {
  // 16-bit bitmask. Strip 0x4000 (GUIDE/HOME button) so viewers cannot open system menus.
  const n = Number(val) || 0;
  return (n & 0xbfff) >>> 0;
}
function _clampDelta(val) {
  // Mouse delta: sane screen range
  return Math.max(-4096, Math.min(4096, Number(val) || 0));
}

function _validateGamepadMsg(msg) {
  // Size guard: reject absurdly large objects
  try {
    if (JSON.stringify(msg).length > MAX_PAYLOAD_BYTES) return null;
  } catch (_) {
    return null;
  }

  return {
    type: 'gamepad',
    pad_id: String(msg.pad_id || msg.viewerId || '').slice(0, 64),
    viewer_id: String(msg.viewer_id || msg.viewerId || '').slice(0, 64),
    viewerId: String(msg.viewerId || '').slice(0, 64),
    buttons: _clampButtons(msg.buttons),
    lt: _clampTrigger(msg.lt),
    rt: _clampTrigger(msg.rt),
    lx: _clampAxis(msg.lx),
    ly: _clampAxis(msg.ly),
    rx: _clampAxis(msg.rx),
    ry: _clampAxis(msg.ry),
    axes: Array.isArray(msg.axes) ? msg.axes.map(_clampAxis) : [],
    btns: Array.isArray(msg.btns)
      ? msg.btns.map((b) => ({ pressed: !!b.pressed, value: Math.max(0, Math.min(255, Number(b.value) || 0)) }))
      : [],
  };
}

function _validateKbmMsg(msg) {
  try {
    if (JSON.stringify(msg).length > MAX_PAYLOAD_BYTES) return null;
  } catch (_) {
    return null;
  }

  const event = String(msg.event || '').slice(0, 32);
  if (!['keydown', 'keyup', 'mousemove', 'mousedown', 'mouseup'].includes(event)) return null;

  return {
    type: msg.type,
    pad_id: String(msg.pad_id || msg.viewerId || '').slice(0, 64),
    viewerId: String(msg.viewerId || '').slice(0, 64),
    event,
    key: String(msg.key || '').slice(0, 32),
    button: typeof msg.button === 'number' ? msg.button : undefined,
    dx: _clampDelta(msg.dx),
    dy: _clampDelta(msg.dy),
  };
}

module.exports = {
  MAX_PAYLOAD_BYTES,
  _clampAxis,
  _clampTrigger,
  _clampButtons,
  _clampDelta,
  _validateGamepadMsg,
  _validateKbmMsg,
};
