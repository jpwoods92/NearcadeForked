const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const host = location.host;
let ws,
  pc,
  myId = sessionStorage.getItem('ns_viewer_id');
let _reconnectTimer = null;
let viewerRegion = '';
let smartDb = {};
window.smartDb = smartDb;

let _turnCredentials = null;
let _turnFetchPromise = (async () => {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const hostParam = urlParams.get('host') ? `?host=${urlParams.get('host')}` : '';
    const scheme = location.protocol === 'file:' ? 'http://localhost:3000' : '';
    const res = await fetch(`${scheme}/api/turn${hostParam}`);
    if (res.ok) _turnCredentials = await res.json();
  } catch (e) {
    console.warn('Failed to fetch TURN credentials:', e);
  }
})();

// ── EARLY PIN / CONNECT STATE (must be declared before async standby handler) ──
let pinRequired = true;
let _autoJoinedVps = false;

// ── EARLY STANDBY CONNECTION ────────────────────────────────────────────────
// Always attempt to connect to the VPS standby lane. If we are on a standard
// peer-to-peer local server, this route doesn't exist and will silently fail (404),
// which is perfectly fine. If we are on the VPS, it connects and instantly checks state.
const urlParamsGlobal = new URLSearchParams(window.location.search);
const standbyWs = new WebSocket(`${proto}://${host}/vps?standby=true`);
standbyWs.onmessage = (e) => {
  let msg;
  try {
    msg = JSON.parse(e.data);
  } catch {
    return;
  }
  if (msg.type === 'stream-idle') {
    const pinScreen = document.getElementById('pinScreen');
    const onPinScreen = pinScreen && !pinScreen.classList.contains('gone');
    if (!onPinScreen || _nsHostConnected) return;
    let sf = document.getElementById('_nsStandbyFrame');
    if (!sf) {
      sf = document.createElement('iframe');
      sf.id = '_nsStandbyFrame';
      sf.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:none;z-index:9000;background:#080808;';
      sf.src = '/standby.html';
      document.body.appendChild(sf);
    } else {
      sf.style.display = 'block';
    }
  } else if (msg.type === 'stream-active') {
    const sf = document.getElementById('_nsStandbyFrame');
    if (sf) sf.style.display = 'none';
  }
  if (msg.pinRequired !== undefined) {
    pinRequired = msg.pinRequired;
    const pw = document.getElementById('pinWrap');
    if (pw) pw.style.display = pinRequired ? 'flex' : 'none';
    // If host has disabled PIN, skip the screen entirely and auto-join
    if (!pinRequired && !_autoJoinedVps && !ws) {
      _autoJoinedVps = true;
      document.getElementById('pinScreen')?.classList.add('gone');
      submitPin();
    }
  }
};
standbyWs.onerror = () => {};

// ?preview=1 opens a standalone lobby preview window (upstream v3.0.2 —
// lobby.js is an ES module, loaded here via dynamic import only)
if (urlParamsGlobal.has('preview')) {
  import('./lobby.js').then((m) => {
    const w = window.open('', 'lobbyPreview', 'width=960,height=540,left=100,top=100,resizable=yes');
    if (w) {
      w.document.title = 'Nearcade Lobby Preview';
      w.document.body.style.margin = '0';
      w.document.body.style.background = '#000';
      w.document.body.style.overflow = 'hidden';
      const c = w.document.createElement('canvas');
      c.width = 960;
      c.height = 540;
      c.style.cssText = 'width:100%;height:100%;display:block;';
      w.document.body.appendChild(c);
      m.runDesktopPreview(c);
    }
  });
}

async function safeApiJson(url, fallback) {
  try {
    const r = await fetch(url);
    if (!r.ok) return fallback;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return fallback;
    return await r.json();
  } catch (_) {
    return fallback;
  }
}
// Cooldown: every request costs the host a full-size keyframe, so a burst of
// decode errors must not turn into a keyframe storm that worsens congestion.
let _lastKfRequestTs = 0;
function requestKeyframeFromHost(force) {
  const now = Date.now();
  if (!force && now - _lastKfRequestTs < 250) return;
  _lastKfRequestTs = now;
  if (ws?.readyState === 1)
    ws.send(JSON.stringify({ type: 'request-keyframe', viewerId: typeof myId !== 'undefined' ? myId : null }));
}

let _lastWcRebuildTs = 0;
function recoverWebCodecsDecoder() {
  window.nsWaitKey = true;
  requestKeyframeFromHost();

  // Cheap path: a decode() throw (e.g. delta before keyframe) leaves the
  // decoder alive — reset it in place instead of destroying it and stalling
  // until the host resends its config.
  if (wcDecoder && wcDecoder.state !== 'closed' && window._wcActiveDecoderConfig) {
    try {
      wcDecoder.reset();
      wcDecoder.configure(window._wcActiveDecoderConfig);
      return;
    } catch (_) {}
  }

  try {
    if (wcDecoder?.state !== 'closed') wcDecoder.close();
  } catch (_) {}
  wcDecoder = null;

  // Full path (fatal codec errors close the decoder): rebuild immediately
  // from the cached host config — initWebCodecsViewer reuses the existing
  // canvas/GL context. Rate-limited so a poisoned config can't rebuild-loop.
  if (window._wcLastConfigMsg && Date.now() - _lastWcRebuildTs > 1000) {
    _lastWcRebuildTs = Date.now();
    try {
      initWebCodecsViewer(window._wcLastConfigMsg);
    } catch (_) {}
  }
}
// Decode one complete [isKey(1)][timestamp(8)][payload] frame received on
// the WebCodecs DataChannel (whole message, or reassembled from fragments —
// see the ondatachannel handler in createPC()).
function _wcHandleDcVideo(buf) {
  // Prevent double-decoding if we are receiving frames from the VPS SFU.
  // (P2P mode's WebSocket-shaped object has no .url — guard it, or every
  // frame dies on a TypeError inside the async onmessage handler.)
  if (ws && typeof ws.url === 'string' && ws.url.includes('/vps')) return;

  if (!wcDecoder || wcDecoder.state !== 'configured') return;
  if (buf.byteLength <= 9) return;

  const view = new DataView(buf);
  const isKey = view.getUint8(0) === 1;
  const timestamp = view.getFloat64(1, true);
  const chunkData = new Uint8Array(buf, 9);

  // --- RESILIENCY LAYER ---
  // window.nsWaitKey (not a channel-local flag) so decoder resets in
  // recoverWebCodecsDecoder() re-arm this gate too — otherwise this path
  // keeps feeding deltas to a freshly reset decoder.
  if (window.nsWaitKey) {
    if (!isKey) return;
    window.nsWaitKey = false;
    console.log('[WebCodecs] Locked onto keyframe stream.');
  }

  // Stall guard: ~0.5s of queued frames (threshold set per-stream-fps in
  // initWebCodecsViewer) means the decoder is wedged — reset and resync.
  // Smaller backlogs are ordinary jitter and simply drain.
  if (wcDecoder.decodeQueueSize > (window._wcQueueGuard || 70)) {
    if (Date.now() - (window._wcLastStallWarnTs || 0) > 5000) {
      window._wcLastStallWarnTs = Date.now();
      console.warn(`[WebCodecs] Decoder stalled (${wcDecoder.decodeQueueSize} queued) — resyncing at next keyframe`);
    }
    recoverWebCodecsDecoder();
    return;
  }

  try {
    const chunk = new EncodedVideoChunk({
      type: isKey ? 'key' : 'delta',
      timestamp: timestamp,
      data: chunkData,
    });
    wcDecoder.decode(chunk);
  } catch (err) {
    console.error('[WebCodecs] Decode error, dropping frame...', err);
    recoverWebCodecsDecoder();
  }
}

