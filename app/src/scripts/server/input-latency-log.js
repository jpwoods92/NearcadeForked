'use strict';
// ── INPUT LATENCY LOG ────────────────────────────────────────────────────────
// Measures one-way viewer→server input latency and appends aggregated stats
// to daily CSV files under <dataDir>/latency-logs/.
//
// Clock sync: the viewer's and server's wall clocks disagree by an unknown
// offset that is routinely larger than the latency being measured, so a raw
// serverNow - viewerStamp diff is meaningless. A periodic NTP-style exchange
// (ridden over the /ws/input socket by the viewer) estimates the offset:
//
//   viewer → server  {type:'clock-sync',      vt}            vt = viewer clock
//   server → viewer  {type:'clock-sync-ack',  vt, st}        st = server clock
//   viewer → server  {type:'clock-sync-done', vt, st, vt2}   vt2 = viewer clock
//
//   rtt    = vt2 - vt
//   offset = st - (vt + rtt/2)          → serverClock ≈ viewerClock + offset
//
// The lowest-RTT sample wins (least queueing noise = most accurate offset)
// until it goes stale, so a single clean exchange isn't displaced by later
// congested ones. Accuracy is bounded by path asymmetry (~±rtt/2 worst case);
// each CSV row carries the sync RTT so noisy intervals are identifiable.
//
// Per input: sendInputData() (viewer, input/gamepad.js) stamps every message
// with _lt (viewer clock, ms) and _lp (transport: wt/dc/wsi/ws). The server
// computes latency = now - (_lt + offset) at each input-parsing site and
// aggregates per viewer+transport; one CSV row per bucket is flushed every
// FLUSH_MS. Files older than MAX_AGE_DAYS are deleted at init and daily.

const fs = require('fs');
const path = require('path');

const FLUSH_MS = 10000;
const MAX_AGE_DAYS = 7;
const OFFSET_MAX_AGE_MS = 5 * 60 * 1000; // stale offset = stop logging until resync
const OFFSET_REPLACE_AGE_MS = 2 * 60 * 1000; // accept a worse-RTT sample past this age (drift)
const MAX_SAMPLES_PER_BUCKET = 4096;
const CSV_HEADER = 'time,viewer_id,transport,samples,min_ms,avg_ms,p95_ms,max_ms,sync_rtt_ms\n';

let _dir = null;
let _now = Date.now;
let _flushTimer = null;
let _cleanupTimer = null;
const _offsets = new Map(); // viewerId -> { offset, rtt, at }
const _buckets = new Map(); // "viewerId|transport" -> { samples: [], rtt }

/**
 * PUBLIC — call once at server boot. `opts.flushMs: 0` disables the timers
 * (tests drive _flush()/_cleanupOldLogs() directly).
 */
function init(baseDir, opts = {}) {
  _dir = path.join(baseDir, 'latency-logs');
  if (opts.now) _now = opts.now;
  try {
    fs.mkdirSync(_dir, { recursive: true });
  } catch {
    // Non-fatal: appends below will also fail and log once per flush.
  }
  _cleanupOldLogs();

  const flushMs = opts.flushMs !== undefined ? opts.flushMs : FLUSH_MS;
  if (flushMs > 0) {
    _flushTimer = setInterval(_flush, flushMs);
    _flushTimer.unref?.();
    _cleanupTimer = setInterval(_cleanupOldLogs, 24 * 60 * 60 * 1000);
    _cleanupTimer.unref?.();
  }
}

/**
 * PUBLIC — feed clock-sync messages from any viewer-facing socket. Returns
 * true when the message was consumed (callers should stop routing it).
 */
