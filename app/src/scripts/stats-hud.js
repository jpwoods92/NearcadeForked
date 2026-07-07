// ── STATS HUD ───────────────────────────────────────────────────────────────
// Loaded via a <script> tag before host.js/viewer.js, same pattern as the
// other scripts/**/*.js modules.
//
// host.js's HUD (below) is one implementation. viewer.js used to have two
// independent, overlapping HUD polls (`updateStats()` driving `#statsHud`,
// and `startNetStats()`/`toggleNetStats()` driving a separate
// `#netStatsOverlay`) that each ran their own `pc.getStats()` timer and
// recomputed RTT/bitrate/packet-loss from scratch. Merged (per user request,
// not a silent refactor call) into one poll — see the viewer-only section
// below. See REFACTOR_PLAN.md Phase 5.6.

// ── HOST-ONLY: stats HUD (inline in dock) ──────────────────────────────────
// Timer is started automatically by startCapture() and stopped by stopCapture(),
// but ONLY if the user has enabled the Stats HUD toggle first.
let _statsHudTimer   = null;
let _statsHudEnabled = false;  // toggled by the user in Settings → Video tab

// Shim so the HTML onclick="toggleStatsHud()" still works.
function toggleStatsHud() {
    _statsHudEnabled = !_statsHudEnabled;
    const track = document.getElementById('smTrackStatsHud');
    const row   = document.getElementById('smRowStatsHud');
    if (track) track.classList.toggle('on',     _statsHudEnabled);
    if (row)   row.classList.toggle('active',   _statsHudEnabled);

    if (_statsHudEnabled && currentStream) {
        _startStatsHud();
    } else {
        _stopStatsHud();
    }
}

function _startStatsHud() {
    // Respect the user toggle — never auto-show if they haven't turned it on
    if (!_statsHudEnabled) return;
    if (_statsHudTimer) return;
    const hud = document.getElementById('statsHud');
    if (hud) hud.style.display = 'flex';
    _statsHudTimer = setInterval(_updateStatsHud, 1500);
    _updateStatsHud();
}

function _stopStatsHud() {
    if (_statsHudTimer) { clearInterval(_statsHudTimer); _statsHudTimer = null; }
    const hud = document.getElementById('statsHud');
    if (hud) hud.style.display = 'none';
    ['hudPipeline','hudCodec','hudRtt','hudBitrate'].forEach(id => _elText(id, '—'));
}