let sysAudioCtx = null;
let nextAudioTime = 0;
// Note: stopReconnect and vpsConnected are declared below near connect()
let myName = urlParamsGlobal.get('name') || localStorage.getItem('ns_name') || '';
document.getElementById('nameInput').value = myName || 'Guest' + Math.floor(Math.random() * 9000 + 1000);
if (urlParamsGlobal.get('name')) localStorage.setItem('ns_name', myName);
// Fall back to server config name so arcade/in-app viewers see their dashboard name
if (!localStorage.getItem('ns_name')) {
  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => {
      if (cfg && cfg.hostName) {
        myName = cfg.hostName;
        document.getElementById('nameInput').value = myName;
        localStorage.setItem('ns_name', myName);
      }
    })
    .catch(() => {});
}
let enteredPin = '',
  enteredPassword = '',
  audioMuted = false;
let kbEnabled = false;

// ── VOICE CHAT STATE ──────────────────────────────────────────────────────────
let localMicStream = null;
let micSender = null;
let micEnabled = false;
let forceMutedByHost = false;

// Voice Activity Detection
let vadAudioCtx = null;
let vadAnalyser = null;
let vadSource = null;
let vadRafId = null;
const VAD_THRESHOLD = 18; // RMS energy level (0-255)
const VAD_HOLD_MS = 800; // ms to hold "talking" indicator after silence
let vadTalkingTimer = null;
let vadIsTalking = false;
// ─────────────────────────────────────────────────────────────────────────────
// ── WebCodecs Globals ──
// USE_WEBCODECS: true when launched with --webcodecs flag (?wc=1 or ?wc=2 in URL).
// In this mode the DataChannel pipeline is the primary renderer; the WebRTC
// video track is still received (for timing / signalling parity) but is
// immediately muted and never shown.
const _wcFlag = new URLSearchParams(location.search).get('wc');
const USE_WEBCODECS = _wcFlag === '1' || _wcFlag === '2';
const CUSTOM_WEBCODECS = _wcFlag === '2';

let wcDecoder = null;
// Pre-wire to the canvas already in index.html so initWebCodecsViewer never
// creates a duplicate element.
let wcCanvas = document.getElementById('webcodecs-canvas') || null;
let wcCtx = null;
let wcGlTexture = null;
const CONTROLLER_GUIDE_STORAGE_KEY = 'ns_controller_guide_ack';
const CLIENT_VERSION = window.NEARSEC_VERSION || '1.0.0';

// Tracks whether an active host stream session exists in this browser tab.
// Used to gate the standby screen so it only appears on the pin screen
// when no host has connected yet.
let _nsHostConnected = false;

document.addEventListener('click', unlockAudio, { once: true, passive: true });
document.addEventListener('touchstart', unlockAudio, { once: true, passive: true });

function unlockAudio() {
  if (!sysAudioCtx) sysAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (sysAudioCtx.state === 'suspended') sysAudioCtx.resume();
  console.log('[Audio] Engine Unlocked by user gesture');
}

