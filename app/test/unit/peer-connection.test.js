import { describe, it, expect } from 'vitest';
import {
  RTC_TRUSTED_STUN_POOL,
  RTC_FALLBACK_STUN_POOL,
  buildRtcConfig,
} from '../../src/scripts/webrtc/peer-connection.js';

// Characterization tests for the RTCPeerConnection config host.js's
// sendOfferToViewer() and viewer.js's createPC() used to build inline
// (identically) before REFACTOR_PLAN.md Phase 5.2 extracted it here.

describe('buildRtcConfig()', () => {
  it('always includes Google STUN as the primary server', () => {
    const cfg = buildRtcConfig(null);
    expect(cfg.iceServers[0]).toEqual({ urls: 'stun:stun.l.google.com:19302' });
  });

  it('picks one trusted and one fallback STUN server', () => {
    const cfg = buildRtcConfig(null);
    const stunEntries = cfg.iceServers.filter((s) => s.urls.startsWith('stun:'));
    expect(stunEntries).toHaveLength(3);
    expect(RTC_TRUSTED_STUN_POOL).toContain(stunEntries[1].urls);
    expect(RTC_FALLBACK_STUN_POOL).toContain(stunEntries[2].urls);
  });

  it('does not mutate the shared STUN pools', () => {
    const beforeTrusted = [...RTC_TRUSTED_STUN_POOL];
    const beforeFallback = [...RTC_FALLBACK_STUN_POOL];
    buildRtcConfig(null);
    expect(RTC_TRUSTED_STUN_POOL).toEqual(beforeTrusted);
    expect(RTC_FALLBACK_STUN_POOL).toEqual(beforeFallback);
  });

  it('omits TURN credentials when none are given', () => {
    const cfg = buildRtcConfig(null);
    expect(cfg.iceServers).toHaveLength(3);
  });

  it('appends TURN credentials when given', () => {
    const turn = { urls: 'turn:example.com:3478', username: 'u', credential: 'p' };
    const cfg = buildRtcConfig(turn);
    expect(cfg.iceServers).toHaveLength(4);
    expect(cfg.iceServers).toContainEqual(turn);
  });

  it('always sets bundlePolicy/rtcpMuxPolicy/sdpSemantics the same way', () => {
    const cfg = buildRtcConfig(null);
    expect(cfg.bundlePolicy).toBe('max-bundle');
    expect(cfg.rtcpMuxPolicy).toBe('require');
    expect(cfg.sdpSemantics).toBe('unified-plan');
  });
});
