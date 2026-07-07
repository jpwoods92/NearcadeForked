// ── AUDIO MIXING ────────────────────────────────────────────────────────────
// Loaded via a <script> tag before host.js/viewer.js, same pattern as the
// other scripts/**/*.js modules.
//
// host.js and viewer.js each have their OWN, entirely separate audio-mixing
// system — different gain-node topology, no shared code today. Bundled into
// one file as host-only/viewer-only sections (same call this repo already
// made for scripts/webrtc/codec-negotiation.js's host congestion-control vs.
// viewer bandwidth-profile split), not because they're related, but because
// forcing two near-empty single-concern files would be worse than one file
// with a clear internal boundary. See REFACTOR_PLAN.md Phase 5.5.

// ── HOST-ONLY: desktop/mic gain nodes + master mute ────────────────────────
// ── AUDIO STATE & MASTER MUTE ────────────────────────────────────────────────
// Declared here so host.html inline scripts can reference them without redeclaring.
_desktopGainNode = null;
let _hostMicGainNode  = null;
window._masterMuteActive = false;
window._savedDesktopGain = 1.0;
window._savedMicGain     = 1.0;

function setDesktopVolume(val) {
    const v = parseInt(val, 10);
    const el = document.getElementById('desktopVolVal');
    if (el) el.textContent = v + (el.id === 'desktopVolVal' ? (document.getElementById('volDesktopVal') ? '' : '') : '');
    const el2 = document.getElementById('volDesktopVal');
    if (el2) el2.textContent = v + '%';
    
    const s1 = document.getElementById('desktopVolSlider');
    if (s1 && s1.value != v) s1.value = v;
    const s2 = document.getElementById('volDesktop');
    if (s2 && s2.value != v) s2.value = v;

    saveSetting('ns_host_desktop_vol', v, 'volumeDesktop');
    if (!window._masterMuteActive && _desktopGainNode)
        _desktopGainNode.gain.value = v / 100;
}

function setHostMicGain(val) {
    const v = parseInt(val, 10);
    const el = document.getElementById('hostMicVal');
    if (el) el.textContent = v;
    const el2 = document.getElementById('volMicVal');
    if (el2) el2.textContent = v + '%';

    const s1 = document.getElementById('hostMicSlider');
    if (s1 && s1.value != v) s1.value = v;
    const s2 = document.getElementById('volMic');
    if (s2 && s2.value != v) s2.value = v;

    saveSetting('ns_host_mic_gain', v, 'volumeMic');
    if (!window._masterMuteActive && _hostMicGainNode)
        _hostMicGainNode.gain.value = v / 100;
}

function attachDesktopGain(stream) {
    const aTrack = stream.getAudioTracks()[0];
    if (!aTrack) return;
    try {
        const ctx  = new (window.AudioContext || window.webkitAudioContext)();
        const src  = ctx.createMediaStreamSource(new MediaStream([aTrack]));
        const gain = ctx.createGain();
        const dst  = ctx.createMediaStreamDestination();
        const savedVol = parseInt(localStorage.getItem('ns_host_desktop_vol') ?? '100', 10) / 100;

        //  Apply the 1.4x Volume Buff here!
        gain.gain.value = window._masterMuteActive ? 0 : (savedVol * 1.4);

        src.connect(gain);
        gain.connect(dst);
        _desktopGainNode = gain;

        // 🛡 Prevent Chrome from aggressively deleting the audio pipeline
        window._nsAudioCtx = ctx;
        window._nsAudioSrc = src;
        if (ctx.state === 'suspended') ctx.resume();

        stream.removeTrack(aTrack);
        stream.addTrack(dst.stream.getAudioTracks()[0]);
    } catch(e) { console.warn('[HostAudio] Gain node failed:', e); }
}

