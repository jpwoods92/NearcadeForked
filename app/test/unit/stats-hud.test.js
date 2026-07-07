import { describe, it, expect, beforeEach } from 'vitest';
import { loadViewer } from '../helpers/browser-shims.js';

// Characterization tests for viewer.js's merged stats HUD poll
// (REFACTOR_PLAN.md Phase 5.6) — updateStats() used to be two independent
// pc.getStats() polls (#statsHud + #netStatsOverlay); these tests pin down
// that one poll now drives both from a single stats snapshot.

function statReport(overrides) {
  return { type: 'unknown', ...overrides };
}

function fakePc(reports) {
  return {
    getStats: async () => new Map(reports.map((r, i) => [String(i), r])),
  };
}

describe('viewer.js merged stats HUD', () => {
  beforeEach(() => {
    // VIEWER_FIXTURE already includes #statsHud/#netStatsOverlay (class="gone"
    // by default, matching the real page) — see browser-shims.js.
    // loadViewer() is called for its side effects (installs stubs, requires
    // viewer.js + shared scripts onto `global`); updateStats()/toggleNetStats
    // are exercised via `global` below, not viewer.js's own module.exports.
    loadViewer();
    global.pc = fakePc([
      statReport({ type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.05 }),
      statReport({ type: 'codec', mimeType: 'video/H264' }),
      statReport({
        type: 'inbound-rtp',
        kind: 'video',
        packetsLost: 1,
        packetsReceived: 99,
        bytesReceived: 100000,
        timestamp: 1000,
        frameWidth: 1280,
        frameHeight: 720,
        framesPerSecond: 60,
        jitter: 0.01,
      }),
    ]);
  });

  it('is a no-op when there is no active peer connection', async () => {
    global.pc = null;
    await expect(global.updateStats()).resolves.not.toThrow();
    expect(document.getElementById('statsHud').style.display).not.toBe('flex');
  });

  it('updates #statsHud (bars/RTT) from a single pc.getStats() call', async () => {
    await global.updateStats();
    const hud = document.getElementById('statsHud');
    expect(hud.style.display).toBe('flex');
    expect(hud.innerHTML).toContain('50ms');
  });

  it('also updates #netStatsOverlay from that same poll when it is visible', async () => {
    document.getElementById('netStatsOverlay').classList.remove('gone');
    await global.updateStats();
    expect(document.getElementById('nsPing').textContent).toBe('50 ms');
    expect(document.getElementById('nsCodec').textContent).toBe('H264');
    expect(document.getElementById('nsRes').textContent).toBe('1280x720');
    expect(document.getElementById('nsFps').textContent).toBe('60');
    expect(document.getElementById('nsJitter').textContent).toBe('10 ms');
    expect(document.getElementById('nsLoss').textContent).toBe('1.0 %');
  });

  it('does not touch #netStatsOverlay fields while it is hidden (fixture defaults to class="gone")', async () => {
    await global.updateStats();
    expect(document.getElementById('nsPing').textContent).toBe('');
  });

  it('toggleNetStats() only toggles visibility — it does not start a second timer', () => {
    const overlay = document.getElementById('netStatsOverlay');
    overlay.classList.add('gone');
    window.toggleNetStats();
    expect(overlay.classList.contains('gone')).toBe(false);
    window.toggleNetStats();
    expect(overlay.classList.contains('gone')).toBe(true);
  });
});
