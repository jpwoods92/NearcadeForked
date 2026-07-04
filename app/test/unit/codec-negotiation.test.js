import { describe, it, expect } from 'vitest';
import { loadHost } from '../helpers/browser-shims.js';

// Characterization tests (REFACTOR_PLAN.md Phase 0) for host.js's
// preferVideoCodec — the codec-sorting logic that Phase 5 will extract into
// scripts/webrtc/codec-negotiation.js. These pin down the current, somewhat
// subtle ordering rules (H264 baseline-profile-first, RTX must stay adjacent
// to its base codec) so the extraction can be verified byte-for-byte.

function codec(mimeType, sdpFmtpLine) {
  return { mimeType, sdpFmtpLine };
}

// loadHost() rebuilds document.body from the fixture, so the select's value
// must be set *after* loading, not before.
function setCodecSelect(value) {
  const select = document.getElementById('codecSelect');
  let opt = [...select.options].find((o) => o.value === value);
  if (!opt) {
    opt = document.createElement('option');
    opt.value = value;
    select.appendChild(opt);
  }
  select.value = value;
}

function fakePeerConnection(kind = 'video') {
  const calls = [];
  return {
    calls,
    getTransceivers: () => [
      {
        sender: { track: { kind } },
        setCodecPreferences: (list) => calls.push(list),
      },
    ],
  };
}

describe('preferVideoCodec', () => {
  it('returns null when the browser exposes no RTCRtpReceiver capabilities', () => {
    const host = loadHost();
    setCodecSelect('H264');
    global.RTCRtpReceiver = { getCapabilities: () => null };
    expect(host.preferVideoCodec(fakePeerConnection())).toBeNull();
  });

  it('returns null when the selected codec is not among the reported capabilities', () => {
    const host = loadHost();
    setCodecSelect('H264');
    global.RTCRtpReceiver = {
      getCapabilities: () => ({ codecs: [codec('video/vp8')] }),
    };
    expect(host.preferVideoCodec(fakePeerConnection())).toBeNull();
  });

  it('prefers the constrained-baseline (42e01f) H264 profile over a plain H264 entry earlier in the list', () => {
    const host = loadHost();
    setCodecSelect('H264');
    global.RTCRtpReceiver = {
      getCapabilities: () => ({
        codecs: [
          codec('video/H264', 'profile-level-id=42001f'), // plain baseline-ish, no 42e01f — listed first
          codec('video/H264', 'profile-level-id=42e01f'), // the one we must select despite being 2nd
          codec('video/VP8'),
        ],
      }),
    };
    const pc = fakePeerConnection('video');
    const used = host.preferVideoCodec(pc);
    expect(used).toBe('video/H264');
    const sortedList = pc.calls[0];
    expect(sortedList[0].sdpFmtpLine).toContain('42e01f');
  });

  it('keeps an adjacent RTX companion codec paired with the codec it lifts to the top', () => {
    const host = loadHost();
    setCodecSelect('H264');
    global.RTCRtpReceiver = {
      getCapabilities: () => ({
        codecs: [
          codec('video/VP8'),
          codec('video/H264', 'profile-level-id=42e01f'),
          codec('video/rtx'), // must move with H264, staying immediately after it
          codec('video/VP9'),
        ],
      }),
    };
    const pc = fakePeerConnection('video');
    host.preferVideoCodec(pc);
    const sortedList = pc.calls[0];
    expect(sortedList[0].mimeType).toBe('video/H264');
    expect(sortedList[1].mimeType).toBe('video/rtx');
  });

  it('maps the "H265" UI option to the hevc mimeType', () => {
    const host = loadHost();
    setCodecSelect('H265');
    global.RTCRtpReceiver = {
      getCapabilities: () => ({ codecs: [codec('video/hevc')] }),
    };
    const pc = fakePeerConnection('video');
    expect(host.preferVideoCodec(pc)).toBe('video/hevc');
  });

  it('only applies codec preferences to video transceivers, ignoring audio ones', () => {
    const host = loadHost();
    setCodecSelect('VP8');
    global.RTCRtpReceiver = {
      getCapabilities: () => ({ codecs: [codec('video/VP8')] }),
    };
    const pc = fakePeerConnection('audio');
    expect(host.preferVideoCodec(pc)).toBeNull();
    expect(pc.calls).toHaveLength(0);
  });

  it('swallows a rejected setCodecPreferences() call instead of throwing, and reports no codec used', () => {
    const host = loadHost();
    setCodecSelect('VP8');
    global.RTCRtpReceiver = {
      getCapabilities: () => ({ codecs: [codec('video/VP8')] }),
    };
    const pc = {
      getTransceivers: () => [
        {
          sender: { track: { kind: 'video' } },
          setCodecPreferences: () => {
            throw new Error('Invalid codec preferences');
          },
        },
      ],
    };
    let used;
    expect(() => {
      used = host.preferVideoCodec(pc);
    }).not.toThrow();
    expect(used).toBeNull();
  });
});
