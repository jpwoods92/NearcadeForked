// ── DASHBOARD PAGE LOGIC ─────────────────────────────────────────────────────
// Loaded via a <script> tag from dashboard.html — the control-panel page's
// app logic (version/update checks, tab switching, settings sync, direct-link
// join, about/docs modals). Extracted from two inline <script> blocks per
// REFACTOR_PLAN.md Phase 7; page-specific, not shared with host.js/viewer.js.
document.addEventListener('DOMContentLoaded', async () => {
  const vEl = document.getElementById('version-text');
  const cEl = document.getElementById('commit-hash');
  if (window.electronAPI) {
    const { version, commit } = await window.electronAPI.getVersion();
    window.NEARSEC_VERSION = version;
    vEl.innerHTML = `v${version} <span style="opacity:0.5; margin-left:4px;">${commit}</span>`;
    if (typeof checkForUpdates === 'function') checkForUpdates(version);

    window.electronAPI.onUpdateReady((latestVersion) => {
      document.getElementById('updateVersion').textContent = latestVersion;
      document.getElementById('currentVersionModal').textContent = version;
      const dlBtn = document.querySelector('#updateModal .btn-primary');
      dlBtn.textContent = 'Restart & Install';
      dlBtn.onclick = () => {
        window.electronAPI.installUpdate();
      };
      document.getElementById('updateModal').style.display = 'flex';
    });
  } else {
    if (window.NEARSEC_VERSION && vEl) vEl.textContent = 'v' + window.NEARSEC_VERSION;
    if (window.NEARSEC_COMMIT && cEl) cEl.textContent = window.NEARSEC_COMMIT;
  }
});

async function checkForUpdates(currentVersion) {
  let cfg = appConfig;
  if (window.electronAPI) {
    // Electron-updater handles background checking automatically.
    return;
  }

  if (cfg.checkForUpdates === false) return;

  try {
    const res = await fetch('https://api.github.com/repos/TheRealFame/NearsecTogether/releases/latest');
    if (!res.ok) return;
    const data = await res.json();
    const latest = data.tag_name;
    if (!latest) return;

    let pa = latest.replace(/[^0-9.]/g, '').split('.');
    let pb = currentVersion.replace(/[^0-9.]/g, '').split('.');
    let isNewer = false;
    for (let i = 0; i < 3; i++) {
      let na = Number(pa[i] || 0);
      let nb = Number(pb[i] || 0);
      if (na > nb) {
        isNewer = true;
        break;
      }
      if (nb > na) break;
    }

    if (isNewer) {
      document.getElementById('updateVersion').textContent = latest;
      document.getElementById('currentVersionModal').textContent = currentVersion;
      document.getElementById('updateModal').style.display = 'flex';
    }
  } catch (e) {
    console.error('Update check failed:', e);
  }
}

function copyVersion() {
  const txt = 'v' + (window.NEARSEC_VERSION || 'unknown') + (window.NEARSEC_COMMIT ? '-' + window.NEARSEC_COMMIT : '');
  navigator.clipboard.writeText(txt).catch(() => {});
  const vEl = document.getElementById('version-text');
  const old = vEl.textContent;
  vEl.textContent = 'Copied!';
  setTimeout(() => {
    vEl.textContent = old;
  }, 1500);
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('collapsed');
}

function switchTab(name) {
  // Null-safe panel swap — if a panel doesn't exist, log and bail rather than crash
  const panel = document.getElementById('panel-' + name);
  if (!panel) {
    console.warn('[switchTab] No panel found for:', name);
    return;
  }
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach((t) => t.classList.remove('active'));
  panel.classList.add('active');
  document.getElementById('tab-' + name)?.classList.add('active');

  const docsBtn = document.getElementById('docsFloatBtn');
  if (docsBtn) {
    docsBtn.style.display = name === 'arcade' || name === 'settings' ? 'none' : 'flex';
  }

  const versionDisplay = document.getElementById('version-display');
  if (versionDisplay) {
    versionDisplay.style.display = name === 'arcade' ? 'none' : 'block';
  }

  const setupBtn = document.getElementById('floating-setup-btn');
  if (setupBtn && !window.IS_CLIENT_ONLY) {
    setupBtn.style.display = name === 'connect' ? 'flex' : 'none';
  }
}