function toggleMasterMute() {
    window._masterMuteActive = !window._masterMuteActive;
    const active = window._masterMuteActive;
    const btn  = document.getElementById('btnMasterAudioKill');
    const icon = document.getElementById('speakerIcon');

    if (active) {
        window._savedDesktopGain = _desktopGainNode ? _desktopGainNode.gain.value : 1.0;
        window._savedMicGain     = _hostMicGainNode  ? _hostMicGainNode.gain.value  : 1.0;
        if (_desktopGainNode) _desktopGainNode.gain.value = 0;
        if (_hostMicGainNode)  _hostMicGainNode.gain.value  = 0;
        if (typeof currentStream !== 'undefined' && currentStream)
            currentStream.getAudioTracks().forEach(t => t.enabled = false);
        if (btn)  { btn.classList.add('master-mic-kill'); btn.title = 'Audio MUTED — click to restore'; }
        if (icon) { icon.src = '/assets/icons/speaker-off.svg'; icon.style.filter = 'invert(0.4) sepia(1) saturate(6) hue-rotate(-20deg)'; }
        if (typeof log === 'function') log(I18N.t('Master mute: desktop audio cut'), 'warn');
    } else {
        if (_desktopGainNode) _desktopGainNode.gain.value = window._savedDesktopGain;
        if (_hostMicGainNode)  _hostMicGainNode.gain.value  = window._savedMicGain;
        if (typeof currentStream !== 'undefined' && currentStream)
            currentStream.getAudioTracks().forEach(t => t.enabled = true);
        if (btn)  { btn.classList.remove('master-mic-kill'); btn.title = 'Cut Desktop Audio to Stream'; }
        if (icon) { icon.src = '/assets/icons/speaker.svg'; icon.style.filter = 'invert(0.6)'; }
        if (typeof log === 'function') log(I18N.t('Master mute: audio restored'), 'ok');
    }
}

// ── HOST-ONLY: capture audio-level meter ───────────────────────────────────
let audioCtx, analyser, animFrame;
function startAudioMeter(stream) {
    const fill = document.getElementById('meter');
    if (!fill) return; // Safely exit if UI doesn't have a meter
    
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 256;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    (function draw() { animFrame = requestAnimationFrame(draw); analyser.getByteFrequencyData(data); fill.style.width = Math.min(100, data.reduce((a, b) => a + b, 0) / data.length * 2) + '%'; })();
}
function stopAudioMeter() {
    if (animFrame) cancelAnimationFrame(animFrame);
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    const fill = document.getElementById('meter');
    if (fill) fill.style.width = '0%';
}

// ── HOST-ONLY: global viewer voice volume ──────────────────────────────────
let globalViewerVolume = 1.0;
window.setGlobalViewerVolume = function(val) {
    globalViewerVolume = val / 100;
    const valDisplay = document.getElementById('globalViewerVolVal');
    if (valDisplay) valDisplay.textContent = val + '%';
    
    const s1 = document.getElementById('globalViewerVol');
    if (s1 && s1.value != val) s1.value = val;
    const s2 = document.getElementById('globalViewerVolSlider');
    if (s2 && s2.value != val) s2.value = val;
    
    saveSetting('ns_vol_others', val, 'volumeViewers');

    Object.keys(viewerAudioStates).forEach(vid => {
        const audioEl = document.getElementById('remote-audio-' + vid);
        // Only apply if the individual viewer isn't locally or globally muted (states 0 and 1)
        if (audioEl && viewerAudioStates[vid].state < 2) {
            audioEl.volume = (viewerAudioStates[vid].vol / 100) * globalViewerVolume;
        }
    });
};

// ── VIEWER-ONLY: mic on/off, volume controls, VAD, talking overlay ────────
// ── MIC TOGGLE ────────────────────────────────────────────────────────────────
async function toggleMic() {
    if (forceMutedByHost) return;
    if (!micEnabled) await enableMic(); else disableMic();
}

