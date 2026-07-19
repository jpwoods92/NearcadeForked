import { describe, it, expect, beforeEach } from 'vitest';
import { _wcGatedSend, _wcSendFragmented, updateSvcLayers } from '../../src/scripts/webcodecs-encoder.js';

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

  it('drops when the buffer is over the limit without immediately forcing a keyframe', () => {
    const t = fakeTransport(LIMIT + 1);
    _wcGatedSend(t, DELTA, false);
    expect(t.sent).toEqual([]);
    expect(t._wcNeedsKey).toBe(true);
    // Forcing now would waste the keyframe into a full buffer — it is
    // deferred until the backlog drains (next test).
    expect(globalThis._wcForceKeyframe).toBe(false);
  });

  it('keeps dropping deltas after a drop, and requests the resync keyframe once drained', () => {
    const t = fakeTransport(LIMIT + 1);
    _wcGatedSend(t, DELTA, false); // drop, arms needsKey
    _wcGatedSend(t, DELTA, false); // buffer still full: dropped, no keyframe request yet
    expect(globalThis._wcForceKeyframe).toBe(false);
    t.bufferedAmount = 0;
    _wcGatedSend(t, DELTA, false); // still dropped — decoder can't use it...
    expect(t.sent).toEqual([]);
    expect(t._wcNeedsKey).toBe(true);
    // ...but the buffer has drained, so NOW the resync keyframe is requested.
    expect(globalThis._wcForceKeyframe).toBe(true);
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
    const realSend = t.send.bind(t);
    t.send = () => {
      throw new Error('closing');
    };
    _wcGatedSend(t, DELTA, false);
    expect(t._wcNeedsKey).toBe(true);
    // Buffer is empty, so the very next gated delta requests the resync key.
    t.send = realSend;
    _wcGatedSend(t, DELTA, false);
    expect(t.sent).toEqual([]);
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

// Frames sent over a DataChannel must stay under the receiver's SCTP
// maxMessageSize (256KB Chrome, 64KB Safari) — oversized frames are split
// into tagged fragments (byte0 2 = fragment, 3 = final) and reassembled by
// the viewer. WebSocket transports are exempt (TCP, no message-size limit).
describe('_wcSendFragmented()', () => {
  const CHUNK = 60 * 1024;

  it('sends small frames as a single untouched message', () => {
    const t = fakeTransport(0);
    const frame = new Uint8Array(CHUNK).fill(7).buffer;
    _wcSendFragmented(t, frame);
    expect(t.sent).toEqual([frame]);
  });

  it('splits an oversized frame into tagged fragments that reassemble byte-for-byte', () => {
    const t = fakeTransport(0);
    const original = new Uint8Array(CHUNK * 2 + 123);
    for (let i = 0; i < original.length; i++) original[i] = i % 251;
    _wcSendFragmented(t, original.buffer);

    expect(t.sent.length).toBe(3);
    const tags = t.sent.map((m) => new Uint8Array(m)[0]);
    expect(tags).toEqual([2, 2, 3]); // final fragment tagged 3

    // Every message fits under the strictest browser limit (+1 tag byte).
    for (const m of t.sent) expect(m.byteLength).toBeLessThanOrEqual(CHUNK + 1);

    // Viewer-side reassembly: concatenate payloads after the tag byte.
    const parts = t.sent.map((m) => new Uint8Array(m, 1));
    const whole = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let off = 0;
    for (const p of parts) {
      whole.set(p, off);
      off += p.byteLength;
    }
    expect(whole).toEqual(original);
  });

  it('is applied by the gate only to DataChannel transports', () => {
    const big = new Uint8Array(CHUNK * 2).buffer;
    const dc = fakeTransport(0);
    _wcGatedSend(dc, big, true, true);
    expect(dc.sent.length).toBe(2); // fragmented

    const wsT = fakeTransport(0);
    _wcGatedSend(wsT, big, true, false);
    expect(wsT.sent).toEqual([big]); // whole message — TCP handles size
  });
});

// updateSvcLayers() reconfigures the live encoder's temporal SVC layer
// count. Its only externally-observable behavior without a real
// VideoEncoder wired up (module-private _wcEncoder, never exported) is that
// it's a safe no-op before any stream has started — the module loads with
// _wcEncoder still null, matching the state before startWebCodecsNetworkPipeline
// ever runs.
describe('updateSvcLayers()', () => {
  beforeEach(() => {
    // Write-only shared-global (declared in host.js in the browser, see
    // webcodecs-encoder.js's own header comment); in Node the bare
    // assignment lands on globalThis, same as _wcForceKeyframe above.
    globalThis._wcEncoder = null;
  });

  it('does not throw when no encoder is active yet', () => {
    expect(() => updateSvcLayers(2)).not.toThrow();
    expect(() => updateSvcLayers(0)).not.toThrow();
    expect(() => updateSvcLayers(99)).not.toThrow();
  });

  it('clamps the layer count to [1, 3] via the reconfigure guard', () => {
    const configured = [];
    globalThis._wcEncoder = {
      state: 'configured',
      _lastConfig: { codec: 'vp09.00.10.08' },
      configure(cfg) {
        configured.push({ ...cfg });
      },
    };
    updateSvcLayers(99);
    expect(configured.at(-1).scalabilityMode).toBe('L1T3');
    updateSvcLayers(1);
    expect(configured.at(-1).scalabilityMode).toBeUndefined();
  });

  it('leaves non-SVC-capable codecs (H264/VP8) untouched', () => {
    const configured = [];
    globalThis._wcEncoder = {
      state: 'configured',
      _lastConfig: { codec: 'avc1.42002A' },
      configure(cfg) {
        configured.push({ ...cfg });
      },
    };
    updateSvcLayers(3);
    expect(configured).toEqual([]);
  });
});
