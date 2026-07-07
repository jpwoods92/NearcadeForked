import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const state = require('../../src/sidecar/input_backends/state.js');
const { _allocateSlot, getViewerForSlot } = require('../../src/sidecar/input_backends/slot-manager.js');

// Characterization tests (REFACTOR_PLAN.md Phase 8) for the gamepad slot
// allocator/LRU eviction split out of InputOrchestrator.js. state.js is a
// singleton module (like app/electron/state.js from Phase 4), so its Maps
// are cleared before each test to keep them isolated.
beforeEach(() => {
  state.viewerSlots.clear();
  state.slotViewers.clear();
  state.slotLastUsed.clear();
  state.kbmStates.clear();
  state.bridge = null; // no native bridge in tests — _claimSlot's packet-build path is skipped
});

describe('_allocateSlot', () => {
  it('assigns the first free slot (0) to a new viewer', () => {
    expect(_allocateSlot('viewerA')).toBe(0);
  });

  it('returns the same slot for a viewer that already has one', () => {
    const first = _allocateSlot('viewerA');
    const second = _allocateSlot('viewerA');
    expect(second).toBe(first);
  });

  it('assigns increasing slot indices to different viewers', () => {
    expect(_allocateSlot('viewerA')).toBe(0);
    expect(_allocateSlot('viewerB')).toBe(1);
    expect(_allocateSlot('viewerC')).toBe(2);
  });

  it('evicts the least-recently-used slot once all 16 are full', () => {
    for (let i = 0; i < 16; i++) _allocateSlot(`viewer${i}`);
    // viewer0 was allocated first, so it's the oldest by slotLastUsed
    const evictedSlot = _allocateSlot('viewer16');
    expect(evictedSlot).toBe(0);
    expect(getViewerForSlot(0)).toBe('viewer16');
  });

  it('touching a viewer updates its last-used time so it is not the next eviction target', () => {
    for (let i = 0; i < 16; i++) _allocateSlot(`viewer${i}`);
    // Real Date.now() calls can land in the same millisecond in a fast test
    // run, making "oldest" ambiguous — space the timestamps out explicitly
    // instead of relying on wall-clock granularity.
    for (let i = 0; i < 16; i++) state.slotLastUsed.set(i, i);
    // Re-touch viewer0 so viewer1 becomes the oldest instead
    _allocateSlot('viewer0');
    const evictedSlot = _allocateSlot('viewer17');
    expect(evictedSlot).toBe(1);
  });
});

describe('getViewerForSlot', () => {
  it('returns null for an unassigned slot', () => {
    expect(getViewerForSlot(5)).toBeNull();
  });

  it('returns the viewer id owning a slot', () => {
    _allocateSlot('viewerA');
    expect(getViewerForSlot(0)).toBe('viewerA');
  });
});
