// ── TUNNEL MODAL (host.js only) ─────────────────────────────────────────────
// Loaded via a <script> tag before host.js, same pattern as the other
// scripts/**/*.js modules (after ui/modals.js — this modal's chrome, like
// closeAllModals()/resetTunnelModal(), is called from here). Covers the
// cloudflared/VPS/P2P tunnel-selection flow: opening the modal, per-provider
// confirm handling, the P2P-only path (including Trystero P2PManager
// wiring), and checking for an existing tunnel on connect.
// See REFACTOR_PLAN.md Phase 5.8.

let _tunnelBusy = false;

function setTunnelBusy(busy) {
  _tunnelBusy = busy;
  document.querySelectorAll('.provider-card, #tunnelModal .modal-footer button').forEach((el) => {
    el.style.pointerEvents = busy ? 'none' : '';
    el.style.opacity = busy ? '0.5' : '';
  });
}

let _tunnelModalManual = false; // set when the user manually opens the tunnel modal

function showTunnelModal(isManual) {
  closeAllModals();
  resetTunnelModal();
  document.getElementById('tunnelModal').classList.remove('gone');
  if (isManual) _tunnelModalManual = true;

  loadAppConfig()
    .then((cfg) => {
      if (!cfg) return;
      const rememberBox = document.getElementById('rememberCheck');
      if (rememberBox) rememberBox.checked = !!cfg.neverAsk;

      if (cfg.tunnelProvider) {
        const radio = document.querySelector('input[name="provider"][value="' + cfg.tunnelProvider + '"]');
        if (radio) {
          radio.checked = true;
          document.querySelectorAll('.provider-card').forEach((c) => {
            c.classList.toggle('selected', c.querySelector('input').checked);
          });
        }
      }
      if (cfg.tunnelProvider === 'vps' && cfg.vpsHost) {
        const vpsInput = document.getElementById('vpsHostInput');
        if (vpsInput) vpsInput.value = cfg.vpsHost;
      }
      // Always restore VPS SFU fields — they should persist regardless of
      // which provider is currently selected, so switching away and back
      // never clears the URL and key the user already entered.
      if (window.electronAPI && typeof window.electronAPI.getVpsConfig === 'function') {
        window.electronAPI
          .getVpsConfig()
          .then((vpsCfg) => {
            if (!vpsCfg) return;
            const urlEl = document.getElementById('vpsUrlInput');
            const keyEl = document.getElementById('vpsKeyInput');
            if (urlEl && vpsCfg.vpsUrl) urlEl.value = vpsCfg.vpsUrl;
            if (keyEl && vpsCfg.vpsMasterKey) keyEl.value = vpsCfg.vpsMasterKey;
          })
          .catch(() => {});
      }
    })
    .catch(() => {});

  document.querySelectorAll('.provider-card').forEach((c) => {
    c.classList.toggle('selected', c.querySelector('input').checked);
  });
}

function resetTunnelModal() {
  document.getElementById('tunnelLoading').classList.add('gone');
  document.getElementById('tunnelSpinner').classList.remove('gone');
  document.getElementById('tunnelErrorText').classList.add('gone');
  document.getElementById('tunnelRetryBtn').classList.add('gone');
}
function closeTunnelModal() {
  _tunnelModalManual = false;
  document.getElementById('tunnelModal').classList.add('gone');
  setTunnelBusy(false);
  resetTunnelModal();
}
function showTunnelError(msg) {
  setTunnelBusy(false);
  document.getElementById('tunnelSpinner').classList.add('gone');
  document.getElementById('tunnelLoadText').textContent = 'Connection Failed';
  document.getElementById('tunnelErrorText').textContent = msg;
  document.getElementById('tunnelErrorText').classList.remove('gone');
  document.getElementById('tunnelRetryBtn').classList.remove('gone');
}