function openControllerGuide() {
  document.getElementById('controllerGuideModal').classList.remove('hidden');
}
function closeControllerGuide() {
  document.getElementById('controllerGuideModal').classList.add('hidden');
}
function acknowledgeControllerGuide() {
  closeControllerGuide();
}
function maybeShowControllerGuide() {
  if (!_nsHostConnected) return;
  if (sessionStorage.getItem(CONTROLLER_GUIDE_STORAGE_KEY)) return;
  if (knownNativePads.length > 0) return; // Native controllers are auto-mapped and bypass browser Gamepad API

  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let needsCalib = false;

  for (const gp of pads) {
    if (!gp) continue;
    if (lookupCalibMap(gp)) continue; // We already have a map

    const idLower = gp.id.toLowerCase();
    // Standard brands that are natively mapped by the browser/smartDb don't need calibration
    if (
      idLower.includes('xbox') ||
      idLower.includes('playstation') ||
      idLower.includes('dualshock') ||
      idLower.includes('dualsense') ||
      idLower.includes('x-box')
    ) {
      continue;
    }

    needsCalib = true;
    break;
  }

  if (needsCalib) {
    sessionStorage.setItem(CONTROLLER_GUIDE_STORAGE_KEY, '1');
    setTimeout(() => openControllerGuide(), 700);
  }
}
// ── PEER CONNECTION ───────────────────────────────────────────────────────────
async function createPC() {
  if (pc) {
    try {
      pc.close();
    } catch (e) {}
  }
  console.log('[WebRTC] Initializing new PeerConnection...');

  if (!_turnCredentials && _turnFetchPromise) {
    await _turnFetchPromise;
  }

  pc = new RTCPeerConnection(buildRtcConfig(_turnCredentials));

  pc.onconnectionstatechange = () => {
    console.log(`[WebRTC] Connection State: ${pc.connectionState}`);
    if (pc.connectionState === 'failed') {
      console.warn('[WebRTC] Connection failed — requesting fresh offer in 1s...');
      setStatus('Connection failed. Retrying...');
      clearTimeout(_reconnectTimer);
      _reconnectTimer = setTimeout(() => {
        if (ws?.readyState === 1 && (!pc || pc.connectionState !== 'connected')) {
          ws.send(JSON.stringify({ type: 'request-offer' }));
        }
      }, 1000);
    }
    if (pc.connectionState === 'disconnected') console.warn('[WebRTC] Disconnected.');
  };
  pc.oniceconnectionstatechange = () => console.log(`[WebRTC] ICE State: ${pc.iceConnectionState}`);
  pc.onsignalingstatechange = () => console.log(`[WebRTC] Signaling State: ${pc.signalingState}`);
  pc.onicecandidateerror = (e) => console.error('[WebRTC] ICE Error:', e);

  pc.onicecandidate = (e) => {
    if (e.candidate && e.candidate.candidate && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'ice-viewer', candidate: e.candidate, viewerId: myId }));
    }
  };

  pc.ontrack = (e) => {
    console.log(`[WebRTC] Received Track: ${e.track.kind}`);
    if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0;
    if (e.track.kind === 'video') {
      if (USE_WEBCODECS) {
        // WebCodecs mode: DataChannel is the real renderer.
        // Attach the track to a silent video element just to keep
        // the WebRTC engine happy (RTCP feedback, etc.) — never shown.
        const sink = document.getElementById('video');
        if (sink) {
          sink.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
          sink.style.display = 'none';
        }
        // Show the WebCodecs canvas layer; decoder will be configured
        // when the host sends the 'webcodecs-config' DataChannel message.
        if (wcCanvas) {
          wcCanvas.style.display = 'block';
        }
        console.log('[WebCodecs] Video track suppressed — DataChannel renderer active');
        return;
      }
      // Normal WebRTC mode: attach to the primary #video element.
      const videoEl = document.getElementById('video');
      if (videoEl) {
        videoEl.muted = true; // Required by Chrome/Safari to allow dynamic autoplay
        videoEl.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
        videoEl.play().catch((err) => console.warn('[WebRTC] video.play() exception:', err));
        videoEl.onplaying = () => {
          if (typeof showOverlay === 'function') showOverlay(false);
          setStatus('');
          const spinner = document.getElementById('spinner');
          if (spinner) spinner.style.display = 'none';
          if (typeof _swapOverlayEl !== 'undefined' && _swapOverlayEl) {
            _swapOverlayEl.style.display = 'none';
          }
          const overlay = document.getElementById('overlay');
          if (overlay) overlay.style.backgroundColor = '';
        };
        console.log('[WebRTC] Video stream attached to #video');
      }
    } else if (e.track.kind === 'audio') {
      let audioEl = document.getElementById('remote-audio');
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = 'remote-audio';
        audioEl.autoplay = true;
        document.body.appendChild(audioEl);
      }
      audioEl.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      audioEl.play().catch((e) => console.warn('[WebRTC] Audio blocked:', e));
      audioEl.muted = typeof audioMuted !== 'undefined' ? audioMuted : false;
      audioEl.volume =
        typeof _audioPrefs !== 'undefined' && _audioPrefs.streamVol !== undefined ? _audioPrefs.streamVol : 1.0;
      console.log('[WebRTC] Audio stream attached to dedicated #remote-audio element');
    }
  };
  // ── EXPERIMENTAL WEBCODECS DATA CHANNEL RECEIVER ──
  pc.ondatachannel = (event) => {
    const channel = event.channel;

    // --- WEBCODECS VIDEO PIPELINE ---
    if (channel.label === 'webcodecs') {
      console.log('[WebRTC] DataChannel opened for WebCodecs payload: webcodecs');

      // Spec default is 'blob' (Firefox honors it) — without this, frames
      // arrive as Blobs and the ArrayBuffer check below drops every one.
      channel.binaryType = 'arraybuffer';

      const askForSync = () => {
        console.log('[WebCodecs] Channel ready. Requesting initial keyframe and config sync.');
        // Signals the WS handler to ignore its duplicate copy of the stream
        // (the host also relays frames through the tunnel WS as a fallback).
        window._wcDcOpen = true;
        requestKeyframeFromHost(true);
      };

      if (channel.readyState === 'open') {
        askForSync();
      } else {
        channel.onopen = askForSync;
      }
      channel.onclose = () => {
        window._wcDcOpen = false;
      };

      channel.onmessage = async (e) => {
        // 1. Process String Configuration Messages
        if (typeof e.data === 'string') {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'webcodecs-config') {
              initWebCodecsViewer(msg);
            }
          } catch (err) {
            console.warn('[WebCodecs] Failed to parse string message:', err);
          }
          return;
        }

        // 2. Process Binary Video Frames
        if (e.data instanceof ArrayBuffer) {
          if (e.data.byteLength < 1) return;
          const tag = new Uint8Array(e.data, 0, 1)[0];

          // Fragmented frame (byte0: 2 = fragment, 3 = final). The host
          // splits frames > ~60KB because SCTP rejects messages larger than
          // the receiver's advertised limit — 256KB on Chrome, 64KB on
          // Safari — which silently killed every keyframe for those
          // browsers. Channel is reliable+ordered, so simple concatenation
          // reassembles correctly.
          if (tag === 2 || tag === 3) {
            if (!window._wcFragParts) window._wcFragParts = [];
            window._wcFragParts.push(new Uint8Array(e.data, 1));
            if (tag !== 3) return;
            const parts = window._wcFragParts;
            window._wcFragParts = [];
            let total = 0;
            for (const p of parts) total += p.byteLength;
            const whole = new Uint8Array(total);
            let off = 0;
            for (const p of parts) {
              whole.set(p, off);
              off += p.byteLength;
            }
            _wcHandleDcVideo(whole.buffer);
            return;
          }

          _wcHandleDcVideo(e.data);
        }
      };
      return; // Stop here so it doesn't fall through to the input block
    }

    // --- STANDARD FAST-LANE INPUT PIPELINE ---
    if (channel.label === 'input') {
      console.log('[Input] Dedicated 250Hz Fast Lane connected.');

      // This ensures your mouse/keyboard coordinates are actually processed
      channel.onmessage = (e) => {
        // (If your viewer was receiving data from the host here, you'd parse it.
        // Usually this channel is purely for sending FROM the viewer TO the host,
        // but we must acknowledge the channel open state regardless).
      };

      // Bind the fast-lane channel to your input dispatcher
      window._fastLaneChannel = channel;
    }
  };
  // Re-attach mic on reconnect
  if (localMicStream) {
    console.log('[WebRTC] Re-attaching local microphone...');
    const audioTrack = localMicStream.getAudioTracks()[0];
    if (audioTrack) micSender = pc.addTrack(audioTrack, localMicStream);
  }

  // Renegotiation — sends a new offer when tracks are added/removed
  pc.onnegotiationneeded = async () => {
    if (!ws || ws.readyState !== 1) return;
    try {
      console.log('[WebRTC] Renegotiation needed — sending new offer...');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
    } catch (err) {
      console.error('[WebRTC] Renegotiation error:', err);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const CODEC_PRIORITY = ['video/H264', 'video/VP8'];
function preferReceiverCodec(transceiver, preferredMime) {
  const caps = RTCRtpReceiver.getCapabilities?.('video');
  if (!caps || !transceiver) return null;
  let priority = CODEC_PRIORITY;
  if (preferredMime) {
    priority = [preferredMime, ...CODEC_PRIORITY.filter((c) => c.toLowerCase() !== preferredMime.toLowerCase())];
  }

  let codecs = [...caps.codecs];
  let reordered = [];

  // We iterate through our priority list and splice out the matching codec (and its RTX payload if present)
  // to build our strictly compliant preferred list, keeping the remaining codecs in their exact original order.
  // extractPreferredCodec() (shared with host.js's preferVideoCodec — see
  // scripts/webrtc/codec-negotiation.js) does the H264-baseline-profile fix
  // and RTX-adjacency splice for a single mime.
  for (const mime of priority) {
    reordered.push(...extractPreferredCodec(codecs, mime));
  }

  const sorted = [...reordered, ...codecs];
  try {
    transceiver.setCodecPreferences(sorted);
    return sorted[0]?.mimeType || null;
  } catch {
    return null;
  }
}

const video = document.getElementById('video');
const frameCanvas = document.getElementById('frameCanvas');
const frameCtx = frameCanvas.getContext('2d', { alpha: false });
let processorRunning = false;

// Wired here rather than in input/gamepad.js (which owns requestPointerLock):
// that script loads *before* this one, so at its own top-level parse time
// `frameCanvas`/`video` wouldn't exist yet. requestPointerLock() itself is
// fine to reference here since gamepad.js has already run by now.
frameCanvas.addEventListener('click', requestPointerLock);
video.addEventListener('click', requestPointerLock);

// ── STATUS / OVERLAY ──────────────────────────────────────────────────────────
function log(msg) {
  console.log(msg);
}
function setStatus(msg, live) {
  document.getElementById('overlayStatus').textContent = msg;
  document.getElementById('topStatus').textContent = msg;
  if (live) document.getElementById('liveDot').style.display = 'inline-block';
}
function showOverlay(v) {
  document.getElementById('overlay').classList.toggle('gone', !v);
}

// Captures the current rendered frame into _swapOverlayEl so the viewer sees
// a freeze-frame (rather than black) during host disconnects / codec swaps.
// Works in both WebCodecs canvas mode and legacy frameCanvas mode.
let _swapOverlayEl = null;
function _freezeFrameForSwap() {
  let src = wcCanvas && wcCanvas.style.display !== 'none' ? wcCanvas : document.getElementById('video');
  if (!src) return;

  // Support both Canvas (.width) and Video (.videoWidth)
  let w = src.width || src.videoWidth;
  let h = src.height || src.videoHeight;

  // Fallback to screen resolution if no valid frame exists so we can at least draw crisp text
  if (!w || !h) {
    w = window.innerWidth * (window.devicePixelRatio || 1);
    h = window.innerHeight * (window.devicePixelRatio || 1);
    src = null; // Don't try to drawImage a broken source
  }

  if (!_swapOverlayEl) {
    _swapOverlayEl = document.createElement('canvas');
    _swapOverlayEl.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:5;pointer-events:none;';
    const container = document.getElementById('video-container') || document.body;
    container.appendChild(_swapOverlayEl);
  }

  _swapOverlayEl.style.display = 'block';
  _swapOverlayEl.width = w;
  _swapOverlayEl.height = h;

  const ctx = _swapOverlayEl.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (src) {
    try {
      ctx.drawImage(src, 0, 0, w, h);
    } catch (e) {}
  }
}

// ── DEDICATED INPUT FAST LANE ─────────────────────────────────────────────────
let inputWs = null;

function connectInputWS() {
  if (inputWs && inputWs.readyState <= 1) return;

  const urlParams = new URLSearchParams(window.location.search);
  const useVps = location.hostname === 'publicnearcade.cutefame.net' || urlParams.has('v3') || urlParams.has('vps');
  if (useVps) return; // In VPS mode, all inputs flow cleanly over the main /vps WebSocket

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  inputWs = new WebSocket(proto + '://' + location.host + '/ws/input');

  inputWs.onopen = () => {
    console.log('[Input] Dedicated 250Hz Fast Lane connected.');
    // The server needs us to identify ourselves on this separate pipe!
    if (myId) inputWs.send(JSON.stringify({ type: 'identify', viewerId: myId }));

    // Clock-sync loop for the server's input-latency log: lets the server
    // convert our _lt input stamps to its own clock (see sendInputData and
    // server/input-latency-log.js). Re-synced every 30s to ride out drift
    // and NTP steps; the server keeps whichever sample had the lowest RTT.
    if (window._nsClockSyncTimer) clearInterval(window._nsClockSyncTimer);
    const sendClockSync = () => {
      if (inputWs && inputWs.readyState === 1) {
        inputWs.send(JSON.stringify({ type: 'clock-sync', vt: Date.now() }));
      }
    };
    sendClockSync();
    window._nsClockSyncTimer = setInterval(sendClockSync, 30000);
  };

  inputWs.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'clock-sync-ack') {
        inputWs.send(JSON.stringify({ type: 'clock-sync-done', vt: msg.vt, st: msg.st, vt2: Date.now() }));
      }
    } catch (_) {}
  };

  inputWs.onclose = () => {
    console.warn('[Input] Fast Lane disconnected. Retrying in 2s...');
    if (window._nsClockSyncTimer) clearInterval(window._nsClockSyncTimer);
    setTimeout(connectInputWS, 2000);
  };

  inputWs.onerror = () => console.error('[Input] Fast Lane error.');
}

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────
// State vars (vpsConnected, stopReconnect, _autoJoinedVps, pinRequired) declared early at top of file.
let vpsConnected = false;
let stopReconnect = false;
async function connect() {
  const urlParams = new URLSearchParams(window.location.search);
  const hostParam = urlParams.get('host');

  // Check if we are connecting to a P2P room
  if (hostParam && hostParam.startsWith('p2p://')) {
    // createP2PConnection (scripts/p2p-viewer.js) builds a WebSocket-
    // shaped object routed through Trystero — see that file for why this
    // was pulled out of connect() (REFACTOR_PLAN.md Phase 5.11).
    ws = createP2PConnection(hostParam.replace('p2p://', ''));
  } else {
    // Always use /vps for the public domain or if v3 is forced
    const useVps = location.hostname === 'publicnearcade.cutefame.net' || urlParams.has('v3') || urlParams.has('vps');
    let wsUrl = useVps ? `${proto}://${host}/vps` : `${proto}://${host}/ws/viewer`;

    if (enteredPin) wsUrl += (wsUrl.includes('?') ? '&' : '?') + `pin=${encodeURIComponent(enteredPin)}`;
    if (enteredPassword) wsUrl += (wsUrl.includes('?') ? '&' : '?') + `password=${encodeURIComponent(enteredPassword)}`;
    const sig = new Signaling();
    let _sigOnOpen, _sigOnMessage, _sigOnClose, _sigOnError;
    ws = {
      get readyState() {
        return sig.readyState;
      },
      url: wsUrl,
      set onopen(fn) {
        _sigOnOpen = fn;
      },
      get onopen() {
        return _sigOnOpen;
      },
      set onmessage(fn) {
        _sigOnMessage = fn;
      },
      get onmessage() {
        return _sigOnMessage;
      },
      set onclose(fn) {
        _sigOnClose = fn;
      },
      get onclose() {
        return _sigOnClose;
      },
      set onerror(fn) {
        _sigOnError = fn;
      },
      get onerror() {
        return _sigOnError;
      },
      set binaryType(_) {},
      get binaryType() {
        return 'arraybuffer';
      },
      send: (data) => {
        if (data instanceof ArrayBuffer || data instanceof Blob) return sig.sendBinary(data);
        return sig.send(data);
      },
      close: (c, r) => sig.disconnect(c, r),
      addEventListener: () => {},
      removeEventListener: () => {},
      _sig: sig,
    };
    sig.on('connected', () => {
      if (_sigOnOpen) _sigOnOpen({});
    });
    sig.on('disconnected', (d) => {
      if (_sigOnClose) _sigOnClose({ code: d.code || 1000, reason: d.reason || '' });
    });
    sig.on('error', (d) => {
      if (_sigOnError) _sigOnError(d || {});
    });
    sig.on('binary', (data) => {
      if (_sigOnMessage) _sigOnMessage({ data });
    });
    sig.on('*', (type, msg) => {
      if (_sigOnMessage && !{ connected: 1, disconnected: 1, error: 1, binary: 1 }[type])
        _sigOnMessage({ data: JSON.stringify(msg) });
    });
    sig.connect(wsUrl);

    // ── EXPERIMENTAL WEBTRANSPORT CLIENT ──────────────────────────────────────
    const wtRequested = urlParams.get('wt') === '1' || urlParams.get('pipeline') === 'webtransport';
    if (useVps && wtRequested && 'WebTransport' in window) {
      try {
        const wtUrl = `https://${host}:4433/wt`;
        const wt = new WebTransport(wtUrl);
        wt.ready
          .then(() => {
            console.log('[WebTransport] Connected to UDP datagram router.');
            window.wtInputWriter = wt.datagrams.writable.getWriter();
          })
          .catch((e) => console.warn('[WebTransport] Handshake failed, falling back to WS:', e));
        wt.closed
          .then(() => {
            window.wtInputWriter = null;
            console.log('[WebTransport] Session closed.');
          })
          .catch(() => {});
      } catch (e) {
        console.warn('[WebTransport] Setup error:', e);
      }
    }
  }
  stopReconnect = false;

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: 'join',
        viewerId: myId,
        name: myName,
        pin: enteredPin,
        viewerRegion,
        clientVersion: CLIENT_VERSION,
        isDesktopApp: urlParamsGlobal.has('compat'),
      })
    );
    knownNativePads.forEach((pInfo) => ws.send(JSON.stringify(Object.assign({ type: 'gpid' }, pInfo))));
  };

  ws.onmessage = async (e) => {
    // ── BINARY ROUTING ────────────────────────────────────────────────────
    // VPS SFU mode routes both video chunks and PCM audio as ArrayBuffers
    // over the same WebSocket. Distinguish by the 9-byte video header.
    if (e.data instanceof ArrayBuffer) {
      const byteLen = e.data.byteLength;
      if (byteLen > 9) {
        const firstByte = new Uint8Array(e.data, 0, 1)[0];
        // PCM audio shares this socket with no framing of its own, so a chunk
        // whose first sample byte happens to be 0/1 can masquerade as video
        // and poison the decoder. Real capture timestamps are finite,
        // non-negative microseconds — reject anything else as audio.
        let plausibleVideo = false;
        if (firstByte === 0 || firstByte === 1) {
          const ts = new DataView(e.data).getFloat64(1, true);
          plausibleVideo = Number.isFinite(ts) && ts >= 0 && ts < 4e15;
        }
        if (plausibleVideo) {
          // WebCodecs video chunk: [isKey(1)] [timestamp(8)] [payload...]
          // In non-VPS (tunnel-relay) mode the host also sends every frame on
          // the per-viewer DataChannel — when that channel is open, it is the
          // renderer and this WS copy must be ignored or every frame decodes
          // twice.
          const isVpsWs = ws && typeof ws.url === 'string' && ws.url.includes('/vps');
          if (window._wcDcOpen && !isVpsWs) return;

          if (!wcDecoder || wcDecoder.state !== 'configured') return;
          const isKey = firstByte === 1;
          if (window.nsWaitKey) {
            if (!isKey) return;
            window.nsWaitKey = false;
            console.log('[WebCodecs/VPS] Locked onto keyframe.');
          }
          // Stall guard: ~0.5s of queued frames (threshold set per-stream-fps
          // in initWebCodecsViewer) means the decoder is wedged — reset and
          // resync. Smaller backlogs are ordinary jitter and simply drain.
          if (wcDecoder.decodeQueueSize > (window._wcQueueGuard || 70)) {
            if (Date.now() - (window._wcLastStallWarnTs || 0) > 5000) {
              window._wcLastStallWarnTs = Date.now();
              console.warn(
                `[WebCodecs] Decoder stalled (${wcDecoder.decodeQueueSize} queued) — resyncing at next keyframe`
              );
            }
            recoverWebCodecsDecoder();
            return;
          }
          const view = new DataView(e.data);
          const timestamp = view.getFloat64(1, true);
          const chunkData = new Uint8Array(e.data, 9);
          try {
            wcDecoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp, data: chunkData }));
          } catch (err) {
            console.error('[WebCodecs/VPS] Decode error:', err);
            recoverWebCodecsDecoder();
          }
          return;
        }
      }
      // PCM audio — only feed after user gesture has unlocked AudioContext
      if (!sysAudioCtx || sysAudioCtx.state !== 'running') return;
      try {
        let safeLen = byteLen - (byteLen % 2);
        if (!safeLen) return;
        const int16 = new Int16Array(e.data.slice(0, safeLen));
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;
        const buf = sysAudioCtx.createBuffer(1, float32.length, 48000);
        buf.getChannelData(0).set(float32);
        const src = sysAudioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(sysAudioCtx.destination);
        if (nextAudioTime < sysAudioCtx.currentTime) nextAudioTime = sysAudioCtx.currentTime + 0.1;
        src.start(nextAudioTime);
        nextAudioTime += buf.duration;
      } catch (err) {
        console.error('[Audio] Playback error:', err);
      }
      return;
    }
    if (e.data instanceof Blob) return;

    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }

    // webcodecs-config arrives on the main WS in VPS mode (replayed by the
    // Rust router on join). In WebRTC-only mode it arrives on the DataChannel.
    if (msg.type === 'smart-db') {
      smartDb = msg.payload || {};
      window.smartDb = smartDb;
      const frame = document.getElementById('controllerGuideFrame');
      if (frame?.contentWindow) frame.contentWindow.postMessage({ type: 'NEARSEC_SMART_DB', db: smartDb }, '*');
      return;
    }

    if (msg.type === 'webcodecs-config') {
      window.nsWaitKey = true;
      initWebCodecsViewer(msg);
      return;
    }

    // stream-idle: host connected to the VPS relay but not yet capturing.
    // The standby screen only activates when both conditions are true:
    //   1. The viewer is currently on the pin screen (not yet past auth).
    //   2. No host stream is active in this session.
    // If the viewer is already watching, this message is silently ignored.
    if (msg.type === 'stream-idle') {
      const pinScreen = document.getElementById('pinScreen');
      const onPinScreen = pinScreen && !pinScreen.classList.contains('gone');
      if (!onPinScreen || _nsHostConnected) return;
      let sf = document.getElementById('_nsStandbyFrame');
      if (!sf) {
        sf = document.createElement('iframe');
        sf.id = '_nsStandbyFrame';
        sf.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:none;z-index:9000;background:#080808;';
        sf.src = '/standby.html';
        document.body.appendChild(sf);
      } else {
        sf.style.display = 'block';
      }
      showOverlay(false);
      return;
    }

    // stream-active: host started capturing — always dismiss the standby iframe
    if (msg.type === 'stream-active') {
      const sf = document.getElementById('_nsStandbyFrame');
      if (sf) sf.style.display = 'none';
      window.nsWaitKey = true;
      setStatus('Host found, connecting...');
      return;
    }

    if (msg.type === 'host-connected') {
      _nsHostConnected = true;
      if (pc) {
        try {
          pc.close();
        } catch {}
        pc = null;
      }
      const videoEl = document.getElementById('video');
      if (videoEl?.srcObject) {
        videoEl.srcObject.getTracks().forEach((t) => t.stop());
        videoEl.srcObject = null;
      }
      document.getElementById('frameCanvas').style.display = 'none';
      processorRunning = false;
      showOverlay(true);
      setStatus('Host reconnected, waiting for stream...');
      document.getElementById('spinner').style.display = 'block';
      // Display the host's saved name in both the overlay and the topbar pill
      if (msg.hostName) {
        const overlayEl = document.getElementById('sessionHostName');
        if (overlayEl) {
          overlayEl.textContent = 'HOST SESSION — ' + msg.hostName;
          overlayEl.style.display = 'block';
        }
        const topEl = document.getElementById('topHostName');
        const safeHostName = String(msg.hostName).replace(/[<>"'&]/g, '');
        if (topEl)
          topEl.innerHTML =
            (msg.hostRegion ? `<span class="fi fi-${msg.hostRegion.replace(/[^a-z]/gi, '')}"></span> ` : '') +
            safeHostName;
        const pillEl = document.getElementById('hostNamePill');
        if (pillEl) pillEl.style.display = '';
        document.title = 'Nearcade — ' + msg.hostName.replace(/[<>"'&]/g, '');
      }
      // CRITICAL FIX: Do NOT send request-offer unconditionally here.
      // The Host already automatically sends an offer when 'viewer-joined' is received.
      // Sending request-offer causes a duplicate 'viewer-joined' trigger on the Host,
      // which forces the Host to destroy the active RTCPeerConnection and start over,
      // resulting in 'User-Initiated Abort' / DataChannel disconnect loops!
      return;
    }
    if (msg.type === 'tunnel-url') return;

    if (msg.type === 'offer') {
      clearTimeout(_reconnectTimer);
      if (pc) {
        try {
          pc.close();
        } catch {}
        pc = null;
      }
      await createPC();
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        pc._remoteSet = true;

        // Apply receiver codec preferences AFTER remote description is set
        // so transceivers already exist. We prioritize the host's requested codec.
        pc.getTransceivers().forEach((t) => {
          if (t.receiver?.track?.kind === 'video') {
            let preferredMime = null;
            if (msg.codec === 'av1') preferredMime = 'video/AV1';
            else if (msg.codec === 'hevc' || msg.codec === 'h265') preferredMime = 'video/H265';
            else if (msg.codec === 'vp8') preferredMime = 'video/VP8';
            else if (msg.codec === 'vp9') preferredMime = 'video/VP9';
            else if (msg.codec === 'h264') preferredMime = 'video/H264';
            preferReceiverCodec(t, preferredMime);
          }
        });

        for (const c of pc._iceBuf || []) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(c));
          } catch {}
        }
        pc._iceBuf = [];
        const answer = await pc.createAnswer();
        // ── LOW-LATENCY SDP MUNGING (answer side) ──
        let ansSdp = answer.sdp;
        ansSdp = ansSdp.replace(/(a=rtpmap:\d+ opus\/48000\/2)/g, '$1\na=ptime:1\na=maxptime:1');
        await pc.setLocalDescription({ type: answer.type, sdp: ansSdp });
        ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
        // Apply bandwidth profile now that transceivers are negotiated
        _applyBwProfile(pc);
      } catch (err) {
        console.error('[webrtc] offer error:', err.message, '— SDP snippet:', msg.sdp?.sdp?.slice(0, 300));
        try {
          pc.close();
        } catch {}
        pc = null;
        // Retry with a fresh request-offer in case it was a transient failure
        setTimeout(() => {
          if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'request-offer' }));
        }, 2000);
      }
      return;
    }
    if (msg.type === 'ice-host' && msg.candidate) {
      if (!pc) return;
      if (pc._remoteSet) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch {}
      } else {
        pc._iceBuf = pc._iceBuf || [];
        pc._iceBuf.push(msg.candidate);
      }
      return;
    }
    // pin-required is checked via /api/pin-required on load; ignore WebSocket commands.
    if (msg.type === 'pin-rejected' || msg.type === 'kick') {
      stopReconnect = true;
      if (pc) {
        try {
          pc.close();
        } catch {}
        pc = null;
      }
      ws.close(msg.type === 'kick' ? 4003 : 4001, msg.type.toUpperCase());

      if (msg.reason === 'kicked' || msg.type === 'kick') {
        alert('You have been kicked by the Host.');
        try {
          window.close();
        } catch {}
        document.body.innerHTML =
          '<div style="color:white;text-align:center;margin-top:20vh;font-family:sans-serif;"><h2>Disconnected</h2><p>You have been kicked by the host.</p></div>';
      } else {
        document.getElementById('pinScreen').classList.remove('gone');
        document.getElementById('pinErr').textContent = enteredPin ? 'Incorrect PIN.' : 'PIN Required.';
        document.getElementById('pinInput').value = '';
      }
      return;
    }
    if (msg.type === 'auth-ok') {
      vpsConnected = true;
      if (msg.viewer_id) {
        myId = msg.viewer_id;
        sessionStorage.setItem('ns_viewer_id', myId);
      }
      if (msg.pin_required === false && !_autoJoinedVps) {
        _autoJoinedVps = true;
        pinRequired = false;
        document.getElementById('pinScreen')?.classList.add('gone');
        document.getElementById('pinWrap').style.display = 'none';
        // If we get auth-ok, we are already connected; DO NOT call submitPin() again!
      }
      return;
    }
    if (msg.type === 'your-id') {
      document.getElementById('pinScreen').classList.add('gone');
      myId = msg.viewerId;
      sessionStorage.setItem('ns_viewer_id', myId);
      const nameEl = document.querySelector('#talkingMe .talking-name');
      if (nameEl) nameEl.textContent = myName + ' (You)';

      // --> START THE FAST LANE NOW THAT WE KNOW OUR ID <--
      connectInputWS();
      return;
    }
    if (msg.type === 'host-stream-ready') {
      _nsHostConnected = true;
      const sf = document.getElementById('_nsStandbyFrame');
      if (sf) sf.style.display = 'none';
      window.nsWaitKey = true;
      setStatus('Host found, connecting...');
      maybeShowControllerGuide();
      return;
    }

    // ── RUMBLE ────────────────────────────────────────────────────────────
    if (msg.type === 'rumble') {
      if (!clientRumbleEnabled) return;

      const duration = msg.duration || 200;
      const strong = msg.strong ?? 0.5;
      const weak = msg.weak ?? 0.25;

      // 1. Try physical gamepad's vibrationActuator first
      let physicalHandled = false;
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const gp of pads) {
        if (!gp || !gp.vibrationActuator) continue;
        try {
          gp.vibrationActuator.playEffect('dual-rumble', {
            startDelay: 0,
            duration,
            weakMagnitude: weak,
            strongMagnitude: strong,
          });
          physicalHandled = true;
        } catch (e) {
          console.warn('[Rumble] playEffect failed:', e.message);
        }
        break; // Only vibrate the first connected pad
      }

      // 2. Mobile fallback / Browser Gamepad API fallback
      if (!physicalHandled && navigator.vibrate && (strong > 0 || weak > 0)) {
        if (strong >= 0.4) {
          navigator.vibrate(Math.min(duration, 500));
        } else {
          navigator.vibrate(30);
        }
      }

      // 3. Desktop App Native Bypass (bypasses browser whitelists)
      if (window.electronAPI && window.electronAPI.sendNativeRumble) {
        // Send to native Python backend to buzz the controller directly via evdev/XInput
        window.electronAPI.sendNativeRumble(0, strong, weak, duration);
      }

      return;
    }
    if (msg.type === 'host-disconnected' || msg.type === 'host-stream-stopped') {
      _nsHostConnected = false;

      // Capture the exact moment the stream stopped so it doesn't go to black
      _freezeFrameForSwap();

      // Make the native HTML overlay semi-transparent so the frozen game is visible
      const overlay = document.getElementById('overlay');
      if (overlay) overlay.style.backgroundColor = 'rgba(10, 10, 12, 0.75)';

      showOverlay(true);
      setStatus('Host stopped streaming');
      document.getElementById('spinner').style.display = 'block';

      if (pc) {
        pc.close();
        pc = null;
      }
      if (video) video.srcObject = null;
      return;
    }

    if (msg.type === 'session-full') {
      showOverlay(true);
      setStatus(`Session full — ${msg.reason || 'maximum players reached'}`);
      document.getElementById('spinner').style.display = 'none';
      if (pc) {
        pc.close();
        pc = null;
      }
      return;
    }

    if (msg.type === 'session-password-required') {
      // Show the styled pin screen with the session password field
      // instead of the browser's native prompt() dialog.
      const pinScreen = document.getElementById('pinScreen');
      const pinWrap = document.getElementById('pinWrap');
      const pwWrap = document.getElementById('sessionPasswordWrap');
      const pwInput = document.getElementById('sessionPasswordInput');
      const submitBtn = document.querySelector('.pin-submit-btn');
      const errEl = document.getElementById('pinErr');

      if (pinScreen && pwWrap && pwInput) {
        if (pinWrap) pinWrap.style.display = 'none';
        pwWrap.style.display = 'block';
        pinScreen.classList.remove('gone');
        if (errEl) errEl.textContent = 'This session requires a password.';
        if (submitBtn) {
          submitBtn.textContent = 'Enter Session →';
          submitBtn.onclick = () => submitSessionPassword();
        }
        setTimeout(() => pwInput.focus(), 80);
      }

      if (pc) {
        pc.close();
        pc = null;
      }
      return;
    }
    if (msg.type === 'host-not-streaming') {
      showOverlay(true);
      setStatus('Host is not sharing their screen yet...');
      document.getElementById('spinner').style.display = 'none';
      if (pc) {
        pc.close();
        pc = null;
      }
      video.srcObject = null;
      return;
    }
    if (msg.type === 'ctrl-settings') {
      hostMotionEnabled = msg.enableMotion;
      window.hostAllowVR = msg.expDevices && msg.expDevices.some((d) => d.enabled && d.val === 'vr');
      if (typeof maybeShowVRButton === 'function') maybeShowVRButton();

      if (msg.expDevices) {
        const select = document.getElementById('inputModeSelect');
        if (select) {
          const currentVal = select.value || window.currentInputMode;
          let html = '<option value="gamepad">Standard Gamepad</option>';
          const enabledExp = msg.expDevices.filter((d) => d.enabled).map((d) => d.val);
          if (enabledExp.includes('guitar')) html += '<option value="guitar">Guitar Hero Controller</option>';
          if (enabledExp.includes('hotas')) html += '<option value="hotas">Flight Stick / HOTAS / Wheel</option>';
          if (enabledExp.includes('eye')) html += '<option value="eyetracking">Webcam Eye / Head Tracking</option>';
          if (enabledExp.includes('tablet')) html += '<option value="tablet">Drawing Tablet (Stylus)</option>';

          select.innerHTML = html;

          if (Array.from(select.options).some((o) => o.value === currentVal)) {
            select.value = currentVal;
          } else {
            select.value = 'gamepad';
            if (window.updateInputMode) window.updateInputMode('gamepad');
          }
        }
      }

      const hBtn = document.getElementById('hidBtn');
      if (hBtn) hBtn.style.display = hostMotionEnabled ? 'block' : 'none';
      if (msg.touchLayout) {
        const layout = msg.touchLayout;
        const jBase = document.getElementById('jBase');
        const actionBtns = document.getElementById('actionBtns');
        const jBaseRight = document.getElementById('jBaseRight');
        const dpad = document.getElementById('dpad');
        if (jBase && actionBtns && jBaseRight && dpad) {
          if (layout === 'rightstick') {
            jBase.style.display = 'flex';
            actionBtns.style.display = 'none';
            jBaseRight.style.display = 'flex';
            dpad.style.display = 'none';
          } else if (layout === 'dpad') {
            jBase.style.display = 'none';
            actionBtns.style.display = 'flex';
            jBaseRight.style.display = 'none';
            dpad.style.display = 'flex';
          } else if (layout === 'full') {
            jBase.style.display = 'flex';
            actionBtns.style.display = 'flex';
            jBaseRight.style.display = 'flex';
            dpad.style.display = 'flex';
            jBase.style.transform = 'scale(0.7)';
            actionBtns.style.transform = 'scale(0.7)';
            jBaseRight.style.transform = 'scale(0.7)';
            dpad.style.transform = 'scale(0.7)';
          } else {
            jBase.style.display = 'flex';
            actionBtns.style.display = 'flex';
            jBaseRight.style.display = 'none';
            dpad.style.display = 'none';
            jBase.style.transform = '';
            actionBtns.style.transform = '';
            jBaseRight.style.transform = '';
            dpad.style.transform = '';
          }
        }
      }
      return;
    }
    if (msg.type === 'input-state') {
      // hybrid mode = gamepad + kbm both active
      kbEnabled = !!msg.kb || msg.mode === 'hybrid';
      if (!kbEnabled && document.pointerLockElement) document.exitPointerLock();
      const hint = document.getElementById('kbmHint');
      if (hint) hint.style.display = kbEnabled ? 'inline' : 'none';
      return;
    }
    if (msg.type === 'slot-assigned') {
      return;
    } // Slot info not displayed to viewer
    if (msg.type === 'chat') {
      appendChat(msg.from || msg.name, msg.msg, msg.viewerId === myId);
      return;
    }
    if (msg.type === 'host-voice-cmd' && msg.targetViewerId === myId) {
      if (msg.action === 'mute') {
        forceMutedByHost = true;
        disableMic();
        updateMicButton();
        appendChat('Nearcade', 'The host has muted your microphone.', false);
      } else {
        forceMutedByHost = false;
        updateMicButton();
        appendChat('Nearcade', 'The host unmuted you.', false);
      }
      return;
    }
    // Stub: handle server-sent VAD feed
    if (msg.type === 'voice-activity') {
      updateTalkingOverlay(msg.activeSpeakers || []);
      return;
    }
    if (msg.type === 'roster') {
      const listEl = document.getElementById('lobbyList');
      if (listEl) {
        listEl.innerHTML = '';
        const seen = new Set();
        let hostAdded = false;
        msg.viewers.forEach((v) => {
          const baseId = v.id.split('_')[0];
          if (!seen.has(baseId)) {
            seen.add(baseId);
            if (!hostAdded) {
              const hostItem = document.createElement('div');
              hostItem.className = 'roster-item';
              hostItem.innerHTML = '<span> Host</span><span class="roster-badge">Streaming</span>';
              listEl.appendChild(hostItem);
              hostAdded = true;
            }
            const isMe = baseId === myId;
            // textContent (upstream v3.0.2): viewer names must never be markup
            const viewerItem = document.createElement('div');
            viewerItem.className = 'roster-item' + (isMe ? ' roster-me' : '');
            viewerItem.textContent = (v.name || '').replace(/ \d+$/, '') + (isMe ? ' (You)' : '');
            listEl.appendChild(viewerItem);
          }
        });
      }
      return;
    }
  };

  ws.onclose = (function (thisWs) {
    return function (event) {
      // If this socket is no longer the active one (connect() already replaced it),
      // do NOT schedule another reconnect — that's what causes the cascade loop.
      if (ws !== thisWs) return;

      const AUTH_CODES = new Set([4001, 4002, 4003, 4004]);
      if (AUTH_CODES.has(event.code) || stopReconnect) {
        if (event.code === 4004) {
          // Wrong session password — show the password input, not the PIN screen
          const pwScreen = document.getElementById('passwordScreen');
          const pwErr = document.getElementById('passwordErr');
          if (pwScreen) pwScreen.classList.remove('gone');
          if (pwErr) pwErr.textContent = 'Incorrect session password.';
        } else {
          document.getElementById('pinScreen').classList.remove('gone');
          const errEl = document.getElementById('pinErr');
          if (errEl)
            errEl.textContent =
              event.code === 4003
                ? 'You were kicked by the host.'
                : event.code === 4001
                  ? 'Too many attempts. Wait 2 minutes.'
                  : 'Incorrect PIN.';
          document.getElementById('pinInput').value = '';
        }
        enteredPin = '';
        enteredPassword = '';
        stopReconnect = false;
        return;
      }
      setTimeout(connect, 2000);
    };
  })(ws);
}

