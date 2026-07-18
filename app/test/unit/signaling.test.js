import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// signaling.js is a plain <script>-tag global (window.Signaling = Signaling),
// not a CommonJS module — see CLAUDE.md's "shared-global-script" note.
// Requiring it here relies on vitest's jsdom environment aliasing `window`
// to the same global object `require()` resolves bare identifiers against.
delete require.cache[require.resolve('../../src/scripts/signaling.js')];
require('../../src/scripts/signaling.js');
const Signaling = global.Signaling;

/** Minimal fake standing in for the browser WebSocket the real class wraps —
 * gives tests control over open/message/close without real network I/O. */
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('not open');
    this.sent.push(data);
  }
  close(code, reason) {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) this.onclose({ code: code ?? 1000, reason: reason ?? '' });
  }
  _open() {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }
  _receive(data) {
    if (this.onmessage) this.onmessage({ data });
  }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;

let realWebSocket;
beforeEach(() => {
  realWebSocket = global.WebSocket;
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
});
afterEach(() => {
  global.WebSocket = realWebSocket;
  vi.useRealTimers();
});

describe('Signaling events', () => {
  it('dispatches to type-specific and wildcard handlers', () => {
    const sig = new Signaling();
    const typed = vi.fn();
    const wild = vi.fn();
    sig.on('chat', typed);
    sig.on('*', wild);
    sig._emit('chat', { msg: 'hi' });
    expect(typed).toHaveBeenCalledWith({ msg: 'hi' });
    expect(wild).toHaveBeenCalledWith('chat', { msg: 'hi' });
  });

  it('off() removes only the given handler', () => {
    const sig = new Signaling();
    const a = vi.fn();
    const b = vi.fn();
    sig.on('chat', a);
    sig.on('chat', b);
    sig.off('chat', a);
    sig._emit('chat', {});
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('a throwing handler does not stop other handlers from running', () => {
    const sig = new Signaling();
    const boom = vi.fn(() => {
      throw new Error('boom');
    });
    const fine = vi.fn();
    sig.on('chat', boom);
    sig.on('chat', fine);
    expect(() => sig._emit('chat', {})).not.toThrow();
    expect(fine).toHaveBeenCalled();
  });
});

describe('Signaling connect/send lifecycle', () => {
  it('queues sends while not connected, then flushes on open', () => {
    const sig = new Signaling();
    expect(sig.send({ type: 'join' })).toBe(false);
    sig.connect('ws://host/ws/host');
    const fake = FakeWebSocket.instances[0];
    fake._open();
    expect(sig.readyState).toBe(FakeWebSocket.OPEN);
    expect(fake.sent).toEqual([JSON.stringify({ type: 'join' })]);
  });

  it('emits connected/disconnected around the underlying socket lifecycle', () => {
    const sig = new Signaling();
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    sig.on('connected', onConnected);
    sig.on('disconnected', onDisconnected);
    sig.connect('ws://host/ws/host');
    const fake = FakeWebSocket.instances[0];
    fake._open();
    expect(onConnected).toHaveBeenCalledTimes(1);
    fake.close(1006, 'lost');
    expect(onDisconnected).toHaveBeenCalledWith({ code: 1006, reason: 'lost' });
  });

  it('parses JSON messages and emits by their type field', () => {
    const sig = new Signaling();
    const onChat = vi.fn();
    sig.on('chat', onChat);
    sig.connect('ws://host/ws/host');
    FakeWebSocket.instances[0]._receive(JSON.stringify({ type: 'chat', msg: 'hey' }));
    expect(onChat).toHaveBeenCalledWith({ type: 'chat', msg: 'hey' });
  });

  it('swallows pong replies without emitting a "pong" event', () => {
    const sig = new Signaling();
    sig.connect('ws://host/ws/host');
    const wild = vi.fn();
    sig.on('*', wild); // registered after 'connecting'/'connected' so only the pong receipt is observed
    FakeWebSocket.instances[0]._receive(JSON.stringify({ type: 'pong' }));
    expect(wild).not.toHaveBeenCalled();
  });

  it('forwards ArrayBuffer/Blob payloads as "binary" instead of parsing as JSON', () => {
    const sig = new Signaling();
    const onBinary = vi.fn();
    sig.on('binary', onBinary);
    sig.connect('ws://host/ws/host');
    const buf = new ArrayBuffer(4);
    FakeWebSocket.instances[0]._receive(buf);
    expect(onBinary).toHaveBeenCalledWith(buf);
  });

  it('sendBinary writes straight through without JSON-encoding', () => {
    const sig = new Signaling();
    sig.connect('ws://host/ws/host');
    FakeWebSocket.instances[0]._open();
    const buf = new ArrayBuffer(2);
    expect(sig.sendBinary(buf)).toBe(true);
    expect(FakeWebSocket.instances[0].sent).toEqual([buf]);
  });

  it('disconnect() is intentional: closes the socket and marks the event as such, dropping pending sends', () => {
    const sig = new Signaling();
    const onDisconnected = vi.fn();
    sig.on('disconnected', onDisconnected);
    sig.connect('ws://host/ws/host');
    FakeWebSocket.instances[0]._open();
    sig.send({ queued: 'nope' });
    FakeWebSocket.instances[0].readyState = FakeWebSocket.CLOSED; // simulate mid-flight
    sig.disconnect(1000, 'bye');
    expect(onDisconnected).toHaveBeenCalledWith({ code: 1000, reason: 'bye', intentional: true });
    expect(sig._pending).toEqual([]);
  });
});

describe('Signaling reconnect scheduling', () => {
  it('schedules a backoff reconnect attempt if the WebSocket constructor throws', () => {
    vi.useFakeTimers();
    let calls = 0;
    global.WebSocket = class {
      constructor() {
        calls++;
        if (calls === 1) throw new Error('ECONNREFUSED');
        return new FakeWebSocket();
      }
    };
    global.WebSocket.CONNECTING = FakeWebSocket.CONNECTING;
    global.WebSocket.OPEN = FakeWebSocket.OPEN;
    global.WebSocket.CLOSING = FakeWebSocket.CLOSING;
    global.WebSocket.CLOSED = FakeWebSocket.CLOSED;

    const sig = new Signaling();
    const onError = vi.fn();
    sig.on('error', onError);
    sig.connect('ws://host/ws/host');

    expect(calls).toBe(1);
    expect(onError).toHaveBeenCalledWith({ code: 'CONSTRUCTOR', message: 'ECONNREFUSED' });
    expect(sig._reconnectAttempts).toBe(1);

    vi.runOnlyPendingTimers();
    expect(calls).toBe(2);
  });

  it('does not reconnect after an intentional disconnect', () => {
    vi.useFakeTimers();
    const sig = new Signaling();
    sig.connect('ws://host/ws/host');
    FakeWebSocket.instances[0]._open();
    sig.disconnect();
    vi.runAllTimers();
    // No further WebSocket construction should have been scheduled.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
