// ── VPS SFU (host.js only) ──────────────────────────────────────────────────
// Loaded via a <script> tag before host.js, same pattern as the other
// scripts/**/*.js modules. Connects to the optional remote VPS/NAS SFU
// router as an alternative to a local tunnel — vpsDispatch/handleVpsJoin/
// sendVpsViewerBootstrap wire individual viewers through it once connected.
//
// VPS connection state (_vpsWs/_vpsConfig/_vpsAuthOk/_smartDb/_viewerRegions/
// _pendingVpsViewers) stayed in host.js rather than moving here — it's
// read/written far beyond these functions (the WS message router, capture.js,
// ui/roster.js's _viewerRegions use), so it's shared infrastructure like
// peerConnections/ws, not this module's own state. See REFACTOR_PLAN.md
// Phase 5.9.

function vpsDispatch(viewerId, payload) {
  if (!_vpsWs || _vpsWs.readyState !== 1) return;
  _vpsWs.send(
    JSON.stringify({
      type: 'viewer-dispatch',
      viewerId,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    })
  );
}

async function sendVpsViewerBootstrap(viewerId) {
  const cfg = await loadAppConfig();
  vpsDispatch(viewerId, {
    type: 'host-connected',
    hostName: cfg.hostName || 'Host',
    hostRegion,
  });
  let expDevices = [];
  try {
    if (typeof appConfig !== 'undefined' && appConfig.expDevices) expDevices = appConfig.expDevices;
    else expDevices = JSON.parse(localStorage.getItem('ns_exp_devices') || '[]');
  } catch (e) {}

  vpsDispatch(viewerId, {
    type: 'ctrl-settings',
    touchLayout: ctrlSettings.touchLayout,
    enableMotion: ctrlSettings.enableMotion,
    expDevices: expDevices,
  });
  if (_smartDb && Object.keys(_smartDb).length) {
    vpsDispatch(viewerId, { type: 'smart-db', payload: _smartDb });
  }
  if (currentStream) {
    vpsDispatch(viewerId, { type: 'host-stream-ready' });
  } else {
    vpsDispatch(viewerId, { type: 'host-not-streaming', viewerId });
  }
}

function handleVpsJoin(viewerId, inner) {
  const name = String(inner.name || 'Viewer').slice(0, 20);
  const pin = String(inner.pin || '');
  const region = String(inner.viewerRegion || '')
    .toLowerCase()
    .slice(0, 2);
  if (region) _viewerRegions[viewerId] = region;

  if (pinEnabled && pin !== currentPin) {
    vpsDispatch(viewerId, { type: 'pin-rejected' });
    return;
  }

  _pendingVpsViewers.set(viewerId, { name, region, isDesktopApp: !!inner.isDesktopApp });
  if (_vpsWs && _vpsWs.readyState === 1) {
    _vpsWs.send(JSON.stringify({ type: 'viewer-authorized', viewerId }));
  }
}

// ── VPS SFU Connection ────────────────────────────────────────────────────────

/**
 * Establishes a WebSocket connection to the remote VPS/NAS SFU router.
 * Authenticates with vpsMasterKey, then pipes all WebCodecs binary chunks
 * to the server. Incoming JSON messages from the server (viewer inputs) are
 * routed to the local input dispatcher.
 * @param {{ vpsEnabled: boolean, vpsUrl: string, vpsMasterKey: string }} cfg
 */
