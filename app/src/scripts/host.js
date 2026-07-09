const proto = location.protocol === 'https:' ? 'wss' : 'ws';
let ws,
  currentStream,
  peerConnections = {},
  knownViewers = new Set(),
  vrActiveViewers = new Set(),
  viewerCount = 0;
let pinEnabled = true,
  currentPin = '----';
let kbmPanicActive = false;
const viewerAudioStates = {}; // Tracks { volume: 100, state: 0 } per viewer

// Nulls onicecandidate/onconnectionstatechange before closing a peer connection.
// Required whenever a successor connection for the same viewer ID may be created
// right after (sendOfferToViewer, startCapture's bulk re-offer) — otherwise a
// late-firing event from the closing connection can still fire against the new
// one's viewer ID. Sites that don't immediately recreate a connection for the
// same viewer (viewer-left, stopCapture) don't strictly need this, but use it
// too for consistency. See REFACTOR_PLAN.md Phase 5.2 follow-up.
function closePeerConnection(pc) {
  if (!pc) return;
  try {
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();
  } catch {}
}

// ── HOISTED CONFIG — declared here to prevent TDZ ReferenceErrors ─────────────
// These are `const`/`let` — not hoisted like `var`. Any onclick or early function
// that runs before the bottom of the file would throw "Cannot access before init".
const ctrlSettings = {
  forceXboxOne: localStorage.getItem('ns_ctrl_forceXboxOne') === 'true',
  enableDualShock: localStorage.getItem('ns_ctrl_enableDualShock') === 'true',
  enableMotion: localStorage.getItem('ns_ctrl_enableMotion') === 'true',
  defaultInputMode: localStorage.getItem('ns_ctrl_defaultInputMode') || 'gamepad',
  hybridInput: localStorage.getItem('ns_ctrl_hybridInput') === 'true',
  ctrlType: localStorage.getItem('ns_ctrl_ctrlType') || 'xbox360',
  touchLayout: localStorage.getItem('ns_ctrl_touchLayout') || 'default',
};

const appSettings = {
  tray: localStorage.getItem('ns_app_tray') !== 'false',
  alwaysOnTop: localStorage.getItem('ns_app_alwaysOnTop') === 'true',
  hidePreviewOnStart: localStorage.getItem('ns_app_hidePreview') === 'true',
  captureMic: localStorage.getItem('ns_app_captureMic') === 'true',
};
let selectedMicDeviceId = localStorage.getItem('ns_audio_input') || 'default';
let selectedOutputDeviceId = localStorage.getItem('ns_audio_output') || 'default';

let previewHidden = false;

// ── PPS (Packets-Per-Second) flood protection ─────────────────────────────────
// Tracks input message counts per viewer. If any viewer exceeds 300 msgs/sec
// they are immediately disconnected.
const _ppsCount = {}; // viewerId → count in current window
const _ppsWindow = {}; // viewerId → window start timestamp (ms)
const PPS_LIMIT = 300;
const PPS_WINDOW = 1000; // ms

function _checkPps(viewerId) {
  const now = Date.now();
  if (!_ppsWindow[viewerId] || now - _ppsWindow[viewerId] >= PPS_WINDOW) {
    _ppsWindow[viewerId] = now;
    _ppsCount[viewerId] = 1;
    return true;
  }
  _ppsCount[viewerId]++;
  if (_ppsCount[viewerId] > PPS_LIMIT) {
    console.warn(`[PPS] Viewer ${viewerId} exceeded ${PPS_LIMIT} inputs/sec — disconnecting`);
    log(`Flood protection: kicked ${viewerId} (>${PPS_LIMIT} pps)`, 'warn');
    // Tell the server to sever this viewer's connection
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'kick-viewer', viewerId, reason: 'pps_flood' }));
    }
    delete _ppsCount[viewerId];
    delete _ppsWindow[viewerId];
    return false;
  }
  return true;
}

// ── VPS SFU connection state ──────────────────────────────────────────────────
let _vpsWs = null;
let _vpsConfig = null; // { vpsEnabled, vpsUrl, vpsMasterKey }
let _vpsAuthOk = false;
let _smartDb = {};
let _viewerRegions = {};
let _pendingVpsViewers = new Map();
let hostRegion = '';
let _turnCredentials = null;

// Fetch secure TURN credentials from local server on boot
let _turnFetchPromise = fetch('/api/turn')
  .then((r) => r.json())
  .then((c) => {
    if (!c.error && c.urls) _turnCredentials = c;
    return c;
  })
  .catch(() => null);
// ─────────────────────────────────────────────────────────────────────────────

async function loadAppConfig() {
  if (window.electronAPI?.getSettings) return window.electronAPI.getSettings();
  try {
    const r = await fetch('/api/config');
    return await r.json();
  } catch (_) {
    return {};
  }
}

async function saveAppConfig(patch) {
  if (window.electronAPI?.saveSettings) {
    await window.electronAPI.saveSettings(patch);
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => {});
    return;
  }
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

// Helper to save a setting to BOTH localStorage AND config file
async function saveSetting(localStorageKey, value, configKey) {
  if (!configKey) configKey = localStorageKey;
  localStorage.setItem(localStorageKey, value);
  saveAppConfig({ [configKey]: value });
}

function forceWebCodecsKeyframe() {
  if (_wcEncoder && _wcEncoder.state === 'configured') _wcForceKeyframe = true;
}

fetch('https://get.geojs.io/v1/ip/country.json')
  .then((r) => r.json())
  .then((d) => {
    hostRegion = String(d.country || '')
      .toLowerCase()
      .slice(0, 2);
  })
  .catch(() => {});

if (window.electronAPI?.getControllers) {
  window.electronAPI
    .getControllers()
    .then((db) => {
      _smartDb = db || {};
    })
    .catch(() => {});
}

// ── NULL-SAFE DOM HELPERS ─────────────────────────────────────────────────────
// Prevents TypeError crashes when an element ID is missing after a layout refactor.
function _elDisabled(id, val) {
  const e = document.getElementById(id);
  if (e) e.disabled = val;
}
function _elText(id, val) {
  const e = document.getElementById(id);
  if (e) e.textContent = val;
}
function _elClass(id, cls, add) {
  const e = document.getElementById(id);
  if (e) e.classList[add ? 'add' : 'remove'](cls);
}
// ─────────────────────────────────────────────────────────────────────────────

let audioSettings = {
  forceAudioEnabled: localStorage.getItem('ns_force_audio_enabled') !== 'false',
  defaultDevice: localStorage.getItem('ns_audio_device') || 'default',
};

// ─────────────────────────────────────────────────────────────────────────────

function toggleStreamState() {
  const btn = document.getElementById('btnStartStop');
  const iconPath = document.getElementById('iconPath');

  if (!currentStream) {
    // We are currently stopped, so we want to START
    showSourceSelectionModal();
    // Note: startCapture() is called after modal confirms
  } else {
    // We are currently live, so we want to STOP
    stopCapture();

    // Update UI to "Start" state
    btn.classList.remove('danger-btn');
    iconPath.setAttribute('d', 'M5 3l14 9-14 9V3z'); // Play Icon
    log(I18N.t('Session stopped by user'), 'ok');
  }
}

(function detectIGPU() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return;
    const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL).toLowerCase();
    const isIGPU =
      /intel|iris|uhd|vega|radeon.*graphics|rdna.*u|apu|780m|680m|graphics \d+/.test(renderer) &&
      !/rtx|gtx|rx \d{3,4}|arc a\d/.test(renderer);
    if (isIGPU && !localStorage.getItem('ns_codec')) {
      document.getElementById('codecSelect').value = 'H264';
      localStorage.setItem('ns_codec', 'H264');
      console.log('[codec] iGPU detected (' + renderer + ') — defaulting to H264');
    }
  } catch (e) {}
})();

async function fetchGameThumbnail(gameTitle) {
  try {
    const res = await fetch(`https://nearsec.cutefame.net/api/game-art?title=${encodeURIComponent(gameTitle)}`);
    const data = await res.json();
    return data.thumbnail || '';
  } catch (e) {
    console.warn('Could not fetch official thumbnail:', e);
    return '';
  }
}

