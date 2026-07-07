'use strict';
const state = require('./state.js');
const constants = require('./constants.js');

// ── Slot Allocator & LRU Garbage Collection ────────────────────────────────────
function _allocateSlot(viewerId, profileKey) {
  if (state.viewerSlots.has(viewerId)) {
    const s = state.viewerSlots.get(viewerId);
    state.slotLastUsed.set(s, Date.now());
    return s;
  }

  for (let i = 0; i < 16; i++) {
    if (!state.slotViewers.has(i)) {
      _claimSlot(i, viewerId, profileKey);
      return i;
    }
  }

  // SLOTS FULL: Evict oldest inactive controller
  let oldestSlot = -1;
  let oldestTime = Infinity;
  for (let i = 0; i < 16; i++) {
    const t = state.slotLastUsed.get(i) || 0;
    if (t < oldestTime) {
      oldestTime = t;
      oldestSlot = i;
    }
  }

  if (oldestSlot >= 0) {
    console.warn(`[input] Slot limit reached. Auto-evicting inactive slot ${oldestSlot}`);
    const owner = state.slotViewers.get(oldestSlot);
    _freeSlot(owner);
    _claimSlot(oldestSlot, viewerId, profileKey);
    return oldestSlot;
  }

  console.error('[input] FATAL: No free gamepad slots available');
  return -1;
}

function _claimSlot(slotIndex, viewerId, profileKey) {
  state.viewerSlots.set(viewerId, slotIndex);
  state.slotViewers.set(slotIndex, viewerId);
  state.slotLastUsed.set(slotIndex, Date.now());

  if (!state.bridge) return; // Python handles its own slots

  // Resolve the best profile: per-viewer override → host global default → xbox360
  const resolvedKey = profileKey || state.viewerCtrlType.get(viewerId) || state.defaultProfileKey || 'xbox360';
  const profile = constants.PROFILES[resolvedKey] || constants.PROFILES.xbox360;
  state.alBuf[1] = slotIndex;
  state.alBuf.writeUInt16LE(profile.vendor, 2);
  state.alBuf.writeUInt16LE(profile.product, 4);
  state.alBuf.writeUInt16LE(profile.version, 6);
  state.alBuf.fill(0, 8, 104);
  Buffer.from(profile.name).copy(state.alBuf, 8, 0, Math.min(31, profile.name.length));
  Buffer.from(viewerId).copy(state.alBuf, 40, 0, Math.min(63, viewerId.length));

  state.bridge.submitInputPacket(state.alBuf);
  console.log(`[input] ALLOC slot ${slotIndex} for ${viewerId} as ${resolvedKey} (${profile.name})`);
}

function _freeSlot(viewerId) {
  const slot = state.viewerSlots.get(viewerId);
  if (slot === undefined) return;

  if (state.bridge) {
    state.flBuf[1] = slot;
    state.bridge.submitInputPacket(state.flBuf);
    state.frBuf[1] = slot;
    state.bridge.submitInputPacket(state.frBuf);
  }

  state.viewerSlots.delete(viewerId);
  state.slotViewers.delete(slot);
  state.slotLastUsed.delete(slot);
  state.kbmStates.delete(viewerId);
}

function getViewerForSlot(slot) {
  return state.slotViewers.get(Number(slot)) || null;
}

module.exports = { _allocateSlot, _claimSlot, _freeSlot, getViewerForSlot };