function copyCmdText(e, el) {
  e.preventDefault();
  e.stopPropagation();
  const cmd = el.innerText;
  navigator.clipboard.writeText(cmd).then(() => {
    const orig = el.innerText;
    el.innerText = 'Copied!';
    el.style.color = 'var(--accent)';
    setTimeout(() => {
      el.innerText = orig;
      el.style.color = '';
    }, 1000);
  });
}

function copyCmd(e, cmd, el = null) {
  e.stopPropagation();
  let finalCmd = cmd;
  if (cmd.includes('VPS')) {
    const host = document.getElementById('vpsHostInput')?.value?.trim() || 'VPS';
    finalCmd = cmd.replace('VPS', host);
  }
  navigator.clipboard.writeText(finalCmd).then(() => {
    if (el && el.tagName.toLowerCase() === 'code') {
      const orig = el.innerText;
      el.innerText = 'Copied!';
      el.style.color = 'var(--accent)';
      setTimeout(() => {
        el.innerText = orig;
        el.style.color = 'var(--muted)';
      }, 1000);
    } else {
      const btn = e.target;
      const orig = btn.textContent;
      btn.textContent = '✓';
      btn.style.borderColor = 'var(--accent)';
      setTimeout(() => {
        btn.textContent = orig;
        btn.style.borderColor = '#4e5058';
      }, 1000);
    }
  });
}

function confirmTunnel() {
  if (_tunnelBusy) return;
  const radio = document.querySelector('input[name="provider"]:checked');
  if (!radio) return;
  const provider = radio.value;
  const remember = document.getElementById('rememberCheck').checked;
  setTunnelBusy(true);

  if (provider === 'portforward') {
    if (remember) {
      saveAppConfig({ tunnelProvider: 'portforward', neverAsk: true });
    }
    setTunnelBusy(false);
    closeTunnelModal();
    log(I18N.t('Using direct Port Forwarding. Share your Public IP URL.'), 'ok');
    return;
  }

  // ── Dedicated VPS SFU ─────────────────────────────────────────────────────
  if (provider === 'vps-sfu') {
    const vpsUrl = (document.getElementById('vpsUrlInput')?.value || '').trim();
    const vpsMasterKey = (document.getElementById('vpsKeyInput')?.value || '').trim();

    if (!vpsUrl) {
      setTunnelBusy(false);
      showTunnelError('Please enter a WebSocket URL for your VPS (e.g. ws://your-vps-ip:9000)');
      return;
    }
    if (!vpsMasterKey) {
      setTunnelBusy(false);
      showTunnelError('Please enter the Master Key configured on your VPS.');
      return;
    }

    const vpsCfg = { vpsEnabled: true, vpsUrl, vpsMasterKey };

    if (window.electronAPI && typeof window.electronAPI.saveVpsConfig === 'function') {
      window.electronAPI.saveVpsConfig(vpsCfg);
    }
    if (remember) {
      saveAppConfig({ tunnelProvider: 'vps-sfu', neverAsk: true });
    }

    // Clear P2P UI locks
    window._isP2P = false;
    window._p2pCode = null;
    const pinRow = document.querySelector('.pin-row');
    if (pinRow) {
      pinRow.style.opacity = '1';
      pinRow.style.pointerEvents = 'auto';
      document.getElementById('pinVal').textContent = currentPin || '----';
    }

    connectVps(vpsCfg);
    setTunnelBusy(false);
    closeTunnelModal();
    log('VPS SFU enabled — connecting to ' + vpsUrl, 'ok');
    return;
  }
  // ── End VPS SFU path ──────────────────────────────────────────────────────

  // Switching away from VPS SFU to any standard tunnel provider — tear down VPS
  if (typeof disconnectVps === 'function') {
    disconnectVps();
    if (window.electronAPI && typeof window.electronAPI.saveVpsConfig === 'function') {
      window.electronAPI.saveVpsConfig({ vpsEnabled: false });
    }
  }

  // Close the modal immediately — the tunnel URL will render via WS when ready.
  // Also schedule a guaranteed close after 5s in case of slow tunnel startup.
  setTunnelBusy(false);
  closeTunnelModal();
  let _autoCloseTimer = setTimeout(() => {
    closeTunnelModal();
  }, 5000);

  log(I18N.t('Starting') + ' ' + provider + ' tunnel' + (remember ? ' (saved)' : '') + '...', 'ok');

  // Clear any active P2P flags so renderUrls displays the HTTPS link again
  window._isP2P = false;
  window._p2pCode = null;
  const pinRow2 = document.querySelector('.pin-row');
  if (pinRow2) {
    pinRow2.style.opacity = '1';
    pinRow2.style.pointerEvents = 'auto';
    document.getElementById('pinVal').textContent = currentPin || '----';
  }

  fetch('/api/start-tunnel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, remember, vpsHost: document.getElementById('vpsHostInput')?.value?.trim() }),
  })
    .then(() => {
      clearTimeout(_autoCloseTimer);
    })
    .catch(() => {
      clearTimeout(_autoCloseTimer);
      showTunnelError(I18N.t('Network request failed'));
    });
}