function _updateStatsHud() {
    const pipe  = document.getElementById('pipelineSelect');
    const codec = document.getElementById('codecSelect');

    _elText('hudPipeline', pipe  ? (pipe.value === 'custom_webcodecs' ? 'WC (GL)' : pipe.value === 'webcodecs' ? 'WC' : 'WebRTC') : '—');
    _elText('hudCodec',    codec ? (codec.options[codec.selectedIndex]?.text?.split(' ')[0] || '—') : '—');

    // Pull RTT and outgoing bitrate from the first active peer connection.
    // peerConnections is a plain object keyed by viewerId.
    const pcList = Object.values(peerConnections);
    if (!pcList.length) { _elText('hudRtt', '—'); _elText('hudBitrate', '—'); return; }

    pcList[0].getStats().then(stats => {
        let bestPair      = null;
        let outboundVideo = null;

        stats.forEach(r => {
            // RTT: pick the succeeded candidate-pair with lowest RTT
            if (r.type === 'candidate-pair' && r.state === 'succeeded') {
                if (!bestPair || r.currentRoundTripTime < (bestPair.currentRoundTripTime || 1)) {
                    bestPair = r;
                }
            }
            // Bitrate: WebCodecs pipeline sends video over the DataChannel named 'webcodecs'.
            // Use data-channel bytesSent for KBPS; fall back to outbound-rtp for standard WebRTC.
            if (r.type === 'data-channel' && r.label === 'webcodecs') {
                outboundVideo = r;
            }
            if (!outboundVideo && r.type === 'outbound-rtp' && r.kind === 'video') {
                outboundVideo = r;
            }
        });

        if (bestPair?.currentRoundTripTime != null) {
            _elText('hudRtt', Math.round(bestPair.currentRoundTripTime * 1000) + 'ms');
        }

        if (outboundVideo) {
            if (outboundVideo.frameWidth && outboundVideo.frameHeight) {
                _elText('hudRes', `${outboundVideo.frameWidth}x${outboundVideo.frameHeight}`);
            } else {
                _elText('hudRes', '—');
            }
            
            if (outboundVideo.framesPerSecond != null) {
                _elText('hudFps', outboundVideo.framesPerSecond.toFixed(0));
            } else {
                _elText('hudFps', '—');
            }
            
            const prev = pcList[0].__statsSnapshot;
            if (outboundVideo.totalEncodeTime != null && outboundVideo.framesEncoded != null && prev) {
                if (outboundVideo.framesEncoded > prev.frames) {
                    const encodeDelta = outboundVideo.totalEncodeTime - prev.encodeTime;
                    const framesDelta = outboundVideo.framesEncoded - prev.frames;
                    const encodeLatencyMs = (encodeDelta / framesDelta) * 1000;
                    _elText('hudEncodeLat', encodeLatencyMs.toFixed(1) + 'ms');
                }
            } else {
                _elText('hudEncodeLat', '—');
            }
            
            if (outboundVideo.bytesSent != null) {
                const now  = Date.now();
                if (prev) {
                    const dtSec   = (now - prev.ts) / 1000;
                    const byteDiff = outboundVideo.bytesSent - prev.bytes;
                    const kbps    = Math.round((byteDiff * 8) / dtSec / 1000);
                    _elText('hudBitrate', kbps > 0 ? kbps + 'k' : '—');
                }
                pcList[0].__statsSnapshot = { 
                    ts: now, 
                    bytes: outboundVideo.bytesSent, 
                    encodeTime: outboundVideo.totalEncodeTime || 0,
                    frames: outboundVideo.framesEncoded || 0
                };
            }
        }
    }).catch(() => {});
}

// ── VIEWER-ONLY: stats HUD ──────────────────────────────────────────────────
// One poll drives both #statsHud (always-on quality-tier bars) and
// #netStatsOverlay (detailed panel, shown via toggleNetStats()) — they used
// to be two independent pc.getStats() polls each recomputing RTT/bitrate/
// packet-loss from scratch. #netStatsOverlay's visibility is still toggled
// by toggleNetStats(); the underlying poll now just always runs (same as
// #statsHud always did) instead of starting/stopping a second timer, and
// skips writing into #netStatsOverlay's fields while it's hidden.
const statsHud = document.getElementById('statsHud');
let prevBytesReceived = 0, prevStatsTime = 0, prevJitterDelay = 0, prevEmitted = 0;
let prevDecodeTime = 0, prevFramesDecoded = 0;

async function updateStats() {
    if (!pc) return;
    try {
        const stats = await pc.getStats();
        let rtt = null, codecName = '--';
        let jitterBufMs = null, kbps = null, packetsLost = 0, packetsReceived = 0;
        let resolution = null, fps = null, decodeLatencyMs = null, rtpJitterMs = null;
        let sawInboundVideo = false;

        for (const r of stats.values()) {
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
                rtt = (r.currentRoundTripTime * 1000).toFixed(0);
            }
            if (r.type === 'codec' && r.mimeType && r.mimeType.startsWith('video/')) {
                codecName = r.mimeType.split('/')[1];
            }
            if (r.type === 'inbound-rtp' && r.kind === 'video') {
                sawInboundVideo = true;
                packetsLost = r.packetsLost || 0;
                packetsReceived = r.packetsReceived || 1;

                if (prevStatsTime) {
                    const eDelta = (r.jitterBufferEmittedCount || 1) - prevEmitted;
                    if (eDelta > 0) jitterBufMs = (((r.jitterBufferDelay || 0) - prevJitterDelay) / eDelta * 1000).toFixed(0);
                    kbps = (((r.bytesReceived - prevBytesReceived) * 8) / ((r.timestamp - prevStatsTime) / 1000) / 1000).toFixed(0);
                }
                prevBytesReceived = r.bytesReceived; prevStatsTime = r.timestamp;
                prevJitterDelay = r.jitterBufferDelay || 0; prevEmitted = r.jitterBufferEmittedCount || 1;

                if (r.frameWidth && r.frameHeight) resolution = `${r.frameWidth}x${r.frameHeight}`;
                if (r.framesPerSecond != null) fps = r.framesPerSecond.toFixed(0);
                if (r.jitter != null) rtpJitterMs = (r.jitter * 1000).toFixed(0);

                if (r.totalDecodeTime != null && r.framesDecoded != null) {
                    if (prevFramesDecoded && r.framesDecoded > prevFramesDecoded) {
                        const decodeDelta = r.totalDecodeTime - prevDecodeTime;
                        const framesDelta = r.framesDecoded - prevFramesDecoded;
                        decodeLatencyMs = ((decodeDelta / framesDelta) * 1000).toFixed(1);
                    }
                    prevDecodeTime = r.totalDecodeTime;
                    prevFramesDecoded = r.framesDecoded;
                }
            }
        }

        if (rtt !== null) _renderStatsHudBars(rtt, jitterBufMs, kbps, packetsLost, packetsReceived);
        _renderNetStatsOverlay({ rtt, sawInboundVideo, codecName, kbps, resolution, fps, decodeLatencyMs, packetsLost, packetsReceived, rtpJitterMs });
    } catch { }
}
setInterval(updateStats, 500);