async function enableMic() {
    if (forceMutedByHost) return;
    try {
        localMicStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false
        });

        const audioTrack = localMicStream.getAudioTracks()[0];
        if (!audioTrack) throw new Error('No audio track returned');

        if (pc && pc.signalingState !== 'closed') {
            micSender = pc.addTrack(audioTrack, localMicStream);
            // NEW: Command the Host to send a fresh offer picking up this new audio track
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'viewer-mic-ready' }));
            }
        }

        micEnabled = true;
        updateMicButton();
        startVAD(localMicStream);
        console.log('[Mic] Enabled:', audioTrack.label);
    } catch (err) {
        console.error('[Mic] Failed:', err);
        localMicStream = null;
        micEnabled = false;
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            showMicToast('Microphone permission denied. Please allow access in your browser.');
        } else {
            showMicToast('Microphone error: ' + err.message);
        }
        updateMicButton();
    }
}

function disableMic() {
    stopVAD();
    teardownSelfMonitor();

    if (micSender && pc && pc.signalingState !== 'closed') {
        try { pc.removeTrack(micSender); } catch (e) { console.warn('[Mic] removeTrack error:', e); }
        micSender = null;
    }
    if (localMicStream) {
        localMicStream.getTracks().forEach(t => t.stop());
        localMicStream = null;
    }

    micEnabled = false;
    updateMicButton();
    setLocalTalking(false);
    console.log('[Mic] Disabled');
}

function updateMicButton() {
    const btn = document.getElementById('micBtn');
    if (!btn) return;
    if (forceMutedByHost) {
        btn.textContent = 'Muted by Host';
        btn.className = 'ns-bar-btn ns-btn-danger';
        return;
    }
    if (micEnabled) {
        btn.textContent = 'Microphone: ON';
        btn.className = 'ns-bar-btn ns-btn-active';
    } else {
        btn.textContent = 'Microphone: OFF';
        btn.className = 'ns-bar-btn';
    }
    // Mic gain slider lives in the floating audio panel — always accessible, no show/hide needed
}

function showMicToast(msg) {
    const t = document.getElementById('micToast');
    if (!t) return;
    t.querySelector('.toast-msg').textContent = msg;
    t.classList.add('toast-show');
    setTimeout(() => t.classList.remove('toast-show'), 5000);
}

// ── AUDIO VOLUME CONTROLS ─────────────────────────────────────────────────────
// Persist prefs so they survive refresh
const _audioPrefs = {
    streamVol: parseFloat(localStorage.getItem('ns_vol_stream') ?? '1.0'),
    micGain: parseFloat(localStorage.getItem('ns_vol_micgain') ?? '1.0'),
    selfMonitor: parseFloat(localStorage.getItem('ns_vol_selfmon') ?? '0.0'),
    othersVol: parseFloat(localStorage.getItem('ns_vol_others') ?? '1.0'),
};

document.addEventListener('DOMContentLoaded', () => {
    const sv = document.getElementById('streamVolSlider');
    const sg = document.getElementById('micGainSlider');
    const sm = document.getElementById('selfMonitorSlider');
    const ov = document.getElementById('othersVolSlider');
    if (sv) { sv.value = Math.round(_audioPrefs.streamVol * 100); const d = document.getElementById('streamVolVal'); if (d) d.textContent = sv.value; }
    if (sg) { sg.value = Math.round(_audioPrefs.micGain * 100); const d = document.getElementById('micGainVal'); if (d) d.textContent = sg.value; }
    if (sm) { sm.value = Math.round(_audioPrefs.selfMonitor * 100); const d = document.getElementById('selfMonitorVal'); if (d) d.textContent = sm.value; }
    if (ov) { ov.value = Math.round(_audioPrefs.othersVol * 100); const d = document.getElementById('othersVolVal'); if (d) d.textContent = ov.value; }
    // Apply stream volume to video immediately
    const videoEl = document.getElementById('video');
    if (videoEl) videoEl.volume = _audioPrefs.streamVol;
    const remoteAudioEl = document.getElementById('remote-audio');
    if (remoteAudioEl) remoteAudioEl.volume = _audioPrefs.streamVol;
});