let appConfig = {};

function _getServerPort() {
  return new URLSearchParams(window.location.search).get('port') || '3000';
}

function syncToNode() {
  const port = _getServerPort();
  fetch(`http://localhost:${port}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(appConfig),
  }).catch(() => {});
}

async function loadAndSyncSettings() {
  if (!window.electronAPI) return;
  appConfig = await window.electronAPI.getSettings();
  syncSettingsUI();
}

function syncSettingsUI() {
  if (document.getElementById('settingHostName')) {
    document.getElementById('settingHostName').value = appConfig.hostName || localStorage.getItem('ns_name') || '';
  }

  const uiSel = document.getElementById('hostUISelect');
  if (uiSel) {
    let savedUI = localStorage.getItem('ns_ui_version') || 'default';
    if (savedUI === 'new') savedUI = 'default';
    if (savedUI === 'old') savedUI = 'minimal';
    uiSel.value = savedUI;
  }

  document.getElementById('settingTrackRumble')?.classList.toggle('on', appConfig.rumble !== false);
  document.getElementById('settingTrackTray')?.classList.toggle('on', appConfig.tray !== false);
  document.getElementById('settingTrackCheckForUpdates')?.classList.toggle('on', appConfig.checkForUpdates !== false);
  document.getElementById('settingTrackAlwaysOnTop')?.classList.toggle('on', !!appConfig.alwaysOnTop);
  document.getElementById('settingTrackBootHost')?.classList.toggle('on', !!appConfig.bootToHost);
  document.getElementById('settingTrackDiscordRPC')?.classList.toggle('on', appConfig.discordRPC !== false);
  document.getElementById('settingTrackHWDecode')?.classList.toggle('on', appConfig.hwDecode !== false);
  document.getElementById('settingTrackFpsUnlock')?.classList.toggle('on', !!appConfig.fpsUnlock);
  document.getElementById('settingTrackVsyncOff')?.classList.toggle('on', !!appConfig.vsyncOff);
  document.getElementById('settingTrackZeroCopy')?.classList.toggle('on', !!appConfig.zeroCopy);
  document.getElementById('settingTrackAllowVR')?.classList.toggle('on', !!appConfig.allowVR);
  renderAutoHosts();
}

function saveLangAndReload(val) {
  appConfig.lang = val;
  if (window.electronAPI) window.electronAPI.saveSettings(appConfig);
  I18N.changeLanguage(val);
}

function saveHostName(val) {
  appConfig.hostName = val.trim();
  // Sync to standard local storage so Arcade and Viewer immediately see it
  localStorage.setItem('ns_name', appConfig.hostName);

  if (window.electronAPI) window.electronAPI.saveSettings(appConfig);
  syncToNode();
}

function toggleAppSetting(key) {
  if (['tray', 'hwDecode', 'discordRPC', 'rumble', 'checkForUpdates'].includes(key)) {
    appConfig[key] = appConfig[key] === false ? true : false;
  } else {
    appConfig[key] = !appConfig[key];
  }
  syncSettingsUI();
  if (window.electronAPI) {
    window.electronAPI.saveSettings(appConfig);
    if (key === 'alwaysOnTop') window.electronAPI.toggleAlwaysOnTop();
  }
  syncToNode();
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    document.getElementById('directLinkInput').value = text;
    document.getElementById('directLinkInput').focus();
  } catch {
    document.getElementById('directLinkErr').textContent = '⚠ Could not read clipboard. Please paste manually.';
  }
}

async function joinDirectLink() {
  const inputVal = document.getElementById('directLinkInput').value.trim();
  const pinVal = document.getElementById('pinInput').value.trim();
  const errEl = document.getElementById('directLinkErr');
  if (!inputVal) {
    errEl.textContent = 'Please enter a valid URL or Room Code.';
    return;
  }

  // Check if it's a URL
  const isUrl = inputVal.startsWith('http://') || inputVal.startsWith('https://');

  if (isUrl) {
    errEl.style.color = 'var(--muted)';
    errEl.textContent = 'Verifying tunnel...';
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      const pingUrl = inputVal.replace(/\/$/, '') + '/api/info';
      await fetch(pingUrl, { method: 'HEAD', mode: 'no-cors', signal: controller.signal });
      clearTimeout(tid);
      errEl.textContent = '';
      if (window.electronAPI) {
        window.electronAPI.joinSession(inputVal, { game: 'Direct Connect' }, pinVal);
      } else {
        let navUrl = `viewer.html?client=1&compat=1&host=${encodeURIComponent(inputVal)}`;
        if (pinVal) navUrl += `&pin=${encodeURIComponent(pinVal)}`;
        window.location.href = navUrl;
      }
    } catch {
      errEl.style.color = 'var(--danger)';
      errEl.textContent = '⚠ Session unreachable. Make sure the host is online.';
    }
  } else {
    // It's a Room Code
    errEl.textContent = '';
    if (window.electronAPI) {
      window.electronAPI.joinSession(`p2p://${inputVal}`, { game: 'P2P Session' }, pinVal);
    } else {
      let navUrl = `viewer.html?client=1&compat=1&host=${encodeURIComponent('p2p://' + inputVal)}`;
      if (pinVal) navUrl += `&pin=${encodeURIComponent(pinVal)}`;
      window.location.href = navUrl;
    }
  }
}