function preferVideoCodec(pc) {
  // setCodecPreferences STRICTLY requires codec objects returned by RTCRtpReceiver.getCapabilities.
  // We cannot use RTCRtpSender.getCapabilities here or the browser will throw "Invalid codec preferences".
  const caps = RTCRtpReceiver.getCapabilities?.('video');
  if (!caps || !caps.codecs) return null;
  const val = document.getElementById('codecSelect').value;

  // Match mimeType exactly as WebRTC defines it (case-insensitive)
  const targetMime = 'video/' + (val === 'H265' ? 'hevc' : val).toLowerCase();
  const fallbackMime = val === 'H265' ? 'video/h265' : targetMime;

  let codecs = [...caps.codecs];

  // H264 profile fix for Windows AMD/MediaFoundation decoder bugs, and
  // WebRTC's requirement that RTX/RED codecs stay adjacent to their base
  // codec, both live in extractPreferredCodec() now (shared with viewer.js's
  // preferReceiverCodec — see scripts/webrtc/codec-negotiation.js).
  const preferred = extractPreferredCodec(codecs, [targetMime, fallbackMime]);

  // Fallback to browser default if hardware is missing
  if (preferred.length === 0) return null;

  const sorted = [...preferred, ...codecs];

  let used = null;
  pc.getTransceivers().forEach((t) => {
    if (t.sender?.track?.kind === 'video') {
      try {
        t.setCodecPreferences(sorted);
        used = sorted[0]?.mimeType || null;
      } catch (e) {
        console.warn('[WebRTC] Codec preference rejected:', e.message);
      }
    }
  });
  return used;
}

function log(msg, cls) {
  const el = document.getElementById('log');
  const d = document.createElement('div');
  d.className = 'll' + (cls ? ' ' + cls : '');

  const timeSpan = document.createElement('span');
  timeSpan.style.opacity = '0.5';
  timeSpan.style.marginRight = '6px';
  timeSpan.textContent = '[' + new Date().toLocaleTimeString() + ']';
  d.appendChild(timeSpan);

  const textNode = document.createTextNode(I18N.t(msg));
  d.appendChild(textNode);

  if (el) {
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }
  const mini = document.getElementById('lastLogLine');
  if (mini) {
    mini.textContent = I18N.t(msg);
    mini.style.color =
      cls === 'ok' ? 'var(--accent)' : cls === 'err' ? 'var(--danger)' : cls === 'warn' ? 'var(--warn)' : '#333';
  }
}

function appendChat(name, text, isMe) {
  chatAppendMessage(name, text, isMe, null);
}

function sendChat() {
  chatSendMessage(ws, 'Host', null);
}

function setCapDot(state) {
  const d = document.getElementById('capDot');
  const s = document.getElementById('capStatus');
  if (d) d.className = 'dot' + (state === 'live' ? ' live' : state === 'err' ? ' err' : '');
  if (s) s.textContent = state === 'live' ? 'Live' : state === 'err' ? 'Error' : 'Idle';
}

function setAudDot(state, label) {
  const d = document.getElementById('audDot');
  const s = document.getElementById('audStatus');
  if (d) d.className = 'dot' + (state === 'live' ? ' live' : state === 'warn' ? ' warn' : '');
  if (s) s.textContent = label;
}

// ── V3 UI UPDATE ──
async function renderUrls(d) {
  // 1. Fetch the REAL host name and tunnel provider from your backend config FIRST
  let hostName = 'A player';
  let isPortForward = false;
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    if (cfg && cfg.hostName) hostName = cfg.hostName;
    if (cfg && cfg.tunnelProvider === 'portforward') isPortForward = true;
  } catch (e) {}

  const encodedName = encodeURIComponent(hostName);

  // 2. Append it to the tunnel URL
  let finalTunnelUrl = null;
  if (d.tunnelUrl) {
    const separator = d.tunnelUrl.includes('?') ? '&' : '?';
    const pSelect = document.getElementById('pipelineSelect');
    const pipeArg =
      pSelect && pSelect.value === 'custom_webcodecs'
        ? '&wc=2'
        : pSelect && pSelect.value === 'webcodecs'
          ? '&wc=1'
          : pSelect && pSelect.value === 'webtransport'
            ? '&wt=1'
            : '';
    finalTunnelUrl = `${d.tunnelUrl}${separator}host=${encodedName}${pipeArg}`;
  }
  window._globalTunnelUrl = finalTunnelUrl;

  const pSelect = document.getElementById('pipelineSelect');
  const pipeArg =
    pSelect && pSelect.value === 'custom_webcodecs'
      ? '&wc=2'
      : pSelect && pSelect.value === 'webcodecs'
        ? '&wc=1'
        : pSelect && pSelect.value === 'webtransport'
          ? '&wt=1'
          : '';

  const rows = [];

  // Check if we are running in P2P mode!
  if (window._isP2P && window._p2pCode) {
    rows.push({ url: window._p2pCode, label: 'P2P ROOM CODE', color: 'var(--accent2)' });
  } else if (finalTunnelUrl) {
    rows.push({ url: finalTunnelUrl, label: 'HTTPS tunnel (v3) ← share this', color: 'var(--accent)' });
  } else if (!isPortForward) {
    rows.push({ url: 'Waiting for tunnel...', label: 'tunnel starting up', color: '#444', noclick: true });
  }

  if (!window._isP2P) {
    rows.push({
      url: `http://${d.lanIP}:${d.port}/?v3&host=${encodedName}${pipeArg}`,
      label: 'LAN (v3) — same network only',
      color: '#555',
    });
  }

  if (!finalTunnelUrl && d.publicIP)
    rows.splice(1, 0, {
      url: `http://${d.publicIP}:${d.port}/?v3&host=${encodedName}${pipeArg}`,
      label: 'Public IP (v3) (needs port forward)',
      color: '#666',
    });

  // 3. NOW clear the HTML and append (prevents the async duplication bug)
  const el = document.getElementById('urlList');
  if (el) {
    el.innerHTML = '';
    rows.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'url-row';
      div.style.color = r.color;
      div.textContent = r.url;
      if (!r.noclick)
        div.onclick = () => {
          navigator.clipboard.writeText(r.url).catch(() => {});
          const tmp = div.textContent;
          div.textContent = '✓ copied!';
          setTimeout(() => (div.textContent = tmp), 1500);
        };
      const sub = document.createElement('div');
      sub.className = 'url-label';
      sub.textContent = '↑ ' + r.label;
      el.appendChild(div);
      el.appendChild(sub);
    });
  }

  // Always show LAN IP as a secondary row — useful even in VPS mode for local testing
  if (d.lanIP) {
    const lanUrl = `http://${d.lanIP}:${d.port}/?v3&host=${encodedName}`;
    const existing = [...(el?.querySelectorAll('.url-row') || [])].find((e) => e.textContent.includes(d.lanIP));
    if (!existing && el) {
      const lanDiv = document.createElement('div');
      lanDiv.className = 'url-row';
      lanDiv.style.color = '#555';
      lanDiv.textContent = lanUrl;
      lanDiv.onclick = () => {
        navigator.clipboard.writeText(lanUrl).catch(() => {});
        const tmp = lanDiv.textContent;
        lanDiv.textContent = 'copied!';
        setTimeout(() => {
          lanDiv.textContent = tmp;
        }, 1500);
      };
      const lanSub = document.createElement('div');
      lanSub.className = 'url-label';
      lanSub.textContent = 'LAN (v3) — same network only';
      el.appendChild(lanDiv);
      el.appendChild(lanSub);
    }
  }
}

function togglePin() {
  if (arcadePingInterval) {
    log(I18N.t('Cannot change PIN during active Arcade session'), 'warn');
    return;
  }
  pinEnabled = !pinEnabled;
  const btn = document.getElementById('pinToggle');
  if (btn) {
    btn.textContent = pinEnabled ? 'ON' : 'OFF';
    btn.classList.toggle('on', pinEnabled);
  }
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'set-pin', enabled: pinEnabled }));
  if (_vpsWs && _vpsWs.readyState === 1) _vpsWs.send(JSON.stringify({ type: 'set-pin', enabled: pinEnabled }));
}

function regeneratePin() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'regen-pin' }));
    log(I18N.t('Requesting new PIN...'), 'ok');
  }
}

function savePersistentPassword(val) {
  const password = (val || '').trim();
  fetch('/api/set-session-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: password }),
  })
    .then((r) => r.json())
    .then((cfg) => {
      log(
        password ? 'Persistent password saved! Replaces PIN.' : 'Persistent password cleared. Using random PINs.',
        'ok'
      );
    })
    .catch((err) => {
      log('Failed to save password: ' + err.message, 'err');
    });
}