// pinRequired is declared early at the top of the file.
// For local (non-VPS) servers, check the HTTP API on load.
(function checkLocalPinRequirement() {
  const urlParams = new URLSearchParams(window.location.search);
  const useVps = location.hostname === 'publicnearcade.cutefame.net' || urlParams.has('v3') || urlParams.has('vps');
  if (!useVps) {
    safeApiJson('/api/pin-required', { required: true }).then((d) => {
      pinRequired = d.required !== false;
      if (!pinRequired) {
        const wrap = document.getElementById('pinWrap');
        if (wrap) wrap.style.display = 'none';
      }
    });
  }
  // VPS pin state is handled by the early standby WebSocket at the top of this file.
})();

function submitPin() {
  const nameVal = document.getElementById('nameInput').value.trim();
  if (nameVal) {
    myName = nameVal;
    localStorage.setItem('ns_name', myName);
  }
  const val = document.getElementById('pinInput').value.trim();
  if (pinRequired && val.length === 0) {
    document.getElementById('pinErr').textContent = 'PIN / Password required';
    return;
  }
  enteredPin = val;
  document.getElementById('pinErr').textContent = '';
  document.getElementById('pinScreen').classList.add('gone');
  safeApiJson('/api/info', {})
    .then((d) => {
      if (d.version) {
        const vA = String(CLIENT_VERSION).split('.')[0];
        const vB = String(d.version).split('.')[0];
        if (vA !== vB) {
          alert(`Version mismatch: Host v${d.version}, You v${CLIENT_VERSION}. Please update to match.`);
        }
      }
    })
    .finally(() => {
      connect();
      if (!gpPolling) activateGamepad();
    });
}