window.addEventListener('message', (event) => {
  if (event.origin.includes('nearsec.cutefame.net') && event.data?.type === 'JOIN_SESSION') {
    if (window.electronAPI) window.electronAPI.joinSession(event.data.url, { game: event.data.game });
  }
});

const cursor = document.getElementById('virtual-cursor');
let cx = window.innerWidth / 2,
  cy = window.innerHeight / 2;

function updateGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p) continue;
    cursor.style.display = 'block';
    const dx = p.axes[0],
      dy = p.axes[1];
    if (Math.abs(dx) > 0.15) cx += dx * 14;
    if (Math.abs(dy) > 0.15) cy += dy * 14;
    cx = Math.max(0, Math.min(window.innerWidth, cx));
    cy = Math.max(0, Math.min(window.innerHeight, cy));
    cursor.style.left = cx + 'px';
    cursor.style.top = cy + 'px';
    if (p.buttons[0].pressed && !p._wasPressed) {
      cursor.classList.add('clicking');
      const el = document.elementFromPoint(cx, cy);
      if (el && typeof el.click === 'function') el.click();
      p._wasPressed = true;
    } else if (!p.buttons[0].pressed) {
      cursor.classList.remove('clicking');
      p._wasPressed = false;
    }
  }
  requestAnimationFrame(updateGamepad);
}
window.addEventListener('gamepadconnected', () => requestAnimationFrame(updateGamepad));

async function checkFirstRun() {
  // NEW: Client-only flag strips the driver button entirely
  if (window.IS_CLIENT_ONLY || window.Capacitor) {
    const btn = document.getElementById('floating-setup-btn');
    if (btn) btn.style.display = 'none';
    document.body.classList.add('client-only'); // Also hide other host UI
    return;
  }

  if (!window.electronAPI) return;
  const cfg = await window.electronAPI.getSettings();
  const btn = document.getElementById('floating-setup-btn');
  const txt = document.getElementById('setup-btn-text');

  if (cfg.firstRunComplete === true && btn) {
    btn.classList.add('done');
    txt.textContent = 'Drivers Installed';
  }
}

function showSetupToast(msg, isError = false) {
  const toast = document.getElementById('setup-toast');
  toast.textContent = msg;
  toast.className = isError ? 'error show' : 'show';
  setTimeout(() => toast.classList.remove('show'), 4000);
}

async function runInAppSetup() {
  const btn = document.getElementById('floating-setup-btn');
  const txt = document.getElementById('setup-btn-text');
  if (!window.electronAPI) return;

  txt.textContent = 'Installing...';
  btn.style.pointerEvents = 'none';
  btn.style.opacity = '0.7';

  window.electronAPI.runSetup();

  window.electronAPI.onSetupSuccess(() => {
    showSetupToast('✓ Finished! Drivers installed.');
    txt.textContent = 'Drivers Installed';
    btn.classList.add('done');
    btn.style.pointerEvents = 'auto';
    btn.style.opacity = '1';

    appConfig.firstRunComplete = true;
    window.electronAPI.saveSettings(appConfig);
  });

  window.electronAPI.onSetupFailed(() => {
    showSetupToast('✗ Setup failed or was cancelled.', true);
    txt.textContent = 'Install Drivers';
    btn.style.pointerEvents = 'auto';
    btn.style.opacity = '1';
  });
}