function connectWS() {
  ws = new WebSocket(proto + '://' + location.host + '/ws/host');
  ws.onopen = () => {
    log(I18N.t('Connected to server'), 'ok');

    // Single fetch for both hostName display and info — avoids two hits on connect
    fetch('/api/config')
      .then((r) => r.json())
      .then((cfg) => {
        const hostNameEl = document.getElementById('displayHostName');
        if (hostNameEl) hostNameEl.textContent = cfg.hostName || 'Guest';

        const passInput = document.getElementById('persistentPasswordInput');
        if (passInput && cfg.persistentPassword) {
          passInput.value = cfg.persistentPassword;
        }
      });

    fetch('/api/info')
      .then((r) => r.json())
      .then((d) => {
        currentPin = d.pin;
        if (!window._isP2P) {
          const pVal = document.getElementById('pinVal');
          if (pVal) pVal.textContent = d.pin;
        }
        renderUrls(d);
        ws.send(JSON.stringify({ type: 'sync-pin', pin: currentPin, enabled: pinEnabled }));
        sendCtrlSettings();
      });
    checkTunnelOnConnect();
  };
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'request-keyframe') {
      forceWebCodecsKeyframe();
      const vid = msg.viewerId || msg._viewerId;
      if (vid && _lastWcConfig) {
        if (
          peerConnections[vid] &&
          peerConnections[vid].wcChannel &&
          peerConnections[vid].wcChannel.readyState === 'open'
        ) {
          try {
            peerConnections[vid].wcChannel.send(_lastWcConfig);
          } catch (_) {}
        }
      }
      return;
    }
    if (msg.type === 'viewer-joined') {
      const isNew = !knownViewers.has(msg.viewerId);
      knownViewers.add(msg.viewerId);
      if (msg.viewerRegion) _viewerRegions[msg.viewerId] = String(msg.viewerRegion).toLowerCase().slice(0, 2);
      if (isNew) {
        log(I18N.t('Viewer') + ' ' + (msg.name || msg.viewerId) + ' joined', 'ok');
      } else {
        log(I18N.t('Viewer') + ' ' + (msg.name || msg.viewerId) + ' re-offer requested', 'ok');
      }

      // Desktop App users are auto-assigned KBM Emulated so Steam controllers work flawlessly
      if (msg.isDesktopApp && msg.name && !msg.name.startsWith('Guest') && !savedViewerModes[msg.name]) {
        setTimeout(() => changeInputMode(msg.viewerId, 'kbm_emulated', msg.name), 200);
      } else if (msg.isDesktopApp && msg.name && msg.name.startsWith('Guest')) {
        // If they didn't set a name, we can't save it to savedViewerModes, but we still apply it
        setTimeout(() => changeInputMode(msg.viewerId, 'kbm_emulated'), 200);
      }
      if (currentStream) {
        await sendOfferToViewer(msg.viewerId);
      } else {
        ws.send(JSON.stringify({ type: 'host-not-streaming', viewerId: msg.viewerId }));
      }
    }
    if (msg.type === 'viewer-left') {
      knownViewers.delete(msg.viewerId);
      delete _viewerRegions[msg.viewerId];
      if (peerConnections[msg.viewerId]) {
        closePeerConnection(peerConnections[msg.viewerId]);
        delete peerConnections[msg.viewerId];
      }
      log(I18N.t('Viewer') + ' ' + (msg.name || msg.viewerId) + ' left');
    }
    if (msg.type === 'roster') {
      _lastRosterList = msg.viewers || [];
      renderRoster(_lastRosterList);
      // Keep viewer panel in sync
      window._rosterData = _lastRosterList;
      const panel = document.getElementById('viewerPanel');
      if (panel && !panel.classList.contains('gone') && typeof _refreshViewerPanel === 'function')
        _refreshViewerPanel();
      const vc = document.getElementById('viewerCount');
      if (vc) vc.textContent = msg.controllerCount ?? msg.viewers.length;
    }
    if (msg.type === 'answer') {
      const pc = peerConnections[msg._viewerId];
      if (pc) {
        if (pc.signalingState !== 'have-local-offer') {
          console.log(`[webrtc] Stale answer dropped. State is: ${pc.signalingState}`);
          return;
        }
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          // Seamless Renegotiation Hack: When swapping codecs mid-stream,
          // the decoder stalls waiting for the next IDR frame (which can take 5-10s).
          // Triggering a track replacement immediately after applying the answer
          // flushes the Chromium encoder and resumes the stream instantly.
          setTimeout(() => {
            if (pc.connectionState === 'connected') {
              const videoSender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
              if (videoSender && videoSender.track) {
                videoSender.replaceTrack(videoSender.track).catch(() => {});
              }
            }
          }, 150);
        } catch (e) {
          log(I18N.t('answer err:') + ' ' + e.message, 'err');
        }
      }
    }
    if (msg.type === 'ice-viewer') {
      const pc = peerConnections[msg._viewerId];
      if (pc && msg.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch {}
      }
    }

    // NEW: Intercept viewer mic trigger
    if (msg.type === 'viewer-mic-ready') {
      log(I18N.t('Viewer') + ' ' + msg._viewerId + ' enabled microphone. Re-syncing tracks...', 'ok');
      sendOfferToViewer(msg._viewerId);
    }

    if (msg.type === 'viewer-vr-active') {
      vrActiveViewers.add(msg._viewerId || msg.viewerId);
      if (_lastRosterList) renderRoster(_lastRosterList);
      log(`Viewer ${msg._viewerId || msg.viewerId} entered VR mode`, 'ok');
      return;
    }

    if (msg.type === 'tunnel-url') {
      // In VPS SFU mode the tunnel URL is irrelevant — the custom domain
      // is already displayed. Swallowing this message prevents the Cloudflare
      // URL from overwriting the VPS URL in the Viewer URL dock.
      if (_vpsConfig && _vpsConfig.vpsEnabled) {
        log('Tunnel suppressed — VPS mode active.', 'ok');
        return;
      }
      log(I18N.t('Tunnel ready:') + ' ' + msg.url, 'ok');
      fetch('/api/info')
        .then((r) => r.json())
        .then((d) => {
          d.tunnelUrl = msg.url;
          renderUrls(d);
        });
      closeTunnelModal();
    }
    if (msg.type === 'tunnel-error') {
      log(I18N.t('Tunnel failed:') + ' ' + msg.provider, 'err');
      showTunnelError(
        'Failed to start ' +
          msg.provider +
          '.\n\nIf using a SSH tunnel (localhost.run / serveo), outbound port 22 is likely blocked by your router/ISP.\n\nTry using cloudflared instead.'
      );
    }
    if (msg.type === 'tunnel-not-found') {
      log(I18N.t('Tunnel executable not found:') + ' ' + msg.provider, 'err');
      showTunnelError(
        'The executable for ' +
          msg.provider +
          ' could not be found on your system.\n\nPlease install it or ensure it is in your PATH.'
      );
    }
    if (msg.type === 'vps-broadcast') {
      if (_vpsWs && _vpsWs.readyState === 1) {
        _vpsWs.send(msg.payload);
      }
    }
    if (
      msg.type === 'offer' ||
      msg.type === 'ice-host' ||
      msg.type === 'host-voice-cmd' ||
      msg.type === 'input-state' ||
      msg.type === 'pin-rejected' ||
      msg.type === 'rumble'
    ) {
      // These messages are bounced back from server.js if the target viewer is on the VPS.
      if (_vpsWs && _vpsWs.readyState === 1) {
        const target = msg._viewerId || msg.targetViewerId;
        if (target) {
          vpsDispatch(target, msg);
        } else {
          _vpsWs.send(JSON.stringify(msg));
        }
      }
    }
    if (msg.type === 'play-system-sound') {
      // Relative path from src/pages/host.html to assets/
      const soundFile = msg.action === 'join' ? '../../assets/joinsound.wav' : '../../assets/leavesound.wav';
      const audio = new Audio(soundFile);
      audio.volume = 0.5;
      audio.play().catch((err) => console.warn('[Audio] Could not play UI sound:', err));
      return;
    }
    if (msg.type === 'chat') appendChat(msg.from, msg.msg, false);
    if (msg.type === 'viewer-gpid') log(I18N.t('Controller:') + ' ' + msg.id, 'ok');
    if (msg.type === 'arcade-session-active') log(I18N.t('Arcade session is LIVE on Nearsec Arcade!'), 'ok');
    if (msg.type === 'arcade-session-error') log(I18N.t('Arcade error:') + ' ' + (msg.reason || 'unknown'), 'err');
    if (msg.type === 'input-error') {
      // Backend driver failure (e.g. ViGEmBus missing on Windows)
      console.error('[Input Error]', msg.message);
      log('Input Driver Error: ' + msg.message, 'err');
      if (window.showError) {
        // If it's a missing setup, show a warning. If it's a driver crash, show a critical red error.
        const severity = msg.message.toLowerCase().includes('udev') ? 'yellow' : 'red';
        window.showError('Input Driver Error: ' + msg.message, severity);
      }
    }
    if (msg.type === 'input-ready') {
      log('Input driver ready: ' + (msg.message || ''), 'ok');
    }
    if (msg.type === 'regen-pin') {
      currentPin = msg.pin;
      document.getElementById('pinVal').textContent = msg.pin;
      log(I18N.t('PIN regenerated:') + ' ' + msg.pin, 'ok');
    }
  };
  ws.onclose = () => {
    log(I18N.t('Disconnected — retrying'), 'warn');
    setTimeout(connectWS, 2000);
  };
  ws.onerror = () => log(I18N.t('WS error'), 'err');
}

