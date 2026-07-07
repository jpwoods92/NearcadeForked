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
    authEndpoint: 'https://nearsec.cutefame.net/api/pusher-auth'
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
const hostSessionId = 'ns-' + Math.random().toString(36).substr(2, 9);

let isArcade = false;
const arcadeConfig = {
    title: localStorage.getItem('ns_arcade_title') || 'Unknown Game',
    desc: localStorage.getItem('ns_arcade_desc') || '',
    thumbnail: localStorage.getItem('ns_arcade_thumb') || '',
    maxPlayers: localStorage.getItem('ns_arcade_maxPlayers') || '4',
    requirePin: localStorage.getItem('ns_arcade_requirePin') === 'true'
};


async function startArcadeSession() {
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

    arcadeConfig.thumbnail = await fetchGameThumbnail(arcadeConfig.title);

    localStorage.setItem('ns_arcade_title', arcadeConfig.title);
    localStorage.setItem('ns_arcade_desc', arcadeConfig.desc);
    localStorage.setItem('ns_arcade_thumb', arcadeConfig.thumbnail);
    localStorage.setItem('ns_arcade_maxPlayers', arcadeConfig.maxPlayers);
    localStorage.setItem('ns_arcade_requirePin', arcadeConfig.requirePin);

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
        pinDisplay.innerHTML = '<span style="color:var(--green); font-size:14px; font-weight:800; letter-spacing:0.05em;">Arcade Session</span>';
    }
}

const getHostOS = () => {
    const ua = navigator.userAgent;
    if (ua.includes("Win")) return "Windows";
    if (ua.includes("Mac")) return "macOS";
    if (ua.includes("Linux")) return "Linux";
    return "Unknown OS";
};

function _doArcadeRegister() {
    fetch('/api/info').then(r => r.json()).then(info => {
        if (!info.tunnelUrl) {
            log(I18N.t('⚠ Arcade: No tunnel URL yet. Start a tunnel first, then launch Arcade.'), 'warn');
            return;
        }
        log(I18N.t('Arcade Mode: ${arcadeConfig.title} (${arcadeConfig.maxPlayers} players) → ${info.tunnelUrl}').replace('${arcadeConfig.title}', arcadeConfig.title).replace('${arcadeConfig.maxPlayers}', arcadeConfig.maxPlayers).replace('${info.tunnelUrl}', info.tunnelUrl), 'ok');

        if (info.tunnelUrl && !info.tunnelUrl.includes('voiceMode')) {
            const _sep = info.tunnelUrl.includes('?') ? '&' : '?';
            info.tunnelUrl += _sep + 'voiceMode=' + (arcadeConfig.captureMic ? 'push-to-talk' : 'off');
        }
        if (!arcadeConfig.requirePin && pinEnabled) {
            pinEnabled = false;
            arcadeOverrodePin = true;
            const btn = document.getElementById('pinToggle');
            if (btn) { btn.textContent = 'OFF'; btn.className = 'pin-toggle-btn'; }
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'set-pin', enabled: false }));
            if (typeof _vpsWs !== 'undefined' && _vpsWs && _vpsWs.readyState === 1) _vpsWs.send(JSON.stringify({ type: 'set-pin', enabled: false }));
            log(I18N.t('PIN disabled for Arcade session'), 'ok');
        }

        const getPingData = () => ({
            id: hostSessionId,
            game: arcadeConfig.title,
            thumbnail: arcadeConfig.thumbnail,
            hasPin: arcadeConfig.requirePin,
            url: info.tunnelUrl,
            hostRegion,
            region: `${knownViewers.size + 1}/${arcadeConfig.maxPlayers} Players • ${getHostOS()}`
        });

        arcadeChannel.trigger('client-session-ping', getPingData());
        sysChat(I18N.t('Arcade Mode started:') + ' ' + arcadeConfig.title);
        document.getElementById('btnArcade').innerHTML = '<span style="color:var(--green); font-weight:bold; font-size: 10px;">ARCADE<br>LIVE</span>';

        if (arcadePingInterval) clearInterval(arcadePingInterval);
        arcadePingInterval = setInterval(() => {
            arcadeChannel.trigger('client-session-ping', getPingData());
        }, 10000);

        isArcade = true;
        _updateDiscordRPC();

    }).catch(() => log(I18N.t('Arcade: Could not read server info'), 'err'));
}

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { startArcadeSession, getHostOS, _doArcadeRegister };
}