window.addEventListener('DOMContentLoaded', () => {
  // Populate language select with fallback options in case i18n.js hasn't run yet
  const langSelect = document.getElementById('langSelect');
  if (langSelect && langSelect.options.length === 0) {
    [
      ['en', 'English'],
      ['es', 'Español'],
      ['fr', 'Français'],
      ['de', 'Deutsch'],
      ['pt', 'Português'],
      ['ja', '日本語'],
      ['ko', '한국어'],
      ['zh', '中文'],
      ['ru', 'Русский'],
    ].forEach(([val, label]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      langSelect.appendChild(opt);
    });
  }

  const savedLang = localStorage.getItem('ns_lang') || navigator.language.split('-')[0] || 'en';
  if (langSelect) langSelect.value = savedLang;

  // Arcade panel iframe: always use the dynamic port and saved language
  const port = _getServerPort();
  const arcadeFrame = document.querySelector('#panel-arcade iframe');
  if (arcadeFrame) {
    arcadeFrame.src = `https://nearsec.cutefame.net/arcade?electron=1&lang=${savedLang}`;
  }

  loadAndSyncSettings();
  checkFirstRun();
});

// ── Auto-Host Logic ────────────────────────────────────────────────────────
let currentGameStatus = { running: false, command: null, tunnelUrl: null, log: '' };

setInterval(() => {
  const urlParams = new URLSearchParams(window.location.search);
  const activePort = urlParams.get('port') || '3000';
  const port = _getServerPort();
  fetch(`http://localhost:${activePort}/api/status`)
    .then((r) => r.json())
    .then((status) => {
      if (status.running !== currentGameStatus.running || status.log !== currentGameStatus.log) {
        currentGameStatus = status;
        renderAutoHosts();
      }
    })
    .catch(() => {});
}, 1000);

function openAutoHostEditor() {
  const editorHtml = `
            <div id="hostEditorModal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); display:flex; justify-content:center; align-items:center; z-index:999999;">
                <div style="background:var(--surface); padding:20px; border-radius:8px; width:600px; max-width:90%; border:1px solid var(--border);">
                    <h3 style="margin-bottom:10px; color:var(--accent);">Edit Auto-Hosts (JSON)</h3>
                    <textarea id="hostEditorText" style="width:100%; height:300px; background:#000; color:#0f0; font-family:monospace; padding:10px; border:1px solid #333;">${JSON.stringify(appConfig.autoHosts || [], null, 2)}</textarea>
                    <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:15px;">
                        <button style="padding: 8px 16px; cursor: pointer; background: transparent; border: 1px solid var(--border); color: #fff; border-radius: 4px;" onclick="document.getElementById('hostEditorModal').remove()">Cancel</button>
                        <button style="padding: 8px 16px; cursor: pointer; background: var(--accent); border: none; color: #000; border-radius: 4px; font-weight: bold;" onclick="saveAutoHostConfig()">Save Changes</button>
                    </div>
                </div>
            </div>
        `;
  document.body.insertAdjacentHTML('beforeend', editorHtml);
}

function saveAutoHostConfig() {
  try {
    const parsed = JSON.parse(document.getElementById('hostEditorText').value);
    appConfig.autoHosts = parsed;
    if (window.electronAPI) window.electronAPI.saveSettings(appConfig);
    syncToNode();
    document.getElementById('hostEditorModal').remove();
    renderAutoHosts();
  } catch (e) {
    alert('Invalid JSON! Check for missing commas or quotes.');
  }
}

function saveAutoHost() {
  const name = document.getElementById('autoName').value.trim();
  const cmd = document.getElementById('autoCmd').value.trim();
  const tunnel = document.getElementById('autoTunnel').value;

  if (!name || !cmd) return;
  if (!appConfig.autoHosts) appConfig.autoHosts = [];
  appConfig.autoHosts.push({ id: Date.now(), name, cmd, tunnel, status: 'offline' });

  if (window.electronAPI) window.electronAPI.saveSettings(appConfig);
  syncToNode();
  renderAutoHosts();
  document.getElementById('autoName').value = '';
  document.getElementById('autoCmd').value = '';
}