function startP2POnly() {
  if (_tunnelBusy) return;

  if (localStorage.getItem('p2pWarned')) {
    proceedP2POnly();
    return;
  }
  closeTunnelModal();
  document.getElementById('p2pWarningModal').classList.remove('gone');
}

function proceedP2POnly() {
  localStorage.setItem('p2pWarned', 'true');

  const remember = document.getElementById('rememberCheck').checked;

  // Switch away from VPS SFU if it was active
  if (typeof disconnectVps === 'function') {
    disconnectVps();
    if (window.electronAPI && typeof window.electronAPI.saveVpsConfig === 'function') {
      window.electronAPI.saveVpsConfig({ vpsEnabled: false });
    }
  }

  if (remember) {
    saveAppConfig({ tunnelProvider: 'p2p', neverAsk: true });
  }

  // Generate a random 12-char room code
  const array = new Uint32Array(2);
  crypto.getRandomValues(array);
  const code = array[0].toString(36).padStart(6, '0') + '-' + array[1].toString(36).padStart(6, '0');

  // Set the global P2P flags for renderUrls to consume
  window._isP2P = true;
  window._p2pCode = code;

  // Force PIN off for P2P mode (the 12-char room code acts as the security)
  pinEnabled = false;
  const pinRow = document.querySelector('.pin-row');
  if (pinRow) {
    pinRow.style.opacity = '0.3';
    pinRow.style.pointerEvents = 'none';
    const pVal = document.getElementById('pinVal');
    if (pVal) pVal.textContent = 'P2P';
    const pTog = document.getElementById('pinToggle');
    if (pTog) {
      pTog.textContent = 'OFF';
      pTog.classList.remove('on');
    }
  }

  // Immediately trigger a UI refresh so the Room Code is displayed
  fetch('/api/info')
    .then((r) => r.json())
    .then((d) => {
      renderUrls(d);
      if (typeof _updateDiscordRPC === 'function') _updateDiscordRPC();
    })
    .catch(() => {
      // Fallback if local Express server is unreachable
      renderUrls({ lanIP: '127.0.0.1', port: '4266' });
      if (typeof _updateDiscordRPC === 'function') _updateDiscordRPC();
    });

  log(I18N.t('Starting P2P tunnel') + (remember ? ' (saved)' : '') + '...', 'ok');

  // Initialize Trystero
  if (window.P2PManager) {
    window.P2PManager.initHost(code, (msg) => {
      // Check PIN locally since there's no server.js
      if (msg.type === 'join') {
        if (pinEnabled && msg.pin !== currentPin) {
          window.P2PManager.sendToPeer(msg.viewer_id || msg.viewerId, { type: 'pin-rejected' });
          return;
        }
        // Translate join to viewer-joined for host.js
        msg.type = 'viewer-joined';

        // Emulate server initialization packets so the Viewer hides the PIN screen
        window.P2PManager.sendToPeer(msg.viewer_id || msg.viewerId, {
          type: 'your-id',
          viewerId: msg.viewer_id || msg.viewerId,
        });
        window.P2PManager.sendToPeer(msg.viewer_id || msg.viewerId, {
          type: 'host-connected',
          hostName: 'P2P Host',
        });

        // Emulate server sending host-stream-ready if streaming
        if (currentStream) {
          window.P2PManager.sendToPeer(msg.viewerId || msg.viewer_id, {
            type: 'host-stream-ready',
            needsOffer: false, // Host sends offer
          });
        }

        // Forward join to server.js so the P2P viewer shows up in the Host UI roster
        if (ws && ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: 'vps-viewer-join',
              viewerId: msg.viewer_id || msg.viewerId,
              name: msg.name,
              viewerRegion: msg.viewerRegion,
              isDesktopApp: msg.isDesktopApp,
            })
          );
        }
      }

      if (msg.type === 'viewer-left') {
        if (ws && ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: 'vps-viewer-leave',
              viewerId: msg.viewer_id || msg.viewerId,
            })
          );
        }
      }

      // Let the existing websocket logic handle it
      if (ws && typeof ws.onmessage === 'function') {
        // Ensure _viewerId exists for existing routing logic
        if (msg.viewer_id && !msg._viewerId) msg._viewerId = msg.viewer_id;
        if (msg.viewerId && !msg._viewerId) msg._viewerId = msg.viewerId;
        // We must unconditionally map the P2P peerId into viewerId so the Host routes the offer correctly!
        // If we don't, the Host will try to send the offer to the viewer's local session ID, which Trystero doesn't know about.
        if (msg.viewer_id) {
          msg._viewerId = msg.viewer_id;
          msg.viewerId = msg.viewer_id;
        }

        ws.onmessage({ data: JSON.stringify(msg) });
      }
    });

    log(I18N.t('P2P tunnel ready! Waiting for viewers...'), 'ok');
  }

  closeTunnelModal();
}