async function sendOfferToViewer(viewerId) {
  if (!currentStream) return;
  if (peerConnections[viewerId]) {
    closePeerConnection(peerConnections[viewerId]);
    delete peerConnections[viewerId];
  }

  if (!_turnCredentials && _turnFetchPromise) {
    await _turnFetchPromise;
  }

  const pc = new RTCPeerConnection(buildRtcConfig(_turnCredentials));

  peerConnections[viewerId] = pc;

  const pipelineVal = document.getElementById('pipelineSelect')?.value;
  const forceWc =
    new URLSearchParams(window.location.search).get('wc') === '1' ||
    pipelineVal === 'webcodecs' ||
    pipelineVal === 'custom_webcodecs';

  if (forceWc) {
    // ── THE MISSING UDP TUNNEL ──
    // Fully reliable + ordered. Unreliable modes (maxRetransmits: 0) are
    // fatal here: a keyframe spans 50-130 SCTP packets and losing ANY one
    // abandons the whole message, so on a WAN with ~1% loss most keyframes
    // die in transit and the viewer cycles freeze→resync forever. SCTP
    // retransmits cost one RTT on loss; sustained congestion is handled by
    // the bufferedAmount send gate in webcodecs-encoder.js instead.
    pc.wcChannel = pc.createDataChannel('webcodecs', { ordered: true });

    // When the channel opens for this viewer, send the cached decoder config
    // immediately so they don't wait for the next keyframe (which may be seconds away).
    // Then force a keyframe so they can start decoding right away.
    pc.wcChannel.onopen = () => {
      console.log(`[WebCodecs] wcChannel open for ${viewerId} — sending cached config and forcing a keyframe`);

      // 1. Send the configuration to boot the decoder
      if (_lastWcConfig && pc.wcChannel.readyState === 'open') {
        pc.wcChannel.send(_lastWcConfig);
      }

      // 2. FORCE THE ENCODER TO SEND A NEW KEYFRAME
      if (_wcEncoder && _wcEncoder.state !== 'closed') {
        _wcForceKeyframe = true;
        console.log(`[WebCodecs] Keyframe requested for late-joiner ${viewerId}`);
      }
    };
  }

  // ── UDP FAST-LANE FOR INPUT ──
  pc.inputChannel = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
  pc.inputChannel.onmessage = (e) => {
    if (ws && ws.readyState === 1) {
      try {
        const inner = JSON.parse(e.data);
        // Fast-lane inputs bypass the VPS router, so we must manually stamp the correct session ID
        inner.viewerId = viewerId;
        inner.viewer_id = viewerId;
        if (inner.type === 'gamepad' && !inner.pad_id) inner.pad_id = viewerId + '_0';
        ws.send(JSON.stringify(inner));
      } catch (_) {
        ws.send(e.data);
      }
    }
  };

  currentStream.getTracks().forEach((track) => {
    if (track.kind === 'video' && forceWc) {
      console.log(`[WebRTC] Skipping video track attachment for ${viewerId} because WebCodecs is active.`);
      return;
    }

    const sender = pc.addTrack(track, currentStream);
    if (track.kind === 'video' && sender.setParameters) {
      const params = sender.getParameters();
      if (params.encodings && params.encodings.length > 0) {
        params.encodings[0].networkPriority = 'high';
      }
      sender.setParameters(params).catch(() => {});
    }
  });

  let codec = null;
  if (!forceWc) {
    codec = preferVideoCodec(pc);
    const cb = document.getElementById('codecBadge');
    if (codec && cb) cb.textContent = codec.split('/')[1];
  }

  let connectTimeout = setTimeout(() => {
    if (pc.connectionState !== 'connected' && peerConnections[viewerId] === pc) {
      log(I18N.t('Handshake timeout for') + ' ' + viewerId + ', fast retrying...', 'warn');
      sendOfferToViewer(viewerId);
    }
  }, 12000);

  pc.onicecandidate = (e) => {
    if (e.candidate && e.candidate.candidate) {
      const msg = { type: 'ice-host', candidate: e.candidate, _viewerId: viewerId };
      if (window.P2PManager && window.P2PManager.isPeer(viewerId)) {
        window.P2PManager.sendToPeer(viewerId, msg);
      } else {
        ws.send(JSON.stringify(msg));
      }
    }
  };

  pc.ontrack = (e) => {
    if (e.track.kind === 'audio') {
      let audioEl = document.getElementById('remote-audio-' + viewerId);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = 'remote-audio-' + viewerId;
        audioEl.autoplay = true;

        // Apply the saved volume/mute state immediately
        const state = viewerAudioStates[viewerId] || { vol: 100, state: 0 };
        audioEl.volume = state.vol / 100;
        audioEl.muted = state.state >= 2 || _globalMicKillActive;

        // ── THE FIX: Apply hardware route to new viewers ──
        if (typeof audioEl.setSinkId === 'function' && selectedOutputDeviceId && selectedOutputDeviceId !== 'default') {
          audioEl
            .setSinkId(selectedOutputDeviceId)
            .catch((err) => console.warn('[Audio] setSinkId error on join:', err));
        }

        document.body.appendChild(audioEl);
      }
      audioEl.srcObject = e.streams[0];
      log(`Incoming voice stream attached for ${viewerId}`, 'ok');
    }
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    log(I18N.t('Viewer') + ' ' + viewerId + ': ' + s, s === 'connected' ? 'ok' : s === 'failed' ? 'err' : '');

    if (s === 'connected') {
      clearTimeout(connectTimeout);
      setLowLatencyParams(pc);
      monitorCongestion(pc, viewerId);

      // ── KEYFRAME HACK ──
      // Some hardware encoders (Linux Vaapi) drop or ignore PLI requests from new viewers,
      // resulting in a permanent black screen until the stream is fully restarted.
      // Replacing the sender's track with itself forces Chromium to flush the encoder pipeline
      // and emit a fresh IDR keyframe, instantly fixing the black screen for late-joiners.
      // Guard: only fire if this pc is still the active connection for this viewer.
      // Without this guard, a stale timer from a replaced pc fires on the new connection's
      // DTLS transport while it is being set up, triggering a DcSctpTransport abort cascade.
      setTimeout(() => {
        if (peerConnections[viewerId] !== pc) return;
        try {
          const videoSender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
          if (videoSender && videoSender.track) {
            videoSender
              .replaceTrack(videoSender.track)
              .catch((e) => console.warn('[WebRTC] Keyframe force failed:', e));
            log(I18N.t('Forced keyframe for') + ' ' + viewerId, 'ok');
          }
        } catch (e) {}
      }, 600);
    }

    if (s === 'failed' || s === 'disconnected') {
      clearTimeout(connectTimeout);
      if (peerConnections[viewerId] === pc) {
        log(I18N.t('Retrying offer to') + ' ' + viewerId, 'warn');
        delete peerConnections[viewerId];
        setTimeout(() => sendOfferToViewer(viewerId), 500);
      }
    }
  };

  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
    await pc.setLocalDescription({ type: offer.type, sdp: offer.sdp });
    const rawCodecName = codec ? codec.split('/')[1].toLowerCase() : null;
    const msg = { type: 'offer', sdp: pc.localDescription, _viewerId: viewerId, codec: rawCodecName };
    if (window.P2PManager && window.P2PManager.isPeer(viewerId)) {
      window.P2PManager.sendToPeer(viewerId, msg);
    } else {
      ws.send(JSON.stringify(msg));
    }
    log(I18N.t('Offer → viewer') + ' ' + viewerId, 'ok');
  } catch (err) {
    log(I18N.t('Fatal WebRTC Error for') + ' ' + viewerId + ': ' + err.message, 'err');
  }
}

let selectedSourceId = null;
let activeSourceId = null;

