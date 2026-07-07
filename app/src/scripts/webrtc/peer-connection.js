// ── SHARED PEER-CONNECTION CONFIG ──────────────────────────────────────────
// Loaded via a <script> tag before host.js/viewer.js (both are plain global
// scripts, not ES modules), same pattern as chat.js. host.js's
// sendOfferToViewer() and viewer.js's createPC() built this exact config
// inline — same STUN pool, same shuffle, same RTCPeerConnection options —
// this is that literal duplication factored out. Peer-connection
// *establishment* itself (offer vs. answer side, event wiring) stays in each
// file — host offers, viewer answers, and those flows are genuinely
// asymmetric, not duplicated. See REFACTOR_PLAN.md Phase 5.2.

const RTC_STUN_POOL = [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
    'stun:stun3.l.google.com:19302',
    'stun:stun4.l.google.com:19302',
    'stun:stun.cloudflare.com:3478',
    'stun:stun.twilio.com:3478',
    'stun:global.stun.twilio.com:3478',
    'stun:stun.miwifi.com:3478',
];

/**
 * Builds the RTCPeerConnection config for a new connection. Picks 2 random
 * STUN servers (avoids the "five or more STUN/TURN servers slows down
 * discovery" browser warning, and naturally rotates STUN/TURN across
 * retries for users behind VPNs), appends `turnCredentials` if given, and
 * fixes `bundlePolicy`/`rtcpMuxPolicy`/`sdpSemantics` the same way both
 * files always did.
 */
function buildRtcConfig(turnCredentials) {
    const shuffledStun = RTC_STUN_POOL.slice()
        .sort(() => 0.5 - Math.random())
        .slice(0, 2)
        .map(url => ({ urls: url }));

    const iceServers = [...shuffledStun];
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
    module.exports = { RTC_STUN_POOL, buildRtcConfig };
}