// ── VPS URL Sanitizer ────────────────────────────────────────────────
// Rules (per spec):
//  1. Strip any http(s):// or ws(s):// prefix the user may have pasted
//  2. Force wss:// for domain names (contain a TLD) or if page is served over HTTPS
//  3. Use ws:// for raw IPs, localhost, or 127.0.0.1
//  4. Preserve any :port suffix exactly as typed
function sanitizeVpsUrl(raw) {
  if (!raw) return '';
  // Strip all known scheme prefixes
  let host = raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/^wss?:\/\//i, '')
    .replace(/^https?:\/\//i, '');
  // Separate host and port
  const portMatch = host.match(/:([\d]+)$/);
  const port = portMatch ? portMatch[0] : ''; // e.g. ':9000'
  const base = portMatch ? host.slice(0, -port.length) : host;
  // Choose scheme
  const isRawIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(base);
  const isLocal = base === 'localhost' || base === '127.0.0.1';
  const isSecurePage = typeof location !== 'undefined' && location.protocol === 'https:';
  const scheme = (isRawIp || isLocal) && !isSecurePage ? 'ws' : 'wss';
  return `${scheme}://${base}${port}`;
}

function connectVps(cfg) {
  if (_vpsWs) {
    try {
      _vpsWs.close();
    } catch (_) {}
    _vpsWs = null;
  }
  _vpsConfig = cfg;
  _vpsAuthOk = false;

  if (!cfg.vpsEnabled || !cfg.vpsUrl) return;

  const url = sanitizeVpsUrl(cfg.vpsUrl);
  log('VPS: Connecting to ' + url, 'ok');

  _vpsWs = new WebSocket(url);
  _vpsWs.binaryType = 'arraybuffer';

  _vpsWs.onopen = () => {
    // Tell the VPS router who we are
    _vpsWs.send(
      JSON.stringify({
        type: 'auth',
        role: 'host',
        key: cfg.vpsMasterKey,
      })
    );
    log('VPS: Authenticating...', 'ok');
  };

  _vpsWs.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch (_) {
        return;
      }

      if (msg.type === 'auth-ok') {
        _vpsAuthOk = true;
        log('VPS: Authenticated — SFU mode active', 'ok');
        _vpsWs.send(JSON.stringify({ type: 'set-pin', enabled: pinEnabled }));
        _vpsWs.send(JSON.stringify({ type: 'stream-idle', pinRequired: pinEnabled }));

        try {
          const wsUrl = new URL(_vpsConfig.vpsUrl);
          const scheme = wsUrl.protocol === 'wss:' ? 'https' : 'http';
          const origin = scheme + '://' + wsUrl.host;
          // Read hostName from config API — displayHostName element may not be populated yet
          loadAppConfig()
            .then((cfg) => {
              const hostParam = encodeURIComponent(cfg.hostName || 'Host');
              const pSelect = document.getElementById('pipelineSelect');
              const pipeArg =
                pSelect && pSelect.value === 'custom_webcodecs'
                  ? '&wc=2'
                  : pSelect && pSelect.value === 'webcodecs'
                    ? '&wc=1'
                    : pSelect && pSelect.value === 'webtransport'
                      ? '&wt=1'
                      : '';
              const viewerUrl = origin + '/?v3&host=' + hostParam + pipeArg;
              window._globalTunnelUrl = viewerUrl;
              const el = document.getElementById('urlList');
              if (el) {
                el.innerHTML = '';
                const div = document.createElement('div');
                div.className = 'url-row';
                div.style.color = 'var(--accent)';
                div.textContent = viewerUrl;
                div.onclick = () => {
                  navigator.clipboard.writeText(viewerUrl).catch(() => {});
                  const tmp = div.textContent;
                  div.textContent = 'copied!';
                  setTimeout(() => {
                    div.textContent = tmp;
                  }, 1500);
                };
                const sub = document.createElement('div');
                sub.className = 'url-label';
                sub.textContent = 'VPS SFU — share this';
                el.appendChild(div);
                el.appendChild(sub);
              }
            })
            .catch(() => {});
        } catch (_) {}
        return;
      }

      if (msg.type === 'auth-fail') {
        log('VPS: Authentication failed — check master key', 'err');
        _vpsWs.close();
        return;
      }

      // Rust router uses kebab-case field names — normalise to camelCase
      // before forwarding to the local server WebSocket dispatcher.
      const viewerId = msg['viewer-id'] || msg.viewer_id || msg.viewerId;

      // viewer-joined: fired only after PIN authorization in the waiting room.
      if (msg.type === 'viewer-joined' && viewerId) {
        const pending = _pendingVpsViewers.get(viewerId) || { name: 'Viewer', region: '' };
        _pendingVpsViewers.delete(viewerId);
        if (pending.region) _viewerRegions[viewerId] = pending.region;
        log('VPS viewer authorized: ' + viewerId, 'ok');
        if (ws && ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: 'vps-viewer-join',
              viewerId,
              name: pending.name,
              viewerRegion: pending.region,
              isDesktopApp: pending.isDesktopApp,
            })
          );
        }
        sendVpsViewerBootstrap(viewerId);
        return;
      }

      // viewer-left: viewer disconnected from VPS.
      if (msg.type === 'viewer-left' && viewerId) {
        log('VPS viewer disconnected: ' + viewerId, 'warn');
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'vps-viewer-leave', viewerId }));
        }
        return;
      }

      // viewer-input: viewer sent text input (gamepad/kbm/join/pin).
      // The Rust router injects viewer_id — parse the inner payload and
      // stamp the viewerId so the local server can route it correctly.
      if (msg.type === 'viewer-input' && viewerId && msg.payload) {
        if (!_checkPps(viewerId)) return;
        let inner;
        try {
          inner = JSON.parse(msg.payload);
        } catch (_) {
          return;
        }

        if (inner.type === 'join') {
          handleVpsJoin(viewerId, inner);
          return;
        }
        if (inner.type === 'request-keyframe') {
          forceWebCodecsKeyframe();
          if (_lastWcConfig) vpsDispatch(viewerId, _lastWcConfig);
          return;
        }

        // Unconditionally stamp the viewer ID so the server can map it to a slot and prevent stale IDs
        inner.viewerId = viewerId;
        inner.viewer_id = viewerId;
        if (inner.type === 'gamepad' && !inner.pad_id) inner.pad_id = viewerId + '_0';

        if (
          inner.type === 'answer' ||
          inner.type === 'ice-viewer' ||
          inner.type === 'viewer-mic-ready' ||
          inner.type === 'viewer-vr-active'
        ) {
          inner._viewerId = viewerId;
          // Feed directly to the local host's websocket handler so it processes the WebRTC handshake
          if (ws && typeof ws.onmessage === 'function') {
            ws.onmessage({ data: JSON.stringify(inner) });
          }
          return;
        }

        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify(inner));
        }
        return;
      }
    }
  };

  _vpsWs.onclose = (e) => {
    _vpsAuthOk = false;
    log('VPS: Disconnected (code ' + e.code + '). Retrying in 5s...', 'warn');
    setTimeout(() => {
      if (_vpsConfig?.vpsEnabled) connectVps(_vpsConfig);
    }, 5000);
  };

  _vpsWs.onerror = () => {
    log('VPS: Connection error', 'err');
  };
}

/** Tear down VPS connection cleanly (called from stopCapture). */
function disconnectVps() {
  if (_vpsWs) {
    try {
      _vpsWs.close(1000, 'host-stopped');
    } catch (_) {}
    _vpsWs = null;
  }
  _vpsAuthOk = false;
}

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    vpsDispatch,
    sendVpsViewerBootstrap,
    handleVpsJoin,
    sanitizeVpsUrl,
    connectVps,
    disconnectVps,
  };
}