function renderAutoHosts() {
  const list = document.getElementById('activeAutoHostsList');
  if (!list) return;

  const hosts = appConfig.autoHosts || [];
  if (hosts.length === 0) {
    list.innerHTML = `<h2>Saved Configurations</h2><div style="padding: 30px; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px;">No containers configured yet.</div>`;
    return;
  }

  let html = `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                        <h2 style="margin:0; border:none; padding:0;">Saved Configurations</h2>
                        <button style="padding:4px 12px; font-size:11px; cursor:pointer; border-radius:4px; background:transparent; border:1px solid var(--border); color:#fff;" onclick="openAutoHostEditor()">Edit JSON</button>
                    </div>`;

  hosts.forEach((h) => {
    const isRunning = currentGameStatus.running && currentGameStatus.command === h.cmd;

    let logDisplay = '';
    if (isRunning) {
      logDisplay = `<div style="margin-top:8px; padding:6px; background:#000; border:1px solid #333; border-radius:4px; font-family:monospace; font-size:10px; color:#eab308;">> Game loop active inside Display :99</div>`;
    } else {
      logDisplay = `<div style="margin-top:8px; padding:6px; background:#000; border:1px solid #222; border-radius:4px; font-family:monospace; font-size:10px; color:#555;">To launch, run: ./bin/headless-host.cmd in a terminal</div>`;
    }

    let activeUrl = '';
    if (isRunning && currentGameStatus.tunnelUrl) {
      const cleanUrl = currentGameStatus.tunnelUrl.replace(/\/$/, '');
      const shareUrl = `${cleanUrl}/?s=${h.id.toString().slice(-4)}`;
      activeUrl = `<div style="font-size:10px; color:#00ff88; margin-top:8px; padding-top:8px; border-top:1px solid #333;">Live Arcade Tunnel: <a href="${shareUrl}" target="_blank" style="color:#00ff88; text-decoration:none;">${shareUrl}</a></div>`;
    }

    const statusDot = isRunning
      ? `<div style="width:10px; height:10px; border-radius:50%; background:#00ff88; box-shadow:0 0 8px #00ff88; animation: pulse 2s infinite; margin-right:10px;"></div>`
      : `<div style="width:10px; height:10px; border-radius:50%; background:#444; margin-right:10px;"></div>`;

    html += `
            <div style="background: var(--surface); border: 1px solid ${isRunning ? 'var(--accent)' : 'var(--border)'}; padding: 16px; border-radius: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
                <div style="overflow: hidden; padding-right: 16px; flex:1;">
                    <div style="display:flex; align-items:center;">
                        ${statusDot}
                        <div style="font-weight: 600; color: ${isRunning ? '#fff' : 'var(--accent)'}; font-size: 14px;">${h.name}</div>
                    </div>
                    <div style="font-size: 11px; color: var(--muted); font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top:6px;">> ${h.cmd}</div>
                    ${logDisplay}
                    ${activeUrl}
                </div>
            </div>`;
  });
  list.innerHTML =
    html + `<style>@keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }</style>`;
}

