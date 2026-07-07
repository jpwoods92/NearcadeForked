'use strict';
// Static lookup tables shared across the input_backends/*.js modules.
// Extracted verbatim from InputOrchestrator.js — REFACTOR_PLAN.md Phase 8.

const KBM_BTN_MAP = {
    'A': 0x0001, 'B': 0x0002, 'X': 0x0004, 'Y': 0x0008,
    'UP': 0x0010, 'DOWN': 0x0020, 'LEFT': 0x0040, 'RIGHT': 0x0080,
    'LB': 0x0100, 'RB': 0x0200, 'L3': 0x0400, 'R3': 0x0800,
    'START': 0x1000, 'SELECT': 0x2000, 'GUIDE': 0x4000
};

const BUTTON_ALIASES = {
    BTN_SOUTH: 'A', BTN_EAST: 'B', BTN_WEST: 'X', BTN_NORTH: 'Y',
    BTN_TL: 'LB', BTN_TR: 'RB', BTN_TL2: 'LT', BTN_TR2: 'RT',
    BTN_SELECT: 'SELECT', BTN_START: 'START',
    BTN_THUMBL: 'L3', BTN_THUMBR: 'R3',
    BTN_DPAD_UP: 'UP', BTN_DPAD_DOWN: 'DOWN', BTN_DPAD_LEFT: 'LEFT', BTN_DPAD_RIGHT: 'RIGHT'
};

const PROFILES = {
    xbox360: { vendor: 0x045E, product: 0x028E, version: 0x0114, name: "Microsoft X-Box 360 pad" },
    xbox: { vendor: 0x045E, product: 0x028E, version: 0x0114, name: "Microsoft X-Box 360 pad" },
    xboxone: { vendor: 0x045E, product: 0x02EA, version: 0x0301, name: "Microsoft X-Box One S pad" },
    ds4: { vendor: 0x054C, product: 0x05C4, version: 0x8111, name: "Sony Computer Entertainment Wireless Controller" },
    ps4: { vendor: 0x054C, product: 0x05C4, version: 0x8111, name: "Sony Computer Entertainment Wireless Controller" },
    playstation: { vendor: 0x054C, product: 0x05C4, version: 0x8111, name: "Sony Computer Entertainment Wireless Controller" },
    dualshock4: { vendor: 0x054C, product: 0x05C4, version: 0x8111, name: "Sony Computer Entertainment Wireless Controller" },
    dualsense: { vendor: 0x054C, product: 0x0CE6, version: 0x8111, name: "Sony Interactive Entertainment Wireless Controller" },
    switchpro: { vendor: 0x0500, product: 0x2009, version: 0x8111, name: "Nintendo Switch Pro Controller" },
    switch: { vendor: 0x0500, product: 0x2009, version: 0x8111, name: "Nintendo Switch Pro Controller" },
    nintendo: { vendor: 0x0500, product: 0x2009, version: 0x8111, name: "Nintendo Switch Pro Controller" }
};

module.exports = { KBM_BTN_MAP, BUTTON_ALIASES, PROFILES };