document.querySelectorAll('input[name="provider"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (_tunnelBusy) return;
    document.querySelectorAll('.provider-card').forEach((c) => {
      c.classList.toggle('selected', c.querySelector('input').checked);
    });
  });
});
document.querySelectorAll('.provider-card').forEach((card) => {
  card.addEventListener('click', () => {
    if (_tunnelBusy) return;
    const input = card.querySelector('input');
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    document
      .querySelectorAll('.provider-card')
      .forEach((c) => c.classList.toggle('selected', c.querySelector('input').checked));
  });
});

async function checkTunnelOnConnect() {
  if (_vpsConfig && _vpsConfig.vpsEnabled) {
    const el = document.getElementById('urlList');
    if (el && !el.querySelector('.url-row')) {
      el.innerHTML = '<div style="color:var(--muted);font-size:10px;padding:4px 0;">VPS SFU mode — connecting...</div>';
    }
    return;
  }
  try {
    const info = await fetch('/api/info').then((r) => r.json());
    // ALWAYS render whatever URL the server already has, regardless of neverAsk.
    // Previously this bailed when neverAsk:true, leaving the UI stuck on boot.
    if (info.tunnelUrl) {
      renderUrls(info);
      return;
    }
    // No tunnel yet — only prompt for one if the user hasn't chosen "never ask"
    const cfg = await loadAppConfig();
    if (cfg.tunnelProvider === 'p2p') {
      startP2POnly(true);
    } else if (!cfg.neverAsk) {
      showTunnelModal();
    }
  } catch {}
}

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    setTunnelBusy,
    showTunnelModal,
    resetTunnelModal,
    closeTunnelModal,
    showTunnelError,
    copyCmdText,
    copyCmd,
    confirmTunnel,
    startP2POnly,
    proceedP2POnly,
    checkTunnelOnConnect,
  };
}