function _renderStatsHudBars(rtt, jitterBufMs, kbps, packetsLost, packetsReceived) {
    statsHud.style.display = 'flex';

    // ── Quality tier from RTT + packet loss ──────────────────────────
    const rttN = parseInt(rtt);
    const lossRatio = packetsReceived > 0 ? (packetsLost / (packetsLost + packetsReceived)) * 100 : 0;

    let bars, colour;
    if (rttN < 40 && lossRatio < 1) { bars = '▪▪▪▪'; colour = '#4ade80'; } // excellent — green
    else if (rttN < 80 && lossRatio < 3) { bars = '▪▪▪○'; colour = '#a3e635'; } // good — lime
    else if (rttN < 140 && lossRatio < 6) { bars = '▪▪○○'; colour = '#facc15'; } // fair — yellow
    else if (rttN < 220 && lossRatio < 12) { bars = '▪○○○'; colour = '#fb923c'; } // poor — orange
    else { bars = '○○○○'; colour = '#f87171'; } // bad  — red

    const parts = [
        `<span style="color:${colour};letter-spacing:1px">${bars}</span>`,
        `<span style="color:${colour}">${rtt}ms</span>`,
    ];
    if (jitterBufMs) parts.push(`${jitterBufMs}ms buf`);
    if (kbps) parts.push(`${kbps}kbps`);

    statsHud.innerHTML = parts.join(' <span style="opacity:0.4">·</span> ');
}

function _renderNetStatsOverlay({ rtt, sawInboundVideo, codecName, kbps, resolution, fps, decodeLatencyMs, packetsLost, packetsReceived, rtpJitterMs }) {
    const overlay = document.getElementById('netStatsOverlay');
    if (!overlay || overlay.classList.contains('gone')) return;

    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };

    if (rtt !== null) setText('nsPing', rtt + ' ms');

    if (sawInboundVideo) {
        setText('nsCodec', codecName);
        if (kbps !== null) setText('nsBitrate', kbps + ' kbps');
        if (resolution) setText('nsRes', resolution);
        if (fps !== null) setText('nsFps', fps);
        if (decodeLatencyMs !== null) setText('nsDecode', decodeLatencyMs + ' ms');
        const total = packetsLost + packetsReceived;
        setText('nsLoss', total > 0 ? ((packetsLost / total) * 100).toFixed(1) + ' %' : '0 %');
        if (rtpJitterMs !== null) setText('nsJitter', rtpJitterMs + ' ms');
    }
}

// #netStatsOverlay's visibility toggle — no longer starts/stops its own
// timer (updateStats() above always polls now), just shows/hides the panel.
window.toggleNetStats = function() {
    const el = document.getElementById('netStatsOverlay');
    if (!el) return;
    el.classList.toggle('gone');
};

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        toggleStatsHud, _startStatsHud, _stopStatsHud, _updateStatsHud,
        updateStats,
    };
}