// Hydrate select values from localStorage once the DOM is ready.
// host.js now loads at the bottom of <body>, so readyState is almost always
// 'interactive' or 'complete' by execution time — addEventListener('DOMContentLoaded')
// would silently never fire. This pattern handles both cases.
function hydrateSelectsFromStorage() {
  const selectDefs = [
    {
      key: 'ns_codec',
      id: 'codecSelect',
      onChange: async () => {
        if (currentStream) await window.saveCodecUI(document.getElementById('codecSelect').value);
      },
    },
    {
      key: 'ns_bitrate',
      id: 'bitrateSelect',
      onChange: () => {
        if (currentStream) applyBitrateToAll();
      },
    },
    {
      key: 'ns_deg',
      id: 'degSelect',
      onChange: () => {
        if (currentStream) applyBitrateToAll();
      },
    },
    {
      key: 'ns_res',
      id: 'resSelect',
      onChange: async () => {
        if (currentStream) await hotSwapCapture();
      },
    },
    {
      key: 'ns_fps',
      id: 'fpsSelect',
      onChange: async () => {
        if (currentStream) await hotSwapCapture();
      },
    },
  ];
  selectDefs.forEach(({ key, id, onChange }) => {
    const el = document.getElementById(id);
    if (!el) return;
    const saved = localStorage.getItem(key);
    if (saved) {
      el.value = saved;
      el.dispatchEvent(new Event('input'));
    }
    el.addEventListener('change', async (e) => {
      saveSetting(key, e.target.value, key.replace('ns_', 'quality_'));
      if (onChange) {
        try {
          await Promise.resolve(onChange());
        } catch (err) {
          console.error('Quality setting change error:', err);
        }
      }
    });
  });

  // Load VPS config from Electron main process on boot
  if (window.electronAPI && typeof window.electronAPI.getVpsConfig === 'function') {
    window.electronAPI
      .getVpsConfig()
      .then((cfg) => {
        if (cfg && cfg.vpsEnabled) {
          log('VPS SFU mode enabled — connecting to ' + cfg.vpsUrl, 'ok');
          connectVps(cfg);
        }
      })
      .catch(() => {});
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', hydrateSelectsFromStorage);
} else {
  hydrateSelectsFromStorage();
}

// ── WebCodecs encoder state ──────────────────────────────────────────────────
// Shared across host.js (sendOfferToViewer's wcChannel wiring, this file's
// forceWebCodecsKeyframe), scripts/capture.js (stopCapture's teardown), and
// scripts/webcodecs-encoder.js (startWebCodecsNetworkPipeline, which owns
// these) — too widely read/written across files to move with any one of
// them, so it stays here (same call as peerConnections/ws). See
// REFACTOR_PLAN.md Phase 5.9.
//
// _lastWcConfig: last known decoder config — cached so late-joining viewers
// receive it immediately on wcChannel.onopen rather than waiting for a
// keyframe that already fired at pipeline start (when peerConnections was
// still empty).
let _lastWcConfig = null;
let _wcEncoder = null;
let _wcForceKeyframe = false;

function updateKbmPanicButton() {
  const btn = document.getElementById('btnKbmPanic');
  if (!btn) return;
  const SPAN_STYLE =
    'font-size:10px;font-weight:bold;color:inherit;letter-spacing:0.5px;line-height:1.1;text-align:center;';
  if (kbmPanicActive) {
    btn.innerHTML = `<span style="${SPAN_STYLE}">RESUME<br>KBM</span>`;
    btn.style.background = 'rgba(220,50,50,0.2)';
    btn.style.border = '1px solid var(--danger)';
    btn.style.color = 'var(--danger)';
  } else {
    btn.innerHTML = `<span style="${SPAN_STYLE}">KBM<br>PANIC</span>`;
    btn.style.background = 'transparent';
    btn.style.border = 'none';
    btn.style.color = '';
  }
}

function toggleKbmPanic() {
  kbmPanicActive = !kbmPanicActive;
  updateKbmPanicButton();

  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'panic_toggle', enabled: kbmPanicActive }));
  }

  if (kbmPanicActive) {
    log('⚠ KBM PANIC ACTIVATED - All viewer keyboard/mouse input frozen', 'warn');
  } else {
    log('✓ KBM panic released', 'ok');
  }
}

// ── SAVING THE CAPTURE METHOD (PIPELINE) ──
window.saveCodecUI = async function (val) {
  localStorage.setItem('ns_codec', val);
  const pipelineVal = document.getElementById('pipelineSelect')?.value;
  const forceWc =
    new URLSearchParams(window.location.search).get('wc') === '1' ||
    pipelineVal === 'webcodecs' ||
    pipelineVal === 'custom_webcodecs';

  if (forceWc) {
    if (currentStream && window._webcodecsReader) {
      log(I18N.t('Applying new WebCodecs encoder...'), 'warn');
      await startWebCodecsCapture(currentStream);
      log(I18N.t('Encoder restarted successfully!'), 'ok');
    }
  } else {
    if (Object.keys(peerConnections).length > 0) {
      log(I18N.t('Applying new codec to active viewers (seamless renegotiation)...'), 'warn');

      // Broadcast the codec change to all viewers in chat
      const selectEl = document.getElementById('codecSelect');
      if (selectEl && ws && ws.readyState === 1) {
        const codecName = selectEl.options[selectEl.selectedIndex].text;
        const chatMsg = `Host dynamically swapped the stream codec to ${codecName}.`;
        ws.send(JSON.stringify({ type: 'chat', from: 'Nearsec', msg: chatMsg }));
        if (typeof appendChat === 'function') appendChat('Nearsec', chatMsg, false);
      }

      for (const vid in peerConnections) {
        const pc = peerConnections[vid];
        if (pc.connectionState === 'connected' || pc.connectionState === 'connecting') {
          const codec = preferVideoCodec(pc);
          const rawCodecName = codec ? codec.split('/')[1].toLowerCase() : null;
          const cb = document.getElementById('codecBadge');
          if (codec && cb) cb.textContent = codec.split('/')[1];

          pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false })
            .then((offer) => pc.setLocalDescription(offer))
            .then(() => {
              const msg = { type: 'offer', sdp: pc.localDescription, _viewerId: vid, codec: rawCodecName };
              if (window.P2PManager && window.P2PManager.isPeer(vid)) {
                window.P2PManager.sendToPeer(vid, msg);
              } else {
                ws.send(JSON.stringify(msg));
              }
              log(I18N.t('Codec renegotiated for viewer') + ' ' + vid, 'ok');
            })
            .catch((err) => console.error('[WebRTC] Renegotiation failed:', err));
        }
      }
    }
  }
};

function saveCaptureMethod(method) {
  const pSelect = document.getElementById('pipelineSelect');

  // Determine what the CURRENT active pipeline is based on URL params
  const urlParams = new URLSearchParams(window.location.search);
  let activeMethod = 'native';
  if (urlParams.get('wc') === '1') activeMethod = 'webcodecs';
  if (urlParams.get('wc') === '2') activeMethod = 'custom_webcodecs';
  else if (urlParams.get('ff') === '1' || (typeof process !== 'undefined' && process.argv?.includes('--ffmpeg')))
    activeMethod = 'ffmpeg';

  if (window.electronAPI && window.electronAPI.saveSettings) {
    // Let the user know they need to restart
    const confirmMsg =
      'Capture pipeline changed to ' +
      method.toUpperCase() +
      '. You must restart NearsecTogether for this to take effect. Close the app now?';
    if (confirm(confirmMsg)) {
      window.electronAPI.saveSettings({ captureMethod: method });
      console.log(`[Host] Capture pipeline saved as: ${method}. Closing app...`);
      window.electronAPI.closeApp();
    } else {
      // Revert the dropdown
      if (pSelect) pSelect.value = activeMethod;
      console.log(`[Host] Pipeline change cancelled. Reverted to ${activeMethod}.`);
    }
  }
}

// Ensure the UI matches the loaded URL parameter on boot
function hydratePipelineSelect() {
  const pSelect = document.getElementById('pipelineSelect');
  if (!pSelect) return;

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('wc') === '1') {
    pSelect.value = 'webcodecs';
  } else if (urlParams.get('ff') === '1' || (typeof process !== 'undefined' && process.argv?.includes('--ffmpeg'))) {
    pSelect.value = 'ffmpeg';
  } else {
    pSelect.value = 'native';
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', hydratePipelineSelect);
} else {
  hydratePipelineSelect();
}

function applyCtrlSettingsUI() {
  const trackXbox = document.getElementById('ctrlTrackForceXboxOne');
  const rowXbox = document.getElementById('ctrlRowForceXboxOne');
  const warnXbox = document.getElementById('ctrlWarnForceXboxOne');

  const trackDS = document.getElementById('ctrlTrackDualShock');
  const rowDS = document.getElementById('ctrlRowDualShock');

  const trackMotion = document.getElementById('ctrlTrackMotion');
  const rowMotion = document.getElementById('ctrlRowMotion');

  const modeSelect = document.getElementById('defaultInputModeSelect');
  if (modeSelect) modeSelect.value = ctrlSettings.defaultInputMode;
  const trackHybrid = document.getElementById('ctrlTrackHybrid');
  if (trackHybrid) trackHybrid.classList.toggle('on', !!ctrlSettings.hybridInput);
  const ctrlTypeSelect = document.getElementById('ctrlTypeSelect');
  if (ctrlTypeSelect) ctrlTypeSelect.value = ctrlSettings.ctrlType || 'xbox360';

  const btn = document.getElementById('ctrlSettingsBtn');

  if (trackXbox) trackXbox.classList.toggle('on', ctrlSettings.forceXboxOne);
  if (rowXbox) rowXbox.classList.toggle('active', ctrlSettings.forceXboxOne);
  if (warnXbox) warnXbox.style.display = ctrlSettings.forceXboxOne ? 'block' : 'none';

  if (trackDS) trackDS.classList.toggle('on', ctrlSettings.enableDualShock);
  if (rowDS) rowDS.classList.toggle('active', ctrlSettings.enableDualShock);

  if (trackMotion) trackMotion.classList.toggle('on', ctrlSettings.enableMotion);
  if (rowMotion) rowMotion.classList.toggle('active', ctrlSettings.enableMotion);

  const touchSelect = document.getElementById('touchLayoutSelect');
  if (touchSelect) touchSelect.value = ctrlSettings.touchLayout;

  const isNonDefault =
    ctrlSettings.forceXboxOne ||
    ctrlSettings.enableDualShock ||
    ctrlSettings.enableMotion ||
    ctrlSettings.defaultInputMode !== 'gamepad' ||
    ctrlSettings.touchLayout !== 'default';
  if (btn) btn.style.color = isNonDefault ? 'var(--warn)' : '';
}