function submitSessionPassword() {
  const pwInput = document.getElementById('sessionPasswordInput');
  const errEl = document.getElementById('pinErr');
  const pw = (pwInput?.value || '').trim();
  if (!pw) {
    if (errEl) errEl.textContent = 'Password cannot be empty.';
    return;
  }

  // Restore pin screen state for next time
  const pinWrap = document.getElementById('pinWrap');
  const pwWrap = document.getElementById('sessionPasswordWrap');
  const submitBtn = document.querySelector('.pin-submit-btn');
  if (pinWrap) pinWrap.style.display = '';
  if (pwWrap) pwWrap.style.display = 'none';
  if (submitBtn) {
    submitBtn.textContent = 'Join Stream →';
    submitBtn.onclick = () => submitPin();
  }
  if (errEl) errEl.textContent = '';
  document.getElementById('pinScreen')?.classList.add('gone');

  // Reconnect with password
  enteredPassword = pw;
  setTimeout(connect, 200);
}

// ── CHAT ──────────────────────────────────────────────────────────────────────
// Suppresses an identical own message repeated within 1s — see chat.js's
// chatAppendMessage() for what this dedupState box does.
const _chatDedup = { msg: '', time: 0, windowMs: 1000 };
function appendChat(name, text, isMe) {
  chatAppendMessage(name, text, isMe, _chatDedup);
}
function sendChat() {
  chatSendMessage(ws, myName, _chatDedup);
}
function toggleChat() {
  document.getElementById('chatPanel').classList.toggle('open');
  document.getElementById('nsBar').classList.remove('open');
}
function toggleAudio() {
  audioMuted = !audioMuted;
  if (video.srcObject) video.srcObject.getAudioTracks().forEach((t) => (t.enabled = !audioMuted));
  const audioEl = document.getElementById('remote-audio');
  if (audioEl && audioEl.srcObject) audioEl.srcObject.getAudioTracks().forEach((t) => (t.enabled = !audioMuted));
  const btn = document.getElementById('audBtn');
  if (btn) {
    btn.textContent = audioMuted ? 'Stream Audio: OFF' : 'Stream Audio';
    btn.classList.toggle('ns-btn-danger', audioMuted);
    btn.classList.toggle('ns-btn-active', !audioMuted);
  }
}