// Stream volume
function setStreamVolume(val) {
    const v = parseInt(val, 10);
    _audioPrefs.streamVol = v / 100;
    localStorage.setItem('ns_vol_stream', _audioPrefs.streamVol);
    const videoEl = document.getElementById('video');
    if (videoEl) videoEl.volume = _audioPrefs.streamVol;
    const remoteAudioEl = document.getElementById('remote-audio');
    if (remoteAudioEl) remoteAudioEl.volume = _audioPrefs.streamVol;
    const display = document.getElementById('streamVolVal');
    if (display) display.textContent = v;
    if (v > 0 && audioMuted) {
        audioMuted = false;
        if (videoEl?.srcObject) videoEl.srcObject.getAudioTracks().forEach(t => { t.enabled = true; });
        const remoteAudioEl = document.getElementById('remote-audio');
        if (remoteAudioEl?.srcObject) remoteAudioEl.srcObject.getAudioTracks().forEach(t => { t.enabled = true; });
        const btn = document.getElementById('audBtn');
        if (btn) { btn.textContent = 'Stream Audio'; btn.className = 'ns-bar-btn ns-btn-active'; }
    }
}

// Mic gain
let micGainNode = null;
let micGainValue = 1.0;
function setMicGain(val) {
    micGainValue = parseInt(val, 10) / 100;
    _audioPrefs.micGain = micGainValue;
    localStorage.setItem('ns_vol_micgain', micGainValue);
    if (micGainNode) micGainNode.gain.value = micGainValue;
    const display = document.getElementById('micGainVal');
    if (display) display.textContent = val;
}

// Self-monitor
let selfMonitorGain = null;
let selfMonitorSrc = null;
function setSelfMonitor(val) {
    const level = parseInt(val, 10) / 100;
    _audioPrefs.selfMonitor = level;
    localStorage.setItem('ns_vol_selfmon', level);
    const display = document.getElementById('selfMonitorVal');
    if (display) display.textContent = val;
    if (!localMicStream) return;
    if (!selfMonitorGain) {
        if (!sysAudioCtx) sysAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (sysAudioCtx.state === 'suspended') sysAudioCtx.resume();
        selfMonitorSrc = sysAudioCtx.createMediaStreamSource(localMicStream);
        selfMonitorGain = sysAudioCtx.createGain();
        selfMonitorGain.gain.value = level;
        selfMonitorSrc.connect(selfMonitorGain);
        selfMonitorGain.connect(sysAudioCtx.destination);
    } else {
        selfMonitorGain.gain.value = level;
    }
}

// Others — volume for incoming remote voice tracks (stub; wire when peer audio tracks arrive)
let _othersGainNode = null;
function setOthersVolume(val) {
    const level = parseInt(val, 10) / 100;
    _audioPrefs.othersVol = level;
    localStorage.setItem('ns_vol_others', level);
    if (_othersGainNode) _othersGainNode.gain.value = level;
    const display = document.getElementById('othersVolVal');
    if (display) display.textContent = val;
}

// Tear down self-monitor on mic disable
function teardownSelfMonitor() {
    if (selfMonitorSrc) { try { selfMonitorSrc.disconnect(); } catch { } selfMonitorSrc = null; }
    if (selfMonitorGain) { try { selfMonitorGain.disconnect(); } catch { } selfMonitorGain = null; }
    const slider = document.getElementById('selfMonitorSlider');
    const valEl = document.getElementById('selfMonitorVal');
    if (slider) slider.value = 0;
    if (valEl) valEl.textContent = '0';
    _audioPrefs.selfMonitor = 0;
    localStorage.setItem('ns_vol_selfmon', '0');
}

// Audio panel toggle (floating bottom-right button)
function toggleAudioPanel() {
    const panel = document.getElementById('audioPanel');
    const btn = document.getElementById('audioBtn');
    if (!panel) return;
    const isOpen = panel.classList.contains('open');
    panel.classList.toggle('open', !isOpen);
    if (btn) btn.classList.toggle('open', !isOpen);
    if (!isOpen) document.getElementById('nsBar')?.classList.remove('open');
}
// ─────────────────────────────────────────────────────────────────────────────

