// ── ARCADE REGISTRATION (host.js only) ─────────────────────────────────────
// Loaded via a <script> tag before host.js, same pattern as the other
// scripts/**/*.js modules. Pusher client init/subscribe, the arcade modal's
// "Go Live" flow (startArcadeSession/_doArcadeRegister), and the periodic
// ping that keeps the session listed on the Nearsec Arcade site.
//
// Modal open/close chrome (showArcadeModal/closeArcadeModal) already lives
// in scripts/ui/modals.js (Phase 5.4) — this file is the registration logic
// behind the "Go Live" button, not the dialog itself.
//
// This app key/cluster/authEndpoint and the 'private-arcade-global' channel
// name are also hardcoded server-side in server/arcade-signaling.js (Phase
// 3) — there's no shared-constants module linking them today since one runs
// in the browser and the other in Node with no bundler between them. Keep
// both in sync by hand if either changes. See REFACTOR_PLAN.md Phase 5.7.

Pusher.logToConsole = false;
const pusher = new Pusher('a93f5405058cd9fc7967', {
  cluster: 'us2',
  authEndpoint: 'https://nearcade.cutefame.net/api/pusher-auth',
});
const arcadeChannel = pusher.subscribe('private-arcade-global');

// ── NEW: Catch the Ban 403 error and alert the Host ──
arcadeChannel.bind('pusher:subscription_error', (status) => {
  if (status === 403) {
    log(I18N.t('Arcade Error: Your IP is banned from the network.'), 'err');

    // Change the Arcade Live button to show the ban
    const btnArcade = document.getElementById('btnArcade');
    if (btnArcade) {
      btnArcade.innerHTML = '<span style="color:var(--danger); font-weight:bold; font-size: 11px;">BANNED</span>';
    }

    // Stop the ping interval so it doesn't spam the banned endpoint
    if (arcadePingInterval) {
      clearInterval(arcadePingInterval);
      arcadePingInterval = null;
    }
  }
});
// ─────────────────────────────────────────────────────

let arcadePingInterval = null;
let arcadeOverrodePin = false;
const hostSessionId =
  'ns-' +
  (window.crypto?.randomUUID ? window.crypto.randomUUID().slice(0, 9) : Math.random().toString(36).substr(2, 9));

let isArcade = false;
const arcadeConfig = {
  title: localStorage.getItem('ns_arcade_title') || 'Unknown Game',
  desc: localStorage.getItem('ns_arcade_desc') || '',
  thumbnail: localStorage.getItem('ns_arcade_thumb') || '',
  maxPlayers: localStorage.getItem('ns_arcade_maxPlayers') || '4',
  requirePin: localStorage.getItem('ns_arcade_requirePin') === 'true',
  category: localStorage.getItem('ns_arcade_category') || '',
};

async function startArcadeSession() {
  if (typeof appConfig !== 'undefined' && appConfig.hidmaestro) {
    log(
      I18N.t(
        'Arcade mode is not compatible with the HIDMaestro backend. Disable HIDMaestro in Settings to host Arcade sessions.'
      ),
      'err'
    );
    const overlay = document.createElement('div');
    overlay.id = 'arcadeHmConflict';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `<div style="background:#121518;border:1px solid var(--warn);border-radius:12px;padding:32px;max-width:440px;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,0.8);font-family:sans-serif;">
        <h2 style="color:var(--warn);margin:0 0 12px 0;font-size:15px;">HIDMaestro Conflicts With Arcade</h2>
        <p style="color:#949ba4;font-size:13px;line-height:1.6;margin:0 0 6px 0;">
            The HIDMaestro virtual controller backend is not compatible with Arcade mode.
        </p>
        <p style="color:#949ba4;font-size:13px;line-height:1.6;margin:0 0 20px 0;">
            Disable it in <strong>Settings → HIDMaestro Virtual Controller</strong> to host Arcade sessions.
        </p>
        <button onclick="this.closest('[id=arcadeHmConflict]').remove()" style="padding:10px 28px;border-radius:6px;border:none;background:var(--accent);color:#000;font-weight:600;cursor:pointer;">OK</button>
    </div>`;
    document.body.appendChild(overlay);
    closeArcadeModal();
    return;
  }
  const provider = document.querySelector('input[name="provider"]:checked');
  if (provider && provider.value === 'p2p') {
    log(I18N.t('Arcade mode is not supported over P2P tunnels.'), 'err');
    closeArcadeModal();
    return;
  }
  arcadeConfig.title = document.getElementById('arcadeGameTitle').value.trim() || 'Arcade Game';
  arcadeConfig.desc = document.getElementById('arcadeGameDesc').value.trim();
  arcadeConfig.maxPlayers = document.getElementById('arcadeMaxPlayers').value;
  arcadeConfig.requirePin = document.getElementById('arcadeRequirePin').checked;
  arcadeConfig.category = document.getElementById('arcadeCategory')?.value || '';

  arcadeConfig.thumbnail = await fetchGameThumbnail(arcadeConfig.title);

  localStorage.setItem('ns_arcade_title', arcadeConfig.title);
  localStorage.setItem('ns_arcade_desc', arcadeConfig.desc);
  localStorage.setItem('ns_arcade_thumb', arcadeConfig.thumbnail);
  localStorage.setItem('ns_arcade_maxPlayers', arcadeConfig.maxPlayers);
  localStorage.setItem('ns_arcade_requirePin', arcadeConfig.requirePin);
  localStorage.setItem('ns_arcade_category', arcadeConfig.category);

  closeArcadeModal();

  const needsCapture = !currentStream;
  if (needsCapture) {
    startCapture().then(() => _doArcadeRegister());
  } else {
    _doArcadeRegister();
  }

  // Lock PIN controls while arcade session is live
  const pinSwitch = document.getElementById('arcadeRequirePin');
  const pinDisplay = document.getElementById('pinVal');
  if (pinSwitch) {
    pinSwitch.disabled = true;
    pinSwitch.title = 'Cannot change PIN while session is live';
  }
  if (pinDisplay) {
    pinDisplay.dataset.originalPin = pinDisplay.textContent;
    // Inject a smaller, green badge style instead of plain text
    pinDisplay.innerHTML =
      '<span style="color:var(--green); font-size:14px; font-weight:800; letter-spacing:0.05em;">Arcade Session</span>';
  }
}