// ── WAKE LOCK ─────────────────────────────────────────────────────────────────
let wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      if (document.visibilityState === 'visible') acquireWakeLock();
    });
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquireWakeLock();
});
acquireWakeLock();

// ── LOW-LATENCY ENFORCEMENT: Proactive buffer drain ──
// Runs every 500ms. Uses jitterBufferTarget + playoutDelayHint to force the
// browser's WebRTC stack to minimize the jitter buffer. playbackRate acts as
// a secondary mechanism when the browser ignores the hints.
// Threshold for proactively requesting a keyframe as the jitter buffer grows —
// lower than it sounds worth waiting out, since a keyframe is cheap next to
// the stall a viewer would otherwise ride out. See webcodecs-encoder.js's
// KEYFRAME_INTERVAL_MS for the host-side forced-keyframe cadence this backs up.
const CONGESTION_KEYFRAME_THRESHOLD_MS = 20; // was 40
let _prevJitterBufMs = 0;
setInterval(async () => {
  if (!pc || pc.connectionState !== 'connected') return;
  // Force minimum jitter buffer on all video receivers
  pc.getReceivers().forEach((r) => {
    if (r.track?.kind !== 'video') return;
    try {
      if ('playoutDelayHint' in r) r.playoutDelayHint = 0;
      if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0;
    } catch (_) {}
  });
  // Measure buffer and adjust playback rate as secondary drain mechanism
  try {
    const stats = await pc.getStats();
    for (const r of stats.values()) {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        const emitted = r.jitterBufferEmittedCount || 1;
        const delay = r.jitterBufferDelay || 0;
        const bufMs = (delay / emitted) * 1000;
        const videoEl = document.getElementById('video');
        if (videoEl && !videoEl.paused) {
          if (bufMs < 5) videoEl.playbackRate = 1.0;
          else if (bufMs < 15) videoEl.playbackRate = 1.02;
          else if (bufMs < 30) videoEl.playbackRate = 1.08;
          else if (bufMs < 50) videoEl.playbackRate = 1.15;
          else videoEl.playbackRate = 1.5;
        }
        if (bufMs > CONGESTION_KEYFRAME_THRESHOLD_MS && bufMs > _prevJitterBufMs + 5) {
          requestKeyframeFromHost();
        }
        _prevJitterBufMs = bufMs;
      }
    }
  } catch (_) {}
}, 500);

