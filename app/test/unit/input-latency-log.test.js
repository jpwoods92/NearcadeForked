import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const latLog = require('../../src/scripts/server/input-latency-log.js');

// Tests for the viewer→server input-latency logger (server/input-latency-log.js):
// NTP-style clock-offset estimation, per-viewer+transport aggregation, daily
// CSV output, and 7-day file pruning.

function fakeSock() {
  const s = {
    readyState: 1,
    sent: [],
    send(str) {
      s.sent.push(JSON.parse(str));
    },
  };
  return s;
}

/** Drive a full sync exchange with a controllable simulated clock pair. */
function runSync(viewerId, { trueOffset, uplinkMs, downlinkMs, serverNow }) {
  // Viewer clock = server clock - trueOffset (offset = server - viewer).
  const vt = serverNow - trueOffset;
  const sock = fakeSock();
  latLog.handleClockSync(sock, { type: 'clock-sync', vt }, viewerId);
  const st = serverNow + uplinkMs; // server stamped after the uplink delay
  const vt2 = vt + uplinkMs + downlinkMs;
  latLog.handleClockSync(sock, { type: 'clock-sync-done', vt, st, vt2 }, viewerId);
}

let dir;

beforeEach(() => {
  latLog._reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-latlog-'));
});

afterEach(() => {
  latLog._reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('clock sync', () => {
  it('acks a clock-sync with the echoed vt and a server stamp', () => {
    latLog.init(dir, { flushMs: 0 });
    const sock = fakeSock();
    const handled = latLog.handleClockSync(sock, { type: 'clock-sync', vt: 12345 }, 'v1');
    expect(handled).toBe(true);
    expect(sock.sent).toHaveLength(1);
    expect(sock.sent[0].type).toBe('clock-sync-ack');
    expect(sock.sent[0].vt).toBe(12345);
    expect(typeof sock.sent[0].st).toBe('number');
  });

  it('recovers the true clock offset when the path is symmetric', () => {
    latLog.init(dir, { flushMs: 0 });
    runSync('v1', { trueOffset: 5000, uplinkMs: 20, downlinkMs: 20, serverNow: 1_000_000 });
    const sync = latLog._offsets.get('v1');
    expect(sync.rtt).toBe(40);
    expect(sync.offset).toBeCloseTo(5000, 5);
  });

  it('keeps the lowest-RTT sample when a noisier one arrives', () => {
    latLog.init(dir, { flushMs: 0 });
    runSync('v1', { trueOffset: 5000, uplinkMs: 10, downlinkMs: 10, serverNow: 1_000_000 });
    // Congested exchange: asymmetric, high RTT → biased offset estimate.
    runSync('v1', { trueOffset: 5000, uplinkMs: 400, downlinkMs: 50, serverNow: 1_010_000 });
    const sync = latLog._offsets.get('v1');
    expect(sync.rtt).toBe(20);
    expect(sync.offset).toBeCloseTo(5000, 5);
  });

  it('ignores a done message with no viewer id', () => {
    latLog.init(dir, { flushMs: 0 });
    latLog.handleClockSync(fakeSock(), { type: 'clock-sync-done', vt: 1, st: 2, vt2: 3 }, null);
    expect(latLog._offsets.size).toBe(0);
  });

  it('does not consume unrelated message types', () => {
    latLog.init(dir, { flushMs: 0 });
    expect(latLog.handleClockSync(fakeSock(), { type: 'gamepad' }, 'v1')).toBe(false);
  });
});

describe('recordInput()', () => {
  it('skips inputs from viewers with no clock offset (e.g. VPS-relayed)', () => {
    latLog.init(dir, { flushMs: 0 });
    latLog.recordInput('vps-viewer', { type: 'gamepad', _lt: 123, _lp: 'wt' });
    expect(latLog._buckets.size).toBe(0);
  });

  it('skips unstamped inputs', () => {
    latLog.init(dir, { flushMs: 0 });
    runSync('v1', { trueOffset: 0, uplinkMs: 5, downlinkMs: 5, serverNow: Date.now() });
    latLog.recordInput('v1', { type: 'gamepad' });
    expect(latLog._buckets.size).toBe(0);
  });

  it('computes offset-corrected latency and buckets by transport', () => {
    let now = 1_000_000;
    latLog.init(dir, { flushMs: 0, now: () => now });
    // Viewer clock runs 7000ms behind the server (offset = +7000).
    runSync('v1', { trueOffset: 7000, uplinkMs: 10, downlinkMs: 10, serverNow: now });

    // An input stamped 25ms (viewer clock) before "now": vt = now - 7000 - 25.
    latLog.recordInput('v1', { type: 'gamepad', _lt: now - 7000 - 25, _lp: 'dc' });
    latLog.recordInput('v1', { type: 'kbm', _lt: now - 7000 - 40, _lp: 'wsi' });

    expect(latLog._buckets.get('v1|dc').samples).toEqual([25]);
    expect(latLog._buckets.get('v1|wsi').samples).toEqual([40]);
  });

  it('rejects garbage latencies from clock steps', () => {
    let now = 1_000_000;
    latLog.init(dir, { flushMs: 0, now: () => now });
    runSync('v1', { trueOffset: 0, uplinkMs: 10, downlinkMs: 10, serverNow: now });
    latLog.recordInput('v1', { type: 'gamepad', _lt: now - 60_000, _lp: 'dc' }); // 60s "latency"
    latLog.recordInput('v1', { type: 'gamepad', _lt: now + 60_000, _lp: 'dc' }); // -60s
    expect(latLog._buckets.size).toBe(0);
  });

  it('stops logging once the offset goes stale', () => {
    let now = 1_000_000;
    latLog.init(dir, { flushMs: 0, now: () => now });
    runSync('v1', { trueOffset: 0, uplinkMs: 10, downlinkMs: 10, serverNow: now });
    now += 6 * 60 * 1000; // past the 5-minute freshness window
    latLog.recordInput('v1', { type: 'gamepad', _lt: now - 20, _lp: 'dc' });
    expect(latLog._buckets.size).toBe(0);
  });
});

describe('_flush()', () => {
  it('writes one CSV row per viewer+transport with correct stats, then clears', () => {
    let now = Date.parse('2026-07-09T12:00:00.000Z');
    latLog.init(dir, { flushMs: 0, now: () => now });
    runSync('v1', { trueOffset: 0, uplinkMs: 5, downlinkMs: 5, serverNow: now });

    for (const lat of [10, 20, 30, 40, 100]) {
      latLog.recordInput('v1', { type: 'gamepad', _lt: now - lat, _lp: 'dc' });
    }
    latLog._flush();

    const file = path.join(dir, 'latency-logs', 'input-latency-2026-07-09.csv');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines[0]).toBe('time,viewer_id,transport,samples,min_ms,avg_ms,p95_ms,max_ms,sync_rtt_ms');
    const cols = lines[1].split(',');
    expect(cols[1]).toBe('v1');
    expect(cols[2]).toBe('dc');
    expect(cols[3]).toBe('5'); // samples
    expect(parseFloat(cols[4])).toBe(10); // min
    expect(parseFloat(cols[5])).toBe(40); // avg
    expect(parseFloat(cols[6])).toBe(100); // p95 (ceil(5*0.95)-1 = idx 4)
    expect(parseFloat(cols[7])).toBe(100); // max
    expect(latLog._buckets.size).toBe(0);

    // Second flush with no new samples adds nothing.
    latLog._flush();
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('appends to the same daily file across flushes', () => {
    let now = Date.parse('2026-07-09T12:00:00.000Z');
    latLog.init(dir, { flushMs: 0, now: () => now });
    runSync('v1', { trueOffset: 0, uplinkMs: 5, downlinkMs: 5, serverNow: now });

    latLog.recordInput('v1', { type: 'gamepad', _lt: now - 10, _lp: 'dc' });
    latLog._flush();
    now += 10_000;
    runSync('v1', { trueOffset: 0, uplinkMs: 5, downlinkMs: 5, serverNow: now });
    latLog.recordInput('v1', { type: 'gamepad', _lt: now - 12, _lp: 'dc' });
    latLog._flush();

    const file = path.join(dir, 'latency-logs', 'input-latency-2026-07-09.csv');
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3); // header + 2 rows
  });
});

describe('_cleanupOldLogs()', () => {
  it("deletes only this module's files older than 7 days", () => {
    const now = Date.parse('2026-07-09T12:00:00.000Z');
    latLog.init(dir, { flushMs: 0, now: () => now });
    const logsDir = path.join(dir, 'latency-logs');

    fs.writeFileSync(path.join(logsDir, 'input-latency-2026-07-01.csv'), 'old\n'); // 8 days old
    fs.writeFileSync(path.join(logsDir, 'input-latency-2026-07-03.csv'), 'keep\n'); // 6 days old
    fs.writeFileSync(path.join(logsDir, 'input-latency-2026-07-09.csv'), 'keep\n');
    fs.writeFileSync(path.join(logsDir, 'unrelated-2020-01-01.csv'), 'keep\n');

    latLog._cleanupOldLogs();

    const left = fs.readdirSync(logsDir).sort();
    expect(left).toEqual(['input-latency-2026-07-03.csv', 'input-latency-2026-07-09.csv', 'unrelated-2020-01-01.csv']);
  });
});