// ── VOICE ACTIVITY DETECTION ──────────────────────────────────────────────────
function startVAD(stream) {
    stopVAD();
    try {
        vadAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        vadAnalyser = vadAudioCtx.createAnalyser();
        vadAnalyser.fftSize = 512;
        vadAnalyser.smoothingTimeConstant = 0.3;
        vadSource = vadAudioCtx.createMediaStreamSource(stream);
        vadSource.connect(vadAnalyser);

        const dataArray = new Uint8Array(vadAnalyser.frequencyBinCount);
        function vadTick() {
            vadRafId = requestAnimationFrame(vadTick);
            vadAnalyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
            const rms = Math.sqrt(sum / dataArray.length);

            if (rms > VAD_THRESHOLD) {
                clearTimeout(vadTalkingTimer);
                vadTalkingTimer = null;
                if (!vadIsTalking) { vadIsTalking = true; setLocalTalking(true); }
            } else if (vadIsTalking && !vadTalkingTimer) {
                vadTalkingTimer = setTimeout(() => {
                    vadIsTalking = false;
                    vadTalkingTimer = null;
                    setLocalTalking(false);
                }, VAD_HOLD_MS);
            }
        }
        vadTick();
        console.log('[VAD] Started');
    } catch (e) { // <--- ADDED THE MISSING } RIGHT HERE
        console.error('[VAD] Error:', e);
    }
}

function stopVAD() {
    if (vadRafId) { cancelAnimationFrame(vadRafId); vadRafId = null; }
    clearTimeout(vadTalkingTimer); vadTalkingTimer = null;
    vadIsTalking = false;
    try { if (vadSource) { vadSource.disconnect(); vadSource = null; } } catch { }
    try { if (vadAudioCtx) { vadAudioCtx.close(); vadAudioCtx = null; } } catch { }
    vadAnalyser = null;
}

// ── WHO'S TALKING OVERLAY ─────────────────────────────────────────────────────
function setLocalTalking(active) {
    const myEntry = document.getElementById('talkingMe');
    if (myEntry) myEntry.classList.toggle('talking-active', active);
    refreshTalkingOverlayVisibility();
}

/**
 * Stub: update overlay with remote speaker list from server.
 * Wire this up to a 'voice-activity' WebSocket message later.
 * @param {string[]} activeSpeakerIds
 */
function updateTalkingOverlay(activeSpeakerIds) {
    const overlay = document.getElementById('talkingOverlay');
    if (!overlay) return;
    overlay.querySelectorAll('.talking-remote').forEach(el => el.remove());
    activeSpeakerIds.forEach(id => {
        const el = document.createElement('div');
        el.className = 'talking-entry talking-remote talking-active';
        el.dataset.viewerId = id;
        el.innerHTML = `<span class="talking-dot"></span><span class="talking-name">${id}</span>`;
        overlay.appendChild(el);
    });
    refreshTalkingOverlayVisibility();
}

function refreshTalkingOverlayVisibility() {
    const overlay = document.getElementById('talkingOverlay');
    if (!overlay) return;
    const anyActive = !!overlay.querySelector('.talking-active');
    overlay.classList.toggle('talking-overlay-visible', anyActive);
}

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        setDesktopVolume, setHostMicGain, attachDesktopGain, toggleMasterMute,
        startAudioMeter, stopAudioMeter,
        toggleMic, enableMic, disableMic, updateMicButton, showMicToast,
        setStreamVolume, setMicGain, setSelfMonitor, setOthersVolume, teardownSelfMonitor,
        toggleAudioPanel, startVAD, stopVAD, setLocalTalking, updateTalkingOverlay,
        refreshTalkingOverlayVisibility,
    };
}