// ── VIEWER-SIDE CURSOR PREDICTION ─────────────────────────────────────────────
// Purely a local visual aid: draws a dot that tracks raw mouse movement
// instantly, so KBM viewers get feedback during pointer lock (where the real
// OS cursor is hidden) instead of only seeing motion once the round trip
// through host input processing and back over video lands. This does not
// touch the real input path — gamepad.js's own pointerLockElement-gated
// mousemove listener still sends the actual KBM events; this only draws.
let _cursorPredict = { x: 0, y: 0, active: false };
function initCursorPrediction() {
  const overlay = document.createElement('div');
  overlay.id = 'cursor-predict';
  overlay.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;pointer-events:none;display:none;';
  document.body.appendChild(overlay);
  const dot = document.createElement('div');
  dot.style.cssText =
    'position:absolute;width:20px;height:20px;border:2px solid rgba(255,255,255,0.8);border-radius:50%;transform:translate(-50%,-50%);background:rgba(255,255,255,0.15);';
  overlay.appendChild(dot);

  document.addEventListener('mousemove', (e) => {
    if (!_cursorPredict.active) return;
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    _cursorPredict.x += dx;
    _cursorPredict.y += dy;
    dot.style.left = _cursorPredict.x + 'px';
    dot.style.top = _cursorPredict.y + 'px';
  });

  // Re-center and toggle visibility with pointer lock — this fork gates KBM
  // mode on document.pointerLockElement (see input/gamepad.js), not a CSS
  // class, so that's what drives activation here too.
  document.addEventListener('pointerlockchange', () => {
    const active = !!document.pointerLockElement;
    _cursorPredict.active = active;
    if (active) {
      _cursorPredict.x = window.innerWidth / 2;
      _cursorPredict.y = window.innerHeight / 2;
      dot.style.left = _cursorPredict.x + 'px';
      dot.style.top = _cursorPredict.y + 'px';
    }
    overlay.style.display = active ? 'block' : 'none';
  });
}
document.addEventListener('DOMContentLoaded', initCursorPrediction);