function toggleCtrlSetting(key) {
  ctrlSettings[key] = !ctrlSettings[key];
  saveSetting('ns_ctrl_' + key, ctrlSettings[key], 'ctrlSetting_' + key);
  applyCtrlSettingsUI();
  sendCtrlSettings();
  log(I18N.t('ctrl-settings:') + ' ' + key + ' = ' + ctrlSettings[key], 'ok');
}

function toggleHybridInput() {
  ctrlSettings.hybridInput = !ctrlSettings.hybridInput;
  saveSetting('ns_ctrl_hybridInput', ctrlSettings.hybridInput, 'ctrlSetting_hybridInput');

  if (ctrlSettings.hybridInput) {
    ctrlSettings.defaultInputMode = 'kbm_emulated';
    saveSetting('ns_ctrl_defaultInputMode', 'kbm_emulated', 'ctrlSetting_defaultInputMode');
  } else {
    ctrlSettings.defaultInputMode = 'gamepad';
    saveSetting('ns_ctrl_defaultInputMode', 'gamepad', 'ctrlSetting_defaultInputMode');
  }

  applyCtrlSettingsUI();
  sendCtrlSettings();
  if (ws && ws.readyState === 1 && ctrlSettings.hybridInput) {
    (_lastRosterList || []).forEach((v) => {
      changeInputMode(v.id, 'kbm_emulated', v.name);
    });
    log(I18N.t('Hybrid Input ON — Gamepad + KBM active for all viewers'), 'ok');
  } else if (ws && ws.readyState === 1) {
    (_lastRosterList || []).forEach((v) => {
      changeInputMode(v.id, 'gamepad', v.name);
    });
    log(I18N.t('Hybrid Input OFF'), 'warn');
  }
}

function changeCtrlType(type) {
  ctrlSettings.ctrlType = type;
  saveSetting('ns_ctrl_ctrlType', type, 'ctrlSetting_ctrlType');
  applyCtrlSettingsUI();
  sendCtrlSettings();
  if (ws && ws.readyState === 1) {
    (_lastRosterList || []).forEach((v) => {
      ws.send(JSON.stringify({ type: 'set-ctrl-type', viewerId: v.id.split('_')[0], ctrlType: type }));
    });
  }
  log(I18N.t('Controller type:') + ' ' + type, 'ok');
  log(I18N.t('Controller type:') + ' ' + type, 'ok');
}

function changeTouchLayout(layout) {
  ctrlSettings.touchLayout = layout;
  saveSetting('ns_ctrl_touchLayout', layout, 'ctrlSetting_touchLayout');
  applyCtrlSettingsUI();
  sendCtrlSettings(); // This updates server.js state and broadcasts to local + VPS viewers automatically
  log('Mobile touch layout set to: ' + layout, 'ok');
}

function changeDefaultInputMode(mode) {
  ctrlSettings.defaultInputMode = mode;
  saveSetting('ns_ctrl_defaultInputMode', mode, 'ctrlSetting_defaultInputMode');
  applyCtrlSettingsUI();
  sendCtrlSettings();
  log(I18N.t('Default input mode set to:') + ' ' + mode, 'ok');
}

function sendCtrlSettings() {
  let expDevices = [];
  try {
    if (typeof appConfig !== 'undefined' && appConfig.expDevices) expDevices = appConfig.expDevices;
    else expDevices = JSON.parse(localStorage.getItem('ns_exp_devices') || '[]');
  } catch (e) {}

  const payload = JSON.stringify({
    type: 'ctrl-settings',
    forceXboxOne: ctrlSettings.forceXboxOne,
    enableDualShock: ctrlSettings.enableDualShock,
    enableMotion: ctrlSettings.enableMotion,
    defaultInputMode: ctrlSettings.defaultInputMode,
    hybridInput: ctrlSettings.hybridInput,
    ctrlType: ctrlSettings.ctrlType,
    touchLayout: ctrlSettings.touchLayout,
    expDevices: expDevices,
  });

  if (ws && ws.readyState === 1) {
    ws.send(payload);
  }

  if (typeof _vpsWs !== 'undefined' && _vpsWs && _vpsWs.readyState === 1) {
    _vpsWs.send(payload);
  }
}

// ── Input Visualizer ──────────────────────────────────────────────────────────
let _inputVizVisible = false;
let _inputVizSse = null;
let _vizPktCount = 0;
let _vizPpsTimer = null;

function toggleInputVisualizer() {
  _inputVizVisible = !_inputVizVisible;
  const overlay = document.getElementById('inputVizOverlay');
  const track = document.getElementById('smTrackInputViz');
  const row = document.getElementById('smRowInputViz');
  if (overlay) overlay.style.display = _inputVizVisible ? 'block' : 'none';
  if (track) track.classList.toggle('on', _inputVizVisible);
  if (row) row.classList.toggle('active', _inputVizVisible);

  if (_inputVizVisible) {
    _startInputVizSse();
  } else {
    _stopInputVizSse();
  }
}

function _startInputVizSse() {
  if (_inputVizSse) return;
  const port = new URLSearchParams(location.search).get('port') || location.port || 3000;
  _inputVizSse = new EventSource(`http://localhost:${port}/api/input-visualizer`);
  _inputVizSse.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      _vizPktCount++;
      const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };
      set('inputVizSource', d.source || '');
      set('vizButtons', '0x' + (d.buttons || 0).toString(16).padStart(4, '0').toUpperCase());
      set('vizTriggers', (+(d.lt || 0)).toFixed(2) + ' / ' + (+(d.rt || 0)).toFixed(2));
      set('vizLStick', (+(d.lx || 0)).toFixed(2) + ', ' + (+(d.ly || 0)).toFixed(2));
      set('vizRStick', (+(d.rx || 0)).toFixed(2) + ', ' + (+(d.ry || 0)).toFixed(2));
      set('vizSlot', d.slotIndex !== undefined ? String(d.slotIndex) : '—');

      // Flash active class on non-zero buttons
      const bEl = document.getElementById('vizButtons');
      if (bEl) bEl.classList.toggle('active', (d.buttons || 0) !== 0);
    } catch (_) {}
  };
  _inputVizSse.onerror = () => {};

  _vizPpsTimer = setInterval(() => {
    const el = document.getElementById('vizPps');
    if (el) el.textContent = String(_vizPktCount);
    _vizPktCount = 0;
  }, 1000);
}

function _stopInputVizSse() {
  if (_inputVizSse) {
    _inputVizSse.close();
    _inputVizSse = null;
  }
  if (_vizPpsTimer) {
    clearInterval(_vizPpsTimer);
    _vizPpsTimer = null;
  }
}

