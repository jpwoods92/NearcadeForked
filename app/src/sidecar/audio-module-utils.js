'use strict';
// Shared between server/audio-routing.js (main process, execSync),
// audio_worker.js (worker thread, async exec), and electron-main.js (main
// process, execSync) — the one place that knows which PulseAudio module
// names belong to Nearsec's virtual-audio setup and are safe to purge as
// stale leftovers from a previous run/crash. REFACTOR_PLAN.md Phase 8.
const STALE_MODULE_MARKERS = ['NearsecVirtual', 'NearsecVirtualCapture', 'NearsecAppAudio', 'NearsecAppMic'];

/** Parse `pactl list short modules` output into the numeric IDs of any
 * Nearsec-owned module. */
function parseStaleModuleIds(pactlListOutput) {
  const ids = [];
  for (const line of (pactlListOutput || '').split('\n')) {
    if (STALE_MODULE_MARKERS.some(marker => line.includes(marker))) {
      const id = line.trim().split(/\s+/)[0];
      if (id && /^\d+$/.test(id)) ids.push(id);
    }
  }
  return ids;
}

module.exports = { STALE_MODULE_MARKERS, parseStaleModuleIds };