// ── FULLSCREEN ────────────────────────────────────────────────────────────────
function landscape() {
  if (screen.orientation?.lock) screen.orientation.lock('landscape').catch(() => {});
}
function toggleFS() {
  if (!document.fullscreenElement) {
    document.documentElement
      .requestFullscreen()
      .then(landscape)
      .catch(() => {});
  } else {
    document.exitFullscreen();
  }
}
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) landscape();
  const btn = document.getElementById('fsBtn');
  if (btn) {
    btn.textContent = document.fullscreenElement ? 'Exit Full Screen' : 'Full Screen';
    btn.classList.toggle('ns-btn-active', !!document.fullscreenElement);
  }
});

// ── RUMBLE ────────────────────────────────────────────────────────────────────
let clientRumbleEnabled = localStorage.getItem('ns_rumble') !== 'false';
function toggleClientRumble() {
  clientRumbleEnabled = !clientRumbleEnabled;
  localStorage.setItem('ns_rumble', clientRumbleEnabled);
  const btn = document.getElementById('rumbleBtn');
  if (btn) {
    btn.textContent = `Rumble: ${clientRumbleEnabled ? 'ON' : 'OFF'}`;
    btn.classList.toggle('ns-btn-active', clientRumbleEnabled);
  }
}
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('rumbleBtn');
  if (btn) {
    btn.textContent = `Rumble: ${clientRumbleEnabled ? 'ON' : 'OFF'}`;
    btn.classList.toggle('ns-btn-active', clientRumbleEnabled);
  }
});

// ── STEAM DECK / IMMERSIVE AUTO-DETECT ───────────────────────────────────────
(function detectSteamDeck() {
  const ua = navigator.userAgent;
  const params = new URLSearchParams(location.search);
  const isSteamDeck =
    ua.includes('SteamGamepadUI') ||
    ua.includes('Steam') ||
    params.get('deck') === '1' ||
    (navigator.platform === 'Linux x86_64' &&
      navigator.maxTouchPoints > 0 &&
      screen.width === 1280 &&
      screen.height === 800);

  if (isSteamDeck) {
    console.log('[Nearcade] Steam Deck detected — auto-entering immersive mode');
    document.documentElement
      .requestFullscreen()
      .then(landscape)
      .catch(() => {});
    const immBtn = document.getElementById('immersiveBtn');
    if (immBtn) immBtn.style.display = 'none';
  }
})();

// ── SIDE BAR FADE ─────────────────────────────────────────────────────────────
(function () {
  const fsBtn = document.getElementById('fsOverlayBtn');
  if (!fsBtn) return;
  let hideTimer = null,
    lastX = 0,
    lastY = 0;
  function showBtn() {
    fsBtn.style.opacity = '1';
    fsBtn.style.pointerEvents = 'auto';
    document.body.style.cursor = '';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      fsBtn.style.opacity = '0';
      fsBtn.style.pointerEvents = 'none';
      document.body.style.cursor = 'none';
    }, 2700);
  }
  document.addEventListener(
    'mousemove',
    (e) => {
      const dx = e.clientX - lastX,
        dy = e.clientY - lastY;
      if (Math.sqrt(dx * dx + dy * dy) < 14) return;
      lastX = e.clientX;
      lastY = e.clientY;
      showBtn();
    },
    { passive: true }
  );
  showBtn();
})();

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. It exists purely so Vitest (Node) can import
// these functions directly instead of re-parsing the whole file. See
// REFACTOR_PLAN.md Phase 0 / test/unit/chat.test.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { log, appendChat, sendChat, preferReceiverCodec };
}