// Load saved settings on boot
document.addEventListener('DOMContentLoaded', () => {
  // 1. Hide PC-only elements if running on Android / Capacitor
  const isMobile = window.Capacitor || navigator.userAgent.includes('Android');
  if (isMobile) {
    ['floating-setup-btn', 'docsFloatBtn'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.setProperty('display', 'none', 'important');
    });
  }

  if (!window.electronAPI) {
    ['settingRowDiscordRPC', 'settingRowOpenLog', 'settingRowUpdates'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.setProperty('display', 'none', 'important');
    });
  }

  // 2. Restore UI version toggle
  if (localStorage.getItem('ns_ui_version') === 'old') {
    document.getElementById('settingTrackOldUI')?.classList.add('on');
  }

  // 3. Populate language select with fallback options
  const langSelect = document.getElementById('langSelect');
  if (langSelect && langSelect.options.length === 0) {
    [
      ['en', 'English'],
      ['es', 'Español'],
      ['fr', 'Français'],
      ['de', 'Deutsch'],
      ['pt', 'Português'],
      ['ja', '日本語'],
      ['ko', '한국어'],
      ['zh', '中文'],
      ['ru', 'Русский'],
    ].forEach(([val, label]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      langSelect.appendChild(opt);
    });
  }

  const savedLang = localStorage.getItem('ns_lang') || navigator.language.split('-')[0] || 'en';
  if (langSelect) langSelect.value = savedLang;

  // 4. Arcade panel iframe
  const port = _getServerPort();
  const arcadeFrame = document.querySelector('#panel-arcade iframe');
  if (arcadeFrame) {
    arcadeFrame.src = `https://nearsec.cutefame.net/arcade?electron=1&lang=${savedLang}`;
  }

  loadAndSyncSettings();
  checkFirstRun();

  // 5. Auto-start logic
  const params = new URLSearchParams(window.location.search);
  const noAutoHost = params.get('noAutoHost') === '1';

  const autoStartEnabled =
    appConfig.autoStartHost || appConfig.bootToHost || localStorage.getItem('ns_auto_host') === 'true';

  if (autoStartEnabled) {
    document.getElementById('settingTrackAutoHost')?.classList.add('on');
    if (!noAutoHost) {
      setTimeout(launchHostSession, 500);
    }
  }
});

function launchHostSession() {
  // Force direct storage read to prevent race condition with appConfig caching
  let uiVer = localStorage.getItem('ns_ui_version') || 'default';
  // Migrate old setting format if present
  if (uiVer === 'new') uiVer = 'default';
  if (uiVer === 'old') uiVer = 'minimal';

  if (window.electronAPI && window.electronAPI.openHost) {
    window.electronAPI.openHost(uiVer);
  } else {
    const port = _getServerPort();
    let path = '/host';
    if (uiVer === 'minimal') path = '/host-minimal';
    else if (uiVer === 'playground') path = '/host-playground';
    else if (uiVer === 'custom') path = '/host-custom';
    window.location.href = 'http://localhost:' + port + path;
  }
}

// Toggle Functions
function setHostUI(val) {
  if (val === 'custom') {
    document.getElementById('customUIFile').click();
  }
  localStorage.setItem('ns_ui_version', val);
  appConfig.uiVersion = val;
  if (window.electronAPI) window.electronAPI.saveSettings(appConfig);
}

function uploadCustomUI(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  const reader = new FileReader();
  reader.onload = function (e) {
    const content = e.target.result;
    fetch('http://localhost:' + _getServerPort() + '/api/save-custom-host', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: content }),
    })
      .then((res) => {
        if (res.ok) alert('Custom Host UI successfully uploaded!');
        else alert('Failed to save Custom UI');
      })
      .catch((err) => {
        console.error(err);
        alert('Error uploading Custom UI');
      });
  };
  reader.readAsText(file);
  input.value = ''; // Reset so they can re-upload
}

function toggleAutoHost() {
  const track = document.getElementById('settingTrackAutoHost');
  const isAuto = track.classList.toggle('on');
  localStorage.setItem('ns_auto_host', isAuto ? 'true' : 'false');
  // Write to config file so bootToHost is authoritative
  appConfig.bootToHost = isAuto;
  appConfig.autoStartHost = isAuto;
  if (window.electronAPI) window.electronAPI.saveSettings(appConfig);
  const port = _getServerPort();
  fetch('http://localhost:' + port + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootToHost: isAuto }),
  }).catch(() => {});
}

function openAutoHostTerminal() {
  const cmd = document.getElementById('autoCmd').value.trim();
  const name = document.getElementById('autoName').value.trim() || 'Auto-Host';
  if (!cmd) {
    alert('Enter a launch command first.');
    return;
  }
  const port = _getServerPort();
  fetch('http://localhost:' + port + '/api/open-terminal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, name }),
  })
    .then((r) => r.json())
    .then((d) => {
      if (!d.ok) alert('Terminal failed: ' + (d.reason || ''));
    })
    .catch(() => alert('Terminal launch failed.'));
}
(function () {
  const isLinux = navigator.userAgent.includes('Linux') && !navigator.userAgent.includes('Android');
  if (isLinux) {
    const b = document.getElementById('btnOpenTerminal');
    if (b) b.style.display = 'block';
  }
})();

