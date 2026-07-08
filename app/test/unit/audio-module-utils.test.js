import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseStaleModuleIds, STALE_MODULE_MARKERS } = require('../../src/sidecar/audio-module-utils.js');

// parseStaleModuleIds() feeds both stale-module purge paths (audio-routing.js
// purgeStaleModules() and audio_worker.js cleanupStaleSinks()), which unload
// the returned IDs in array order. The loopback-before-sink contract is what
// prevents the orphaned loopback being rescued onto the hardware sink's own
// monitor — an audible speaker feedback burst on app start after an unclean
// shutdown. Ordering must come from the module type, not the ID: PipeWire
// reuses freed module IDs, so numeric order does not reflect load order
// (observed live: remap=...916 loaded *after* sink=...918).

// Real-world shape after ID reuse: the remap has a lower ID than the sink,
// interleaved with unrelated modules that must not match.
const MODULES_SAMPLE = `23	module-alsa-card	device_id="3"
536870916	module-remap-source	master=NearsecVirtual.monitor source_name=NearsecVirtualCapture
536870918	module-null-sink	sink_name=NearsecVirtual sink_properties=device.description="NearsecVirtual"
536870919	module-loopback	source=NearsecVirtual.monitor sink=alsa_output.usb-FIIO_FiiO_K11-01.analog-stereo latency_msec=30
536870920	module-null-sink	sink_name=SomethingElse
`;

describe('parseStaleModuleIds', () => {
  it('returns only Nearsec-owned module IDs', () => {
    const ids = parseStaleModuleIds(MODULES_SAMPLE);
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain('23');
    expect(ids).not.toContain('536870920');
  });

  it('orders loopback → remap → null-sink regardless of module IDs', () => {
    expect(parseStaleModuleIds(MODULES_SAMPLE)).toEqual(['536870919', '536870916', '536870918']);
  });

  it('unloads unknown Nearsec module types before null-sinks', () => {
    const out = parseStaleModuleIds(
      ['9\tmodule-null-sink\tsink_name=NearsecVirtual', '100\tmodule-remap-sink\tsink_name=NearsecAppAudio'].join('\n')
    );
    expect(out).toEqual(['100', '9']);
  });

  it('handles empty/undefined input and lines without numeric IDs', () => {
    expect(parseStaleModuleIds('')).toEqual([]);
    expect(parseStaleModuleIds(undefined)).toEqual([]);
    expect(parseStaleModuleIds('garbage\tNearsecVirtual line with no leading id')).toEqual([]);
  });

  it('matches every documented marker', () => {
    for (const marker of STALE_MODULE_MARKERS) {
      expect(parseStaleModuleIds(`42\tmodule-null-sink\tsink_name=${marker}`)).toEqual(['42']);
    }
  });
});
