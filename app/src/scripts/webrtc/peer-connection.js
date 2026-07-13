// ── SHARED PEER-CONNECTION CONFIG ──────────────────────────────────────────
// Loaded via a <script> tag before host.js/viewer.js (both are plain global
// scripts, not ES modules), same pattern as chat.js. host.js's
// sendOfferToViewer() and viewer.js's createPC() built this exact config
// inline — same STUN pool, same shuffle, same RTCPeerConnection options —
// this is that literal duplication factored out. Peer-connection
// *establishment* itself (offer vs. answer side, event wiring) stays in each
// file — host offers, viewer answers, and those flows are genuinely
// asymmetric, not duplicated. See REFACTOR_PLAN.md Phase 5.2.

// Trusted alternates: reliable public STUN servers, one is picked at random
// as the second entry (in addition to the primary Google STUN below).
const RTC_TRUSTED_STUN_POOL = [
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302',
  'stun:stun4.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

// Last-resort fallback for restricted networks: one is picked at random as
// the third entry.
const RTC_FALLBACK_STUN_POOL = [
  'stun:stun.twilio.com:3478',
  'stun:global.stun.twilio.com:3478',
  'stun:stun.miwifi.com:3478',
];

// Kept for backwards compatibility with anything still importing the full
// pool (e.g. existing unit tests).
const RTC_STUN_POOL = ['stun:stun.l.google.com:19302', ...RTC_TRUSTED_STUN_POOL, ...RTC_FALLBACK_STUN_POOL];

/**
 * Builds the RTCPeerConnection config for a new connection. Always includes
 * Google's primary STUN server (most reliable), then picks one random
 * server from the trusted pool and one from the fallback pool (avoids the
 * "five or more STUN/TURN servers slows down discovery" browser warning,
 * and naturally rotates STUN/TURN across retries for users behind VPNs),
 * appends `turnCredentials` if given, and fixes
 * `bundlePolicy`/`rtcpMuxPolicy`/`sdpSemantics` the same way both files
 * always did.
 */
function buildRtcConfig(turnCredentials) {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

  const trustedPick = RTC_TRUSTED_STUN_POOL.slice().sort(() => 0.5 - Math.random())[0];
  iceServers.push({ urls: trustedPick });

  const fallbackPick = RTC_FALLBACK_STUN_POOL.slice().sort(() => 0.5 - Math.random())[0];
  iceServers.push({ urls: fallbackPick });

  if (turnCredentials) iceServers.push(turnCredentials);

  return {
    iceServers,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    sdpSemantics: 'unified-plan',
  };
}

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RTC_STUN_POOL, RTC_TRUSTED_STUN_POOL, RTC_FALLBACK_STUN_POOL, buildRtcConfig };
}