function killGame() {
  if (confirm('Stop the running game?')) {
    const port = _getServerPort();
    fetch(`http://localhost:${port}/api/restart-game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'KILL_ONLY' }),
    });
  }
}

function toggleUIVersion() {
  const current = localStorage.getItem('ns_ui_version') || 'new';
  const next = current === 'new' ? 'old' : 'new';
  localStorage.setItem('ns_ui_version', next);
  alert(`Host UI set to: ${next.toUpperCase()} version. This will apply next time you launch a Host session.`);
}

function openAbout() {
  document.getElementById('aboutModal').style.display = 'flex';
}

function closeAbout() {
  document.getElementById('aboutModal').style.display = 'none';
}

function switchAboutTab(tabId, btnEl) {
  document.querySelectorAll('.ns-about-tab').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.ns-about-section').forEach((el) => el.classList.remove('active'));
  btnEl.classList.add('active');
  document.getElementById('about-tab-' + tabId).classList.add('active');
}

function openDocs() {
  document.getElementById('docsModal').style.display = 'flex';
  loadDoc('GETTING_STARTED.md');
}
function closeDocs() {
  document.getElementById('docsModal').style.display = 'none';
}

function parseMarkdown(raw) {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```[\s\S]*?```/g, (m) => {
      const inner = m.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
      return `<pre style="background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px 14px;overflow-x:auto;font-size:11px;line-height:1.6;margin:8px 0;">${inner}</pre>`;
    })
    .replace(
      /^# (.+)$/gm,
      '<h2 style="color:var(--accent);font-size:16px;font-weight:700;margin:16px 0 6px;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:6px;">$1</h2>'
    )
    .replace(/^## (.+)$/gm, '<h3 style="color:var(--text);font-size:13px;font-weight:600;margin:12px 0 4px;">$1</h3>')
    .replace(
      /^### (.+)$/gm,
      '<h4 style="color:var(--muted);font-size:11px;font-weight:600;margin:10px 0 3px;text-transform:uppercase;letter-spacing:.08em;">$1</h4>'
    )
    .replace(
      /`([^`\n]+)`/g,
      '<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:4px;font-size:11px;font-family:monospace;">$1</code>'
    )
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:12px 0;">')
    .replace(/^[-*] (.+)$/gm, '<li style="margin:3px 0 3px 16px;color:var(--muted);">$1</li>')
    .replace(/\n/g, '<br>');
}

async function loadDoc(filename) {
  const contentDiv = document.getElementById('docContent');
  contentDiv.innerHTML = '<span style="color:var(--muted)">Loading...</span>';

  // Dashboard is loaded as file:// by Electron; build an absolute URL to the
  // express server using the port injected as a query parameter.
  const port = new URLSearchParams(window.location.search).get('port') || '3000';
  const url = `http://localhost:${port}/docs/${filename}`;

  try {
    let raw;
    if (window.electronAPI && window.electronAPI.readDoc) {
      raw = await window.electronAPI.readDoc(filename);
    } else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.text();
    }

    const html = parseMarkdown(raw);
    contentDiv.innerHTML = `<div style="line-height:1.7;font-size:13px;color:var(--muted);">${html}</div>`;
  } catch (e) {
    contentDiv.innerHTML =
      `<span style="color:var(--danger)">Could not load <strong>${filename}</strong> from <code style="font-size:11px;">${url}</code>.<br><br>` +
      `<span style="color:var(--muted);font-size:11px;">Error: ${e.message}</span></span>`;
  }
}

// Handle Fancy Splash Screen
document.addEventListener('DOMContentLoaded', () => {
  const splash = document.getElementById('ns-splash-screen');
  if (sessionStorage.getItem('splashPlayed') === 'true') {
    splash.style.display = 'none';
  } else {
    sessionStorage.setItem('splashPlayed', 'true');
    setTimeout(() => {
      splash.classList.add('fading-out');
      splash.style.opacity = '0';
      setTimeout(() => (splash.style.display = 'none'), 500);
    }, 1800); // Wait for the 2s CSS animation to mostly finish
  }
});
