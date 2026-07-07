'use strict';
// Pure bit-conversion helper — extracted verbatim from InputOrchestrator.js.
// REFACTOR_PLAN.md Phase 8.

// ── Button Bitmask Converter ───────────────────────────────────────────────────
// The viewer.js uses the KBM_BTN_MAP bit layout. The C++ bridge uses a different
// W3C_BTN enum. This function converts between the two AND extracts dpad as hx/hy
// (the C++ bridge uses ABS_HAT0X/Y for dpad, not button bits).
//
// JS viewer bit layout:         C++ W3C_BTN layout:
//   bit 0  = A                    bit 0  = A       (BTN_SOUTH)
//   bit 1  = B                    bit 1  = B       (BTN_EAST)
//   bit 2  = X                    bit 2  = *Y-slot (BTN_WEST = X physical)
//   bit 3  = Y                    bit 3  = *X-slot (BTN_NORTH = Y physical)
//   bit 4  = D-Up   → hx/hy      bit 4  = LB      (BTN_TL)
//   bit 5  = D-Down → hx/hy      bit 5  = RB      (BTN_TR)
//   bit 6  = D-Left → hx/hy      bit 8  = BACK    (BTN_SELECT)
//   bit 7  = D-Right→ hx/hy      bit 9  = START   (BTN_START)
//   bit 8  = LB → C++ bit 4      bit 10 = LS      (BTN_THUMBL)
//   bit 9  = RB → C++ bit 5      bit 11 = RS      (BTN_THUMBR)
//   bit 10 = L3                   (* C++ X/Y naming is swapped but emits correctly)
//   bit 11 = R3
//   bit 12 = START → C++ bit 9
//   bit 13 = SELECT → C++ bit 8
//   bit 14 = GUIDE (C++ reads uint16 so bit16 unreachable — skip)
function _jsBtnsToCpp(jsBtns) {
    let cpp = 0;
    // A, B, X, Y — bits 0-3 pass through (C++ X/Y label swap is intentional, emits correctly)
    cpp |= (jsBtns & 0x000F);
    // LB: JS bit8 → C++ bit4
    if (jsBtns & 0x0100) cpp |= 0x0010;
    // RB: JS bit9 → C++ bit5
    if (jsBtns & 0x0200) cpp |= 0x0020;
    // L3: JS bit10 → C++ bit10 (unchanged)
    if (jsBtns & 0x0400) cpp |= 0x0400;
    // R3: JS bit11 → C++ bit11 (unchanged)
    if (jsBtns & 0x0800) cpp |= 0x0800;
    // START: JS bit12 → C++ bit9
    if (jsBtns & 0x1000) cpp |= 0x0200;
    // SELECT/BACK: JS bit13 → C++ bit8
    if (jsBtns & 0x2000) cpp |= 0x0100;
    // GUIDE: JS bit14 → C++ bit16 — uint16 can't hold bit16, skip

    // Dpad bits 4-7 → ABS_HAT values written to [13][14] in the buffer
    const hx = (jsBtns & 0x0040) ? -1 : (jsBtns & 0x0080) ? 1 : 0;  // LEFT / RIGHT
    const hy = (jsBtns & 0x0010) ? -1 : (jsBtns & 0x0020) ? 1 : 0;  // UP / DOWN
    return { cpp, hx, hy };
}

module.exports = { _jsBtnsToCpp };
