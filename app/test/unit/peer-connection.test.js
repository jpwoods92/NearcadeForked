import { describe, it, expect } from 'vitest';
import { RTC_STUN_POOL, buildRtcConfig } from '../../src/scripts/webrtc/peer-connection.js';

// Characterization tests for the RTCPeerConnection config host.js's
// sendOfferToViewer() and viewer.js's createPC() used to build inline
// (identically) before REFACTOR_PLAN.md Phase 5.2 extracted it here.

describe('buildRtcConfig()', () => {
  it('picks exactly 2 STUN servers from the pool', () => {
    const cfg = buildRtcConfig(null);
    const stunEntries = cfg.iceServers.filter(s => s.urls.startsWith('stun:'));
    expect(stunEntries).toHaveLength(2);
    for (const entry of stunEntries) {
      expect(RTC_STUN_POOL).toContain(entry.urls);
    }
  });

  it('does not mutate the shared STUN pool', () => {
    const before = [...RTC_STUN_POOL];
    buildRtcConfig(null);
    expect(RTC_STUN_POOL).toEqual(before);
  });

  it('omits TURN credentials when none are given', () => {
    const cfg = buildRtcConfig(null);
    expect(cfg.iceServers).toHaveLength(2);
  });

  it('appends TURN credentials when given', () => {
    const turn = { urls: 'turn:example.com:3478', username: 'u', credential: 'p' };
    const cfg = buildRtcConfig(turn);
    expect(cfg.iceServers).toHaveLength(3);
    expect(cfg.iceServers).toContainEqual(turn);
  });

  it('always sets bundlePolicy/rtcpMuxPolicy/sdpSemantics the same way', () => {
    const cfg = buildRtcConfig(null);
    expect(cfg.bundlePolicy).toBe('max-bundle');
    expect(cfg.rtcpMuxPolicy).toBe('require');
    expect(cfg.sdpSemantics).toBe('unified-plan');
  });
});