const getHostOS = () => {
  const ua = navigator.userAgent;
  if (ua.includes('Win')) return 'Windows';
  if (ua.includes('Mac')) return 'macOS';
  if (ua.includes('Linux')) return 'Linux';
  return 'Unknown OS';
};

function _doArcadeRegister() {
  fetch('/api/info')
    .then((r) => r.json())
    .then((info) => {
      if (!info.tunnelUrl) {
        log(I18N.t('⚠ Arcade: No tunnel URL yet. Start a tunnel first, then launch Arcade.'), 'warn');
        return;
      }
      log(
        I18N.t('Arcade Mode: ${arcadeConfig.title} (${arcadeConfig.maxPlayers} players) → ${info.tunnelUrl}')
          .replace('${arcadeConfig.title}', arcadeConfig.title)
          .replace('${arcadeConfig.maxPlayers}', arcadeConfig.maxPlayers)
          .replace('${info.tunnelUrl}', info.tunnelUrl),
        'ok'
      );

      if (info.tunnelUrl && !info.tunnelUrl.includes('voiceMode')) {
        const _sep = info.tunnelUrl.includes('?') ? '&' : '?';
        info.tunnelUrl += _sep + 'voiceMode=' + (arcadeConfig.captureMic ? 'push-to-talk' : 'off');
      }
      // Disable PIN toggle while arcade is active
      const pinToggle = document.getElementById('pinToggle');
      if (pinToggle) {
        pinToggle.disabled = true;
        pinToggle.style.opacity = '0.4';
        pinToggle.style.cursor = 'not-allowed';
      }

      if (!arcadeConfig.requirePin && pinEnabled) {
        pinEnabled = false;
        arcadeOverrodePin = true;
        if (pinToggle) {
          pinToggle.textContent = 'OFF';
          pinToggle.className = 'pin-toggle-btn';
        }
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'set-pin', enabled: false }));
        if (typeof _vpsWs !== 'undefined' && _vpsWs && _vpsWs.readyState === 1)
          _vpsWs.send(JSON.stringify({ type: 'set-pin', enabled: false }));
        log(I18N.t('PIN disabled for Arcade session'), 'ok');
      }

      const getPingData = () => {
        const pipelineVal = document.getElementById('pipelineSelect')?.value;
        const forceWc =
          new URLSearchParams(window.location.search).get('wc') === '1' ||
          pipelineVal === 'webcodecs' ||
          pipelineVal === 'custom_webcodecs';
        const codec = localStorage.getItem('ns_codec') || document.getElementById('codecSelect')?.value || 'Auto';
        return {
          id: hostSessionId,
          game: arcadeConfig.title,
          hostName: localStorage.getItem('ns_name') || '',
          thumbnail: arcadeConfig.thumbnail,
          hasPin: arcadeConfig.requirePin,
          url: info.tunnelUrl,
          version: window.NEARSEC_VERSION || '0.0.0',
          hostRegion,
          os: getHostOS(),
          codecType: forceWc ? 'WebCodecs' : 'WebRTC',
          codec,
          category: arcadeConfig.category,
          region: `${knownViewers.size + 1}/${arcadeConfig.maxPlayers} Players`,
        };
      };

      arcadeChannel.trigger('client-session-ping', getPingData());

      // One-shot registration with the arcade directory (KV session tracking
      // + Discord embed on the Cloudflare Worker, upstream v3.0.2). Sent once
      // — every POST can fire a webhook embed, so this must not be on the
      // 10s interval below.
      fetch('https://nearcade.cutefame.net/api/arcade/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(getPingData()),
      }).catch((e) => console.error('[Arcade] Server ping failed:', e));

      sysChat(I18N.t('Arcade Mode started:') + ' ' + arcadeConfig.title);
      document.getElementById('btnArcade').innerHTML =
        '<span style="color:var(--green); font-weight:bold; font-size: 10px;">ARCADE<br>LIVE</span>';

      if (arcadePingInterval) clearInterval(arcadePingInterval);
      arcadePingInterval = setInterval(() => {
        arcadeChannel.trigger('client-session-ping', getPingData());
      }, 10000);

      isArcade = true;
      _updateDiscordRPC();
    })
    .catch(() => log(I18N.t('Arcade: Could not read server info'), 'err'));
}

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { startArcadeSession, getHostOS, _doArcadeRegister };
}