function handleClockSync(sock, msg, viewerId) {
  if (msg.type === 'clock-sync') {
    if (typeof msg.vt === 'number' && sock && sock.readyState === 1) {
      try {
        sock.send(JSON.stringify({ type: 'clock-sync-ack', vt: msg.vt, st: _now() }));
      } catch {
        // Socket died mid-exchange — viewer will retry on its 30s timer.
      }
    }
    return true;
  }
  if (msg.type === 'clock-sync-done') {
    if (viewerId && typeof msg.vt === 'number' && typeof msg.st === 'number' && typeof msg.vt2 === 'number') {
      const rtt = msg.vt2 - msg.vt;
      if (rtt >= 0 && rtt < 10000) {
        const cand = { offset: msg.st - (msg.vt + rtt / 2), rtt, at: _now() };
        const cur = _offsets.get(String(viewerId));
        if (!cur || cand.rtt <= cur.rtt || cand.at - cur.at > OFFSET_REPLACE_AGE_MS) {
          _offsets.set(String(viewerId), cand);
        }
      }
    }
    return true;
  }
  return false;
}

/**
 * PUBLIC — record one stamped input message. No-op unless the message
 * carries _lt and the viewer has a fresh clock offset (so VPS-relayed
 * viewers, which never clock-sync with this server, are skipped cleanly).
 */
function recordInput(viewerId, msg) {
  if (!_dir || !viewerId || typeof msg._lt !== 'number') return;
  const sync = _offsets.get(String(viewerId));
  if (!sync || _now() - sync.at > OFFSET_MAX_AGE_MS) return;

  const lat = _now() - (msg._lt + sync.offset);
  // Small negatives are honest offset error (≤ rtt/2) and worth keeping;
  // anything past these bounds is a clock step or corrupt stamp.
  if (!Number.isFinite(lat) || lat < -1000 || lat > 10000) return;

  const key = String(viewerId) + '|' + (typeof msg._lp === 'string' ? msg._lp : 'ws');
  let bucket = _buckets.get(key);
  if (!bucket) {
    bucket = { samples: [], rtt: sync.rtt };
    _buckets.set(key, bucket);
  }
  bucket.rtt = sync.rtt;
  if (bucket.samples.length < MAX_SAMPLES_PER_BUCKET) bucket.samples.push(lat);
}

function _flush() {
  if (!_dir || _buckets.size === 0) return;
  const nowDate = new Date(_now());
  const iso = nowDate.toISOString();
  const file = path.join(_dir, `input-latency-${iso.slice(0, 10)}.csv`);

  let lines = '';
  for (const [key, bucket] of _buckets) {
    const n = bucket.samples.length;
    if (!n) continue;
    const sorted = bucket.samples.slice().sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[n - 1];
    const avg = sorted.reduce((s, v) => s + v, 0) / n;
    const p95 = sorted[Math.max(0, Math.ceil(n * 0.95) - 1)];
    const [viewerId, transport] = key.split('|');
    lines += `${iso},${viewerId},${transport},${n},${min.toFixed(1)},${avg.toFixed(1)},${p95.toFixed(1)},${max.toFixed(1)},${bucket.rtt.toFixed(1)}\n`;
  }
  _buckets.clear();
  if (!lines) return;

  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, CSV_HEADER);
    fs.appendFileSync(file, lines);
  } catch (e) {
    console.error('[latency-log] Write failed:', e.message);
  }
}

function _cleanupOldLogs() {
  if (!_dir) return;
  let names;
  try {
    names = fs.readdirSync(_dir);
  } catch {
    return;
  }
  const cutoff = _now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  for (const name of names) {
    const m = /^input-latency-(\d{4}-\d{2}-\d{2})\.csv$/.exec(name);
    if (!m) continue; // never touch files this module didn't create
    // End of the file's day: a file is deleted only once its whole day is
    // older than the cutoff.
    const dayEnd = Date.parse(m[1] + 'T23:59:59.999Z');
    if (Number.isFinite(dayEnd) && dayEnd < cutoff) {
      try {
        fs.unlinkSync(path.join(_dir, name));
      } catch {
        // Locked/removed concurrently — retried on the next daily pass.
      }
    }
  }
}

/** Test helper — clears all module state and timers. */
function _reset() {
  if (_flushTimer) clearInterval(_flushTimer);
  if (_cleanupTimer) clearInterval(_cleanupTimer);
  _flushTimer = null;
  _cleanupTimer = null;
  _dir = null;
  _now = Date.now;
  _offsets.clear();
  _buckets.clear();
}

module.exports = { init, handleClockSync, recordInput, _flush, _cleanupOldLogs, _reset, _offsets, _buckets };
