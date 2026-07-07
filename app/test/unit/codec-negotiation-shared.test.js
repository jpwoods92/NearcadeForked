import { describe, it, expect } from 'vitest';
import { extractPreferredCodec } from '../../src/scripts/webrtc/codec-negotiation.js';
import { loadViewer } from '../helpers/browser-shims.js';

// Characterization tests for extractPreferredCodec() (REFACTOR_PLAN.md
// Phase 5.3) — the codec-reorder/RTX-adjacency primitive shared by host.js's
// preferVideoCodec (see codec-negotiation.test.js) and viewer.js's
// preferReceiverCodec (tested below, previously uncovered).

function codec(mimeType, sdpFmtpLine) {
  return { mimeType, sdpFmtpLine };
}

describe('extractPreferredCodec()', () => {
  it('returns [] when the mime is not present', () => {
    const codecs = [codec('video/VP8')];
    expect(extractPreferredCodec(codecs, 'video/H264')).toEqual([]);
    expect(codecs).toHaveLength(1); // untouched
  });

  it('prefers the constrained-baseline (42e01f) H264 profile over a plain H264 entry earlier in the list', () => {
    const codecs = [
      codec('video/H264', 'profile-level-id=42001f'),
      codec('video/H264', 'profile-level-id=42e01f'),
      codec('video/VP8'),
    ];
    const removed = extractPreferredCodec(codecs, 'video/H264');
    expect(removed).toHaveLength(1);
    expect(removed[0].sdpFmtpLine).toContain('42e01f');
    // Spliced out of the original array in place.
    expect(codecs).toHaveLength(2);
  });

  it('keeps an adjacent RTX companion codec paired with the extracted codec', () => {
    const codecs = [
      codec('video/VP8'),
      codec('video/H264', 'profile-level-id=42e01f'),
      codec('video/rtx'),
      codec('video/VP9'),
    ];
    const removed = extractPreferredCodec(codecs, 'video/H264');
    expect(removed.map((c) => c.mimeType)).toEqual(['video/H264', 'video/rtx']);
    expect(codecs.map((c) => c.mimeType)).toEqual(['video/VP8', 'video/VP9']);
  });

  it('accepts an array of acceptable mimes and matches whichever appears first positionally', () => {
    // host.js's H265 case: browsers may label the codec video/hevc or
    // video/h265 — searching both in one pass (not one-at-a-time) must pick
    // whichever label the capability list actually lists first.
    const codecs = [codec('video/h265'), codec('video/hevc')];
    const removed = extractPreferredCodec(codecs, ['video/hevc', 'video/h265']);
    expect(removed[0].mimeType).toBe('video/h265');
  });

  it('is case-insensitive on mimeType matching', () => {
    const codecs = [codec('Video/VP8')];
    expect(extractPreferredCodec(codecs, 'video/vp8')).toHaveLength(1);
  });
});

function fakeTransceiver() {
  const calls = [];
  return { calls, setCodecPreferences: (list) => calls.push(list) };
}

describe('viewer.js preferReceiverCodec', () => {
  it('returns null when the browser exposes no RTCRtpReceiver capabilities', () => {
    const viewer = loadViewer();
    global.RTCRtpReceiver = { getCapabilities: () => null };
    expect(viewer.preferReceiverCodec(fakeTransceiver(), 'video/H264')).toBeNull();
  });

  it('returns null when transceiver is falsy', () => {
    const viewer = loadViewer();
    global.RTCRtpReceiver = { getCapabilities: () => ({ codecs: [codec('video/VP8')] }) };
    expect(viewer.preferReceiverCodec(null, 'video/H264')).toBeNull();
  });

  it('defaults to CODEC_PRIORITY (H264 then VP8) when no preferredMime is given', () => {
    const viewer = loadViewer();
    global.RTCRtpReceiver = {
      getCapabilities: () => ({
        codecs: [codec('video/VP8'), codec('video/H264', 'profile-level-id=42e01f')],
      }),
    };
    const t = fakeTransceiver();
    const used = viewer.preferReceiverCodec(t, null);
    expect(used).toBe('video/H264');
    expect(t.calls[0][0].mimeType).toBe('video/H264');
  });

  it('puts preferredMime first, ahead of the default CODEC_PRIORITY order', () => {
    const viewer = loadViewer();
    global.RTCRtpReceiver = {
      getCapabilities: () => ({
        codecs: [codec('video/H264', 'profile-level-id=42e01f'), codec('video/VP8')],
      }),
    };
    const t = fakeTransceiver();
    const used = viewer.preferReceiverCodec(t, 'video/VP8');
    expect(used).toBe('video/VP8');
  });

  it('swallows a rejected setCodecPreferences() call instead of throwing, and reports no codec used', () => {
    const viewer = loadViewer();
    global.RTCRtpReceiver = { getCapabilities: () => ({ codecs: [codec('video/VP8')] }) };
    const t = {
      setCodecPreferences: () => {
        throw new Error('Invalid codec preferences');
      },
    };
    let used;
    expect(() => {
      used = viewer.preferReceiverCodec(t, null);
    }).not.toThrow();
    expect(used).toBeNull();
  });
});
