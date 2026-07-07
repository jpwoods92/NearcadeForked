import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _jsBtnsToCpp } = require('../../src/sidecar/input_backends/bit-conversion.js');

// Characterization tests (REFACTOR_PLAN.md Phase 8) for the JS viewer bitmask
// -> C++ uinputBridge W3C_BTN conversion, extracted from InputOrchestrator.js.
// This file's logic was previously untested — pinning down its behavior now
// that it's its own small module, per Phase 9's "test the new small module,
// not the old giant one" guidance.

describe('_jsBtnsToCpp', () => {
  it('passes A/B/X/Y (bits 0-3) straight through', () => {
    const { cpp } = _jsBtnsToCpp(0x000F);
    expect(cpp & 0x000F).toBe(0x000F);
  });

  it('remaps LB (JS bit8) to C++ bit4 and RB (JS bit9) to C++ bit5', () => {
    expect(_jsBtnsToCpp(0x0100).cpp).toBe(0x0010);
    expect(_jsBtnsToCpp(0x0200).cpp).toBe(0x0020);
  });

  it('remaps START (JS bit12) to C++ bit9 and SELECT (JS bit13) to C++ bit8', () => {
    expect(_jsBtnsToCpp(0x1000).cpp).toBe(0x0200);
    expect(_jsBtnsToCpp(0x2000).cpp).toBe(0x0100);
  });

  it('leaves L3 (bit10) and R3 (bit11) unchanged', () => {
    expect(_jsBtnsToCpp(0x0400).cpp).toBe(0x0400);
    expect(_jsBtnsToCpp(0x0800).cpp).toBe(0x0800);
  });

  it('extracts dpad LEFT/RIGHT as hx and UP/DOWN as hy instead of button bits', () => {
    expect(_jsBtnsToCpp(0x0040)).toMatchObject({ hx: -1, hy: 0 }); // LEFT
    expect(_jsBtnsToCpp(0x0080)).toMatchObject({ hx: 1, hy: 0 });  // RIGHT
    expect(_jsBtnsToCpp(0x0010)).toMatchObject({ hx: 0, hy: -1 }); // UP
    expect(_jsBtnsToCpp(0x0020)).toMatchObject({ hx: 0, hy: 1 });  // DOWN
  });

  it('returns hx/hy of 0 when no dpad bits are set', () => {
    expect(_jsBtnsToCpp(0)).toMatchObject({ cpp: 0, hx: 0, hy: 0 });
  });

  it('drops the GUIDE bit (bit14) since the C++ side only reads a uint16', () => {
    const { cpp } = _jsBtnsToCpp(0x4000);
    expect(cpp).toBe(0);
  });

  it('combines multiple simultaneous buttons correctly', () => {
    // A + LB + START held together
    const { cpp } = _jsBtnsToCpp(0x0001 | 0x0100 | 0x1000);
    expect(cpp).toBe(0x0001 | 0x0010 | 0x0200);
  });
});
