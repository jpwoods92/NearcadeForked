import { describe, it, expect, beforeEach } from 'vitest';
import { _wcGatedSend } from '../../src/scripts/webcodecs-encoder.js';

// Tests for the WebCodecs transport send gate (webcodecs-encoder.js).
// _wcGatedSend wraps every video-chunk send (VPS WS, tunnel WS, per-viewer
// DataChannel) with backpressure: drop instead of buffering unboundedly, and
// after any drop keep dropping deltas until a keyframe resyncs the decoder.

const LIMIT = 512 * 1024;

function fakeTransport(bufferedAmount = 0) {
  const t = {
    bufferedAmount,
    sent: [],
    send(data) {
      t.sent.push(data);
    },
  };
  return t;
}

const KEY = new ArrayBuffer(16);
const DELTA = new ArrayBuffer(16);

describe('_wcGatedSend()', () => {
  beforeEach(() => {
    // Write-only shared-global flag (declared in host.js in the browser);
    // in Node the bare assignment lands on globalThis.
    globalThis._wcForceKeyframe = false;
  });

  it('sends frames while the buffer is under the limit', () => {
    const t = fakeTransport(0);
    _wcGatedSend(t, KEY, true);
    _wcGatedSend(t, DELTA, false);
    expect(t.sent).toEqual([KEY, DELTA]);
    expect(t._wcNeedsKey).toBe(false);
  });

  it('drops when the buffer is over the limit and requests a keyframe once', () => {
    const t = fakeTransport(LIMIT + 1);
    _wcGatedSend(t, DELTA, false);
    expect(t.sent).toEqual([]);
    expect(t._wcNeedsKey).toBe(true);
    expect(globalThis._wcForceKeyframe).toBe(true);
  });

  it('keeps dropping deltas after a drop even once the buffer drains', () => {
    const t = fakeTransport(LIMIT + 1);
    _wcGatedSend(t, DELTA, false); // drop, arms needsKey
    t.bufferedAmount = 0;
    _wcGatedSend(t, DELTA, false); // still dropped — decoder can't use it
    expect(t.sent).toEqual([]);
    expect(t._wcNeedsKey).toBe(true);
  });

  it('resumes on the next keyframe that fits in the buffer', () => {
    const t = fakeTransport(LIMIT + 1);
    _wcGatedSend(t, DELTA, false);
    t.bufferedAmount = 0;
    _wcGatedSend(t, KEY, true);
    _wcGatedSend(t, DELTA, false);
    expect(t.sent).toEqual([KEY, DELTA]);
    expect(t._wcNeedsKey).toBe(false);
  });

  it('drops a keyframe too when the buffer is still full, and stays gated', () => {
    const t = fakeTransport(LIMIT + 1);
    _wcGatedSend(t, DELTA, false);
    _wcGatedSend(t, KEY, true); // buffer still full
    expect(t.sent).toEqual([]);
    expect(t._wcNeedsKey).toBe(true);
  });

  it('treats a send() throw as a drop and arms the keyframe gate', () => {
    const t = fakeTransport(0);
    t.send = () => {
      throw new Error('closing');
    };
    _wcGatedSend(t, DELTA, false);
    expect(t._wcNeedsKey).toBe(true);
    expect(globalThis._wcForceKeyframe).toBe(true);
  });

  it('always sends config strings, bypassing the gate entirely', () => {
    const t = fakeTransport(LIMIT + 1);
    _wcGatedSend(t, DELTA, false); // arms needsKey
    _wcGatedSend(t, '{"type":"webcodecs-config"}');
    expect(t.sent).toEqual(['{"type":"webcodecs-config"}']);
    expect(t._wcNeedsKey).toBe(true); // config doesn't clear the video gate
  });
});