// Audio backend setting (saved for the worker init path)
function saveAudioBackend(val) {
  saveSetting('ns_audio_backend', val, 'audioBackend');
  const port = new URLSearchParams(location.search).get('port') || location.port || 3000;
  fetch(`http://localhost:${port}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioBackend: val }),
  }).catch(() => {});
}

// Populates the sm-prefixed selects in settingsModal Audio tab by mirroring
// the canonical audioInputSelect / audioOutputSelect from appSettingsModal.
function enumerateAudioDevicesSM() {
  enumerateAudioDevices()
    .then(() => {
      // Mirror populated options into the sm selects
      const srcOut = document.getElementById('audioOutputSelect');
      const dstOut = document.getElementById('smAudioOutputSelect');
      const srcIn = document.getElementById('audioInputSelect');
      const dstIn = document.getElementById('smAudioInputSelect');
      if (srcOut && dstOut) {
        dstOut.innerHTML = srcOut.innerHTML;
        dstOut.value = srcOut.value;
      }
      if (srcIn && dstIn) {
        dstIn.innerHTML = srcIn.innerHTML;
        dstIn.value = srcIn.value;
      }
    })
    .catch(() => {});
}

// Keeps the smRowCaptureMic / smMicDeviceRow in sync with appSettings.captureMic
function _syncSmMicRow() {
  const smTrack = document.getElementById('smTrackCaptureMic');
  const smRow = document.getElementById('smRowCaptureMic');
  const smMicRow = document.getElementById('smMicDeviceRow');
  if (smTrack) smTrack.classList.toggle('on', !!appSettings.captureMic);
  if (smRow) smRow.classList.toggle('active', !!appSettings.captureMic);
  if (smMicRow) smMicRow.style.display = appSettings.captureMic ? 'block' : 'none';
}

const SVG_EYE_OPEN =
  '<img src="/assets/icons/eye.svg"     style="width:20px;height:20px;filter:invert(0.6);pointer-events:none;" alt="">';
const SVG_EYE_CLOSED =
  '<img src="/assets/icons/eye-off.svg" style="width:20px;height:20px;filter:invert(0.6);pointer-events:none;" alt="">';

function togglePreview() {
  previewHidden = !previewHidden;
  const prev = document.getElementById('preview');
  const btn = document.getElementById('btnPreviewToggle');
  const overlay = document.getElementById('prevOverlay');

  if (previewHidden) {
    prev.srcObject = null;
    prev.style.display = 'none';
    // Only say "stream still active" if there actually IS a stream
    if (overlay) {
      overlay.classList.remove('hidden');
      const sp = overlay.querySelector('span');
      if (sp) sp.textContent = currentStream ? 'Preview hidden — stream still active' : 'Click Start to begin sharing';
    }
    if (btn) {
      btn.innerHTML = SVG_EYE_CLOSED;
      btn.style.color = 'var(--warn)';
    }
    log(I18N.t('Preview hidden — stream unaffected'), 'ok');
  } else {
    prev.style.display = 'block';
    if (currentStream) {
      prev.srcObject = currentStream;
      if (overlay) overlay.classList.add('hidden');
    }
    if (btn) {
      btn.innerHTML = SVG_EYE_OPEN;
      btn.style.color = '';
    }
    log(I18N.t('Preview restored'), 'ok');
  }
}

function saveAudioDevice(type, deviceId) {
  if (type === 'input') {
    selectedMicDeviceId = deviceId;
    localStorage.setItem('ns_audio_input', deviceId);
  } else {
    selectedOutputDeviceId = deviceId;
    localStorage.setItem('ns_audio_output', deviceId);

    // ── THE FIX: Route viewer voices explicitly to hardware ──
    // This forces the voice chat to bypass NearsecVirtual, preventing stream echo
    document.querySelectorAll('audio[id^="remote-audio-"]').forEach((el) => {
      if (typeof el.setSinkId === 'function') {
        const targetId = deviceId === 'default' ? '' : deviceId;
        el.setSinkId(targetId).catch((e) => console.warn('[Audio] setSinkId error:', e));
      }
    });

    if (typeof log === 'function') {
      log(
        deviceId === 'default'
          ? 'Viewer output set to Default (Warning: May cause echo)'
          : 'Viewer output securely routed to hardware',
        'ok'
      );
    }
  }
}

async function enumerateAudioDevices() {
  try {
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    tempStream.getTracks().forEach((t) => t.stop());
  } catch (e) {}

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();

    const inputSel = document.getElementById('audioInputSelect');
    const outputSel = document.getElementById('audioOutputSelect');
    if (!inputSel || !outputSel) return;

    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const outputs = devices.filter((d) => d.kind === 'audiooutput');

    inputSel.innerHTML = '<option value="default">Default Microphone</option>';
    outputSel.innerHTML = '<option value="default">Default (all system audio)</option>';

    inputs.forEach((d) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.text = d.label || 'Microphone ' + (inputs.indexOf(d) + 1);
      if (d.deviceId === selectedMicDeviceId) o.selected = true;
      inputSel.appendChild(o);
    });
    outputs.forEach((d) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.text = d.label || 'Audio Device ' + (outputs.indexOf(d) + 1);
      if (d.deviceId === selectedOutputDeviceId) o.selected = true;
      outputSel.appendChild(o);
    });
  } catch (e) {
    log(I18N.t('Audio device enumeration failed:') + ' ' + e.message, 'warn');
  }
}

function sysChat(text) {
  chatSendSystemMessage(ws, 'Nearsec', text);
}

function createVirtualAudioCable() {
  log(I18N.t('Creating virtual audio cable...'), 'ok');
  fetch('/api/create-virtual-audio', { method: 'POST' })
    .then((r) => r.json())
    .then((res) => {
      if (res.success) {
        log(I18N.t('Virtual cable created! Updating devices...'), 'ok');
        setTimeout(() => {
          enumerateAudioDevices();
          document.getElementById('virtualAudioHelp').style.color = 'var(--accent)';
        }, 1000);
      } else {
        log(I18N.t('Failed to create cable:') + ' ' + res.error, 'err');
      }
    })
    .catch((e) => log(I18N.t('Network error creating cable'), 'err'));
}

applyCtrlSettingsUI();

// ── HYDRATE CONFIG FROM localStorage ──────────────────────────────────────────
// localStorage is a UI-layer cache only. On boot we push all settings that live
// there into the authoritative Electron config file so they survive config deletion
// and are always in sync. hydrateSettings does a shallow merge — it never removes
// keys the renderer doesn't know about.
if (window.electronAPI?.hydrateSettings) {
  const lsMap = {
    // ctrlSettings
    ctrlSetting_forceXboxOne: localStorage.getItem('ns_ctrl_forceXboxOne') === 'true',
    ctrlSetting_enableDualShock: localStorage.getItem('ns_ctrl_enableDualShock') === 'true',
    ctrlSetting_enableMotion: localStorage.getItem('ns_ctrl_enableMotion') === 'true',
    ctrlSetting_defaultInputMode: localStorage.getItem('ns_ctrl_defaultInputMode') || 'gamepad',
    ctrlSetting_hybridInput: localStorage.getItem('ns_ctrl_hybridInput') === 'true',
    ctrlSetting_ctrlType: localStorage.getItem('ns_ctrl_ctrlType') || 'xbox360',
    // quality / capture
    captureMethod: localStorage.getItem('ns_captureMethod') || undefined,
    quality_codec: localStorage.getItem('ns_quality_codec') || undefined,
    quality_res: localStorage.getItem('ns_quality_res') || undefined,
    quality_fps: localStorage.getItem('ns_quality_fps') || undefined,
    quality_bitrate: localStorage.getItem('ns_quality_bitrate') || undefined,
    quality_deg: localStorage.getItem('ns_quality_deg') || undefined,
    volumeDesktop:
      localStorage.getItem('ns_volume_desktop') != null ? Number(localStorage.getItem('ns_volume_desktop')) : undefined,
    volumeMic:
      localStorage.getItem('ns_volume_mic') != null ? Number(localStorage.getItem('ns_volume_mic')) : undefined,
  };
  // Strip out undefined entries so we don't overwrite real values with null
  const hydratePatch = Object.fromEntries(Object.entries(lsMap).filter(([, v]) => v !== undefined && v !== null));
  if (Object.keys(hydratePatch).length) window.electronAPI.hydrateSettings(hydratePatch).catch(() => {});
}
// ─────────────────────────────────────────────────────────────────────────────

connectWS();

// ── AUTOMATED HEADLESS BOOT (Arcade Worker) ───────────────────────────
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('auto') === '1') {
  let autoTitle = urlParams.get('title') || 'Arcade Game';
  const autoTunnel = urlParams.get('tunnel') || 'cloudflared';

  console.log(`[Headless] Initializing automated boot for: ${autoTitle}`);

  const isLinux = navigator.userAgent.includes('Linux') || navigator.platform.toLowerCase().includes('linux');
  if (isLinux) {
    console.log('[Headless] Auto-generating virtual audio sink...');
    fetch('/api/create-virtual-audio', { method: 'POST' }).catch(() => {});
  }

  setTimeout(() => {
    // Do not start any local tunnel when VPS SFU is configured —
    // the VPS connection is managed by connectVps() on WS open.
    if (_vpsConfig && _vpsConfig.vpsEnabled) {
      console.log('[Headless] VPS SFU active — skipping local tunnel boot.');
    } else if (autoTunnel === 'p2p') {
      console.log('[Headless] Starting P2P tunnel via auto boot...');
      proceedP2POnly();
    } else {
      fetch('/api/start-tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: autoTunnel, remember: true }),
      }).catch(() => {});
    }

    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tunnelProvider: autoTunnel, neverAsk: true }),
    }).then(() => {
      fetch('/api/config')
        .then((r) => r.json())
        .then((cfg) => {
          let target = (cfg.autoHosts || []).find((h) => h.name === autoTitle);
          if (!target && cfg.autoHosts && cfg.autoHosts.length > 0) {
            target = cfg.autoHosts[0];
            autoTitle = target.name;
            console.log(`[Headless] Target title not found, defaulting to: ${target.name}`);
          }

          document.getElementById('arcadeGameTitle').value = autoTitle;
          document.getElementById('arcadeMaxPlayers').value = target?.maxPlayers || '4';
          document.getElementById('arcadeRequirePin').checked = false;

          if (target && target.cmd) {
            console.log(`[Headless] Launching game process: ${target.cmd}`);
            fetch('/api/restart-game', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ command: target.cmd }),
            });
          }

          setTimeout(async () => {
            if (window.electronAPI) {
              try {
                const sources = await window.electronAPI.getWindowSources();
                let virtualScreen = sources.find((s) => s.isScreen);
                if (virtualScreen) {
                  console.log(`[Headless] Locked onto isolated virtual display: ${virtualScreen.id}`);
                  selectedSourceId = virtualScreen.id;
                } else {
                  console.log('[Headless] No virtual display found, attempting fallback.');
                }
              } catch (e) {
                console.log('[Headless] Failed to scan displays:', e);
              }
            }
            startArcadeSession();
          }, 4000);
        });
    });
  }, 1500);
}
// ── GAMEPAD CALIBRATION SAVER ──
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SAVE_CONTROLLER_CALIB') {
    const { hardwareId, map } = e.data;

    // Save to local storage for the browser viewer
    localStorage.setItem('nearsec_map_' + hardwareId, JSON.stringify(map));

    // If we are in Electron (Host), save it to the persistent config file
    if (window.electronAPI && window.electronAPI.saveSettings) {
      window.electronAPI.saveSettings({ [`calib_${hardwareId}`]: map });
      console.log('[Input] Saved calibration to disk for:', hardwareId);
    }
  }
});

// ── SYSTEM INFO POLL ─────────────────────────────────────────────────────────
async function fetchSysInfo() {
  try {
    const res = await fetch('/api/sysinfo');
    if (!res.ok) return;
    const data = await res.json();
    if (data.error) return;

    const cpuEl = document.getElementById('sysCpu');
    const ramEl = document.getElementById('sysRam');
    const netEl = document.getElementById('sysNet');

    if (cpuEl) cpuEl.textContent = `CPU: ${data.cpu}`;
    if (ramEl) ramEl.textContent = `RAM: ${data.ram}`;
    if (netEl) netEl.textContent = `NET: ${data.netTx} ↑ ${data.netRx} ↓`;
  } catch (e) {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setInterval(fetchSysInfo, 3000);
    fetchSysInfo();
    setTimeout(loadExpDevices, 500);
  });
} else {
  setInterval(fetchSysInfo, 3000);
  fetchSysInfo();
  setTimeout(loadExpDevices, 500);
}

let _discordStartTime = null;

function _updateDiscordRPC() {
  console.log(
    '[DEBUG] _updateDiscordRPC called. streamActive:',
    typeof streamActive !== 'undefined' ? streamActive : 'undef',
    'isArcade:',
    typeof isArcade !== 'undefined' ? isArcade : 'undef'
  );
  if (!window.electronAPI || typeof window.electronAPI.discordSetActivity !== 'function') {
    console.log('[DEBUG] window.electronAPI.discordSetActivity is missing!');
    return;
  }

  if (!_discordStartTime) {
    _discordStartTime = Date.now();
  }

  if (typeof isArcade !== 'undefined' && isArcade && typeof arcadeConfig !== 'undefined' && arcadeConfig.title) {
    const lang = window.I18N && I18N.targetLang ? I18N.targetLang : 'en';
    const supportedLogos = ['de', 'es', 'fr', 'ja', 'pt'];
    const imageKey = supportedLogos.includes(lang) ? `nearsec_logo_${lang}` : 'nearsec_logo';

    const payload = {
      details: `Playing ${arcadeConfig.title}`,
      state: `Arcade Mode (${arcadeConfig.requirePin ? 'Private' : 'Public'})`,
      startTimestamp: _discordStartTime,
      largeImageKey: imageKey,
      largeImageText: 'NearsecTogether',
    };

    if (window.hostSessionId) payload.partyId = window.hostSessionId;
    if (typeof knownViewers !== 'undefined') {
      payload.partySize = knownViewers.size + 1;
      payload.partyMax = parseInt(arcadeConfig.maxPlayers || 4);
    }
    const secret = window._isP2P ? window._p2pCode : window._globalTunnelUrl;
    if (secret && secret !== 'none') payload.joinSecret = secret;

    console.log('[DEBUG] Sending Discord Arcade Activity:', payload);
    window.electronAPI.discordSetActivity(payload);
  } else if (typeof streamActive !== 'undefined' && streamActive) {
    const lang = window.I18N && I18N.targetLang ? I18N.targetLang : 'en';
    const supportedLogos = ['de', 'es', 'fr', 'ja', 'pt'];
    const imageKey = supportedLogos.includes(lang) ? `nearsec_logo_${lang}` : 'nearsec_logo';

    const payload = {
      details: 'Hosting a session',
      state: `${knownViewers.size} viewer(s) connected`,
      startTimestamp: _discordStartTime,
      largeImageKey: imageKey,
      largeImageText: 'NearsecTogether',
    };

    if (window.hostSessionId) payload.partyId = window.hostSessionId;
    if (typeof knownViewers !== 'undefined') {
      payload.partySize = knownViewers.size + 1;
      payload.partyMax = 10;
    }
    const secret = window._isP2P ? window._p2pCode : window._globalTunnelUrl;
    if (secret && secret !== 'none') payload.joinSecret = secret;

    console.log('[DEBUG] Sending Discord Private Activity:', payload);
    window.electronAPI.discordSetActivity(payload);
  } else {
    console.log('[DEBUG] Clearing Discord Activity');
    _discordStartTime = null;
    window.electronAPI.discordClear();
  }
}

// ── Experimental Devices UI ──────────────────────────────────────────────────
function saveExpDevices() {
  const list = document.getElementById('expDeviceList');
  if (!list) return;
  const devices = [];
  list.querySelectorAll('[data-exp-val]').forEach((el) => {
    const toggle = el.querySelector('.ctrl-toggle-track');
    devices.push({
      val: el.dataset.expVal,
      text: el.dataset.expText,
      enabled: toggle ? toggle.classList.contains('on') : false,
    });
  });
  localStorage.setItem('ns_exp_devices', JSON.stringify(devices));
  saveAppConfig({ expDevices: devices });

  // Broadcast the updated experimental devices list to connected viewers
  if (typeof sendCtrlSettings === 'function') {
    sendCtrlSettings();
  }
}

function loadExpDevices() {
  let devices = [];
  try {
    if (typeof appConfig !== 'undefined' && appConfig.expDevices) devices = appConfig.expDevices;
    else devices = JSON.parse(localStorage.getItem('ns_exp_devices') || '[]');
  } catch (e) {}

  if (devices.length > 0) {
    const list = document.getElementById('expDeviceList');
    if (list) list.innerHTML = '';
    devices.forEach((d) => addExpDevice(d.val, d.text, d.enabled));
  }
}

function addExpDevice(inVal, inText, inEnabled = true) {
  let val,
    text,
    enabled = inEnabled;
  const sel = document.getElementById('expDeviceSelect');

  if (inVal && inText) {
    val = inVal;
    text = inText;
  } else {
    if (!sel) return;
    val = sel.value;
    text = sel.options[sel.selectedIndex].text;
  }

  const list = document.getElementById('expDeviceList');
  if (!list) return;
  if (list.innerText.includes('No experimental devices enabled')) {
    list.innerHTML = '';
  }

  // Check if already added
  if (list.querySelector(`[data-exp-val="${val}"]`)) return;

  // Determine status text based on device type
  const isImplemented = val === 'tablet' || val === 'guitar' || val === 'eye' || val === 'hotas' || val === 'vr';
  const statusText = isImplemented
    ? '<span style="color:var(--green);">Status: Active</span>'
    : '<span style="color:var(--muted2);">0 Users (Coming Soon)</span>';

  const el = document.createElement('div');
  el.dataset.expVal = val;
  el.dataset.expText = text;
  el.style.cssText =
    'display:flex; align-items:center; justify-content:space-between; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); border-radius:6px;';

  const toggleClass = enabled ? 'ctrl-toggle-track on' : 'ctrl-toggle-track';

  el.innerHTML = `
        <div style="display:flex; align-items:center; gap:12px;">
            <div class="${toggleClass}" onclick="this.classList.toggle('on'); saveExpDevices();" style="cursor:pointer;">
                <div class="ctrl-toggle-thumb"></div>
            </div>
            <div>
                <div style="font-size:11px; font-weight:600; color:var(--text);">${text}</div>
                <div style="font-size:9px;">${statusText}</div>
            </div>
        </div>
        <button onclick="this.parentElement.remove(); saveExpDevices(); if(document.getElementById('expDeviceList').children.length === 0) document.getElementById('expDeviceList').innerHTML='<div style=\\'text-align:center; color:var(--muted); font-size:11px; padding:20px;\\'>No experimental devices enabled.</div>';" class="close-modal" style="width:24px; height:24px; border:none; background:transparent;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px; height:14px;">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
        </button>
    `;
  list.appendChild(el);
  saveExpDevices();
}

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. It exists purely so Vitest (Node) can import
// these functions directly instead of re-parsing the whole file. See
// REFACTOR_PLAN.md Phase 0 / test/unit/chat.test.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { log, appendChat, sendChat, preferVideoCodec };
}
