import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseSinkInputs, parseSinks, isBlacklisted, DEFAULT_BLACKLIST } = require('../../src/sidecar/audio_blacklist_daemon.js');

// Characterization tests (REFACTOR_PLAN.md Phase 0 / Phase 8) for the pactl
// output parsers in audio_blacklist_daemon.js. This is one of four places in
// the repo that reimplements PulseAudio/pactl routing (see also
// electron-main.js, server.js, audio_worker.js) — pinning down this file's
// parsing behavior now means Phase 8's consolidation into a single
// server/audio-routing.js module has a baseline to verify against.

const SINK_INPUTS_SAMPLE = `Sink Input #142
	Driver: protocol-native.c
	Sink: 3
	client.id = "87"
	application.name = "Discord"
	application.process.binary = "discord"
	application.process.id = "5521"
	node.name = "discord"
	media.name = "playback"

Sink Input #150
	Driver: protocol-native.c
	Sink: 3
	client.id = "91"
	application.name = "Firefox"
	application.process.binary = "firefox"
	node.name = "firefox"
	media.name = "AudioStream"
`;

const SINKS_SAMPLE = `3	NearsecVirtual	module-null-sink.c	s16le 2ch 48000Hz	RUNNING
4	alsa_output.pci-0000_00_1f.3.analog-stereo	module-alsa-card.c	s16le 2ch 48000Hz	SUSPENDED
`;

describe('parseSinkInputs', () => {
  it('extracts identity fields for every "Sink Input #N" block', () => {
    const inputs = parseSinkInputs(SINK_INPUTS_SAMPLE);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      id: '142',
      sinkId: '3',
      appBinary: 'discord',
      appName: 'Discord',
      nodeName: 'discord',
      mediaName: 'playback',
      clientKey: '87',
    });
  });

  it('falls back clientKey to the process id, then the sink-input id, when client.id is absent', () => {
    const noClientId = `Sink Input #7
	Sink: 3
	application.process.id = "999"
	application.process.binary = "spotify"
`;
    const [input] = parseSinkInputs(noClientId);
    expect(input.clientKey).toBe('999');

    const noIdentityAtAll = `Sink Input #8
	Sink: 3
	application.process.binary = "mystery"
`;
    const [input2] = parseSinkInputs(noIdentityAtAll);
    expect(input2.clientKey).toBe('8');
  });

  it('returns an empty array for empty/falsy input', () => {
    expect(parseSinkInputs('')).toEqual([]);
    expect(parseSinkInputs(null)).toEqual([]);
  });
});

describe('parseSinks', () => {
  it('builds byName and byId lookup maps from `pactl list short sinks` output', () => {
    const { byName, byId } = parseSinks(SINKS_SAMPLE);
    expect(byId['3']).toBe('NearsecVirtual');
    expect(byName['NearsecVirtual']).toBe('3');
    expect(byName['alsa_output.pci-0000_00_1f.3.analog-stereo']).toBe('4');
  });

  it('ignores blank lines and returns empty maps for empty input', () => {
    const { byName, byId } = parseSinks('');
    expect(byName).toEqual({});
    expect(byId).toEqual({});
  });
});

describe('isBlacklisted', () => {
  it('matches case-insensitively against any identity field in the raw block', () => {
    const [discordInput] = parseSinkInputs(SINK_INPUTS_SAMPLE);
    expect(isBlacklisted(discordInput, DEFAULT_BLACKLIST)).toBe(true);
  });

  it('does not flag an app absent from the blacklist', () => {
    const custom = `Sink Input #1
	Sink: 3
	application.process.binary = "obs"
`;
    const [input] = parseSinkInputs(custom);
    expect(isBlacklisted(input, DEFAULT_BLACKLIST)).toBe(false);
  });

  it('matches fuzzy substrings, e.g. "Vesktop (Discord)" against the "discord" entry', () => {
    const vesktop = `Sink Input #2
	Sink: 3
	application.name = "Vesktop (Discord)"
	application.process.binary = "vesktop"
`;
    const [input] = parseSinkInputs(vesktop);
    expect(isBlacklisted(input, DEFAULT_BLACKLIST)).toBe(true);
  });
});
