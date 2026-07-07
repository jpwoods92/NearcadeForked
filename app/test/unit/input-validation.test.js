import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  _clampAxis, _clampTrigger, _clampButtons, _clampDelta,
  _validateGamepadMsg, _validateKbmMsg,
} = require('../../src/sidecar/input_backends/validation.js');

// Characterization tests (REFACTOR_PLAN.md Phase 8) for the payload
// clamping/validation split out of InputOrchestrator.js. These guard against
// malicious/corrupted viewer payloads reaching the native uinput bridge —
// previously untested code, now its own small module.

describe('clamp helpers', () => {
  it('_clampAxis clamps to -32767..32767 and coerces non-numbers to 0', () => {
    expect(_clampAxis(999999)).toBe(32767);
    expect(_clampAxis(-999999)).toBe(-32767);
    expect(_clampAxis('nope')).toBe(0);
    expect(_clampAxis(undefined)).toBe(0);
  });

  it('_clampTrigger clamps to 0..1', () => {
    expect(_clampTrigger(5)).toBe(1);
    expect(_clampTrigger(-5)).toBe(0);
    expect(_clampTrigger(0.5)).toBe(0.5);
  });

  it('_clampButtons strips the GUIDE/HOME bit (0x4000) so viewers cannot open system menus', () => {
    expect(_clampButtons(0x4000)).toBe(0);
    expect(_clampButtons(0x4001)).toBe(0x0001);
  });

  it('_clampDelta clamps mouse deltas to -4096..4096', () => {
    expect(_clampDelta(999999)).toBe(4096);
    expect(_clampDelta(-999999)).toBe(-4096);
  });
});

describe('_validateGamepadMsg', () => {
  it('normalizes a well-formed gamepad message', () => {
    const out = _validateGamepadMsg({ pad_id: 'v1', buttons: 5, lx: 100, ly: -100, lt: 0.5, rt: 2 });
    expect(out).toMatchObject({ type: 'gamepad', pad_id: 'v1', buttons: 5, lx: 100, ly: -100, lt: 0.5, rt: 1 });
  });

  it('rejects an oversized payload', () => {
    const huge = { pad_id: 'v1', axes: new Array(10000).fill(1) };
    expect(_validateGamepadMsg(huge)).toBeNull();
  });

  it('truncates pad_id/viewerId to 64 characters', () => {
    const longId = 'x'.repeat(200);
    const out = _validateGamepadMsg({ pad_id: longId });
    expect(out.pad_id.length).toBe(64);
  });

  it('strips the GUIDE bit from buttons via _clampButtons', () => {
    const out = _validateGamepadMsg({ pad_id: 'v1', buttons: 0x4000 });
    expect(out.buttons).toBe(0);
  });
});

describe('_validateKbmMsg', () => {
  it('accepts known event types', () => {
    expect(_validateKbmMsg({ pad_id: 'v1', event: 'keydown', key: 'KEY_W' })).toMatchObject({
      pad_id: 'v1', event: 'keydown', key: 'KEY_W',
    });
  });

  it('rejects unknown event types', () => {
    expect(_validateKbmMsg({ pad_id: 'v1', event: 'not-a-real-event' })).toBeNull();
  });

  it('clamps mouse deltas', () => {
    const out = _validateKbmMsg({ pad_id: 'v1', event: 'mousemove', dx: 99999, dy: -99999 });
    expect(out.dx).toBe(4096);
    expect(out.dy).toBe(-4096);
  });

  it('rejects an oversized payload', () => {
    const huge = { pad_id: 'v1', event: 'keydown', key: 'x'.repeat(10000) };
    expect(_validateKbmMsg(huge)).toBeNull();
  });
});
