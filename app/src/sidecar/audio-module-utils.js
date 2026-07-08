'use strict';
// Shared between server/audio-routing.js (main process, execSync),
// audio_worker.js (worker thread, async exec), and electron-main.js (main
// process, execSync) — the one place that knows which PulseAudio module
// names belong to Nearsec's virtual-audio setup and are safe to purge as
// stale leftovers from a previous run/crash. REFACTOR_PLAN.md Phase 8.
const STALE_MODULE_MARKERS = ['NearsecVirtual', 'NearsecVirtualCapture', 'NearsecAppAudio', 'NearsecAppMic'];

/** Parse `pactl list short modules` output into the numeric IDs of any
 * Nearsec-owned module, in SAFE UNLOAD ORDER: loopbacks first, null-sinks
 * last.
 *
 * Order matters: unloading the null-sink while a module-loopback still
 * captures from its monitor orphans the loopback's capture stream, which
 * PipeWire/PulseAudio then rescues onto another source — observed landing on
 * the hardware sink's own monitor, i.e. speakers feeding back into speakers
 * at full volume (the loud noise burst on app start after an unclean
 * shutdown). Same failure mode as the "unload loopback BEFORE the sink" fix
 * in destroyVirtualAudio(). Sorting by module type rather than ID because
 * PipeWire reuses freed module IDs, so numeric order does not reflect load
 * order. */
const _UNLOAD_PRIORITY = { 'module-loopback': 0, 'module-remap-source': 1, 'module-null-sink': 3 };

function parseStaleModuleIds(pactlListOutput) {
  const entries = [];
  for (const line of (pactlListOutput || '').split('\n')) {
    if (STALE_MODULE_MARKERS.some((marker) => line.includes(marker))) {
      const [id, moduleName] = line.trim().split(/\s+/);
      if (id && /^\d+$/.test(id)) entries.push({ id, priority: _UNLOAD_PRIORITY[moduleName] ?? 2 });
    }
  }
  return entries.sort((a, b) => a.priority - b.priority).map((e) => e.id);
}

module.exports = { STALE_MODULE_MARKERS, parseStaleModuleIds };
